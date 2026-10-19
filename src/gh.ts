import { spawn } from 'node:child_process';

const GH_TIMEOUT_MS = 30_000;

export class GhError extends Error {
	readonly stderrSummary: string;

	constructor(message: string, stderrSummary: string) {
		super(message);
		this.name = 'GhError';
		this.stderrSummary = stderrSummary;
	}
}

export interface IGhIssueComment {
	author: string | null;
	body: string;
	createdAt: string | null;
}

export interface IGhIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	url: string;
	labels: string[];
	author: string | null;
	comments: IGhIssueComment[];
}

export interface IGhPullRequest {
	number: number;
	title: string;
	body: string;
	state: string;
	url: string;
	labels: string[];
	comments: Array<{ author: string | null; body: string }>;
}

export interface IGhRepo {
	nameWithOwner: string;
	viewerPermission: string;
	isPrivate: boolean;
	defaultBranch: string | null;
}

const summarizeStderr = (stderr: string): string => {
	const lines = stderr
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.slice(0, 3).join(' — ').slice(0, 400);
};

export const runGh = (args: string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), GH_TIMEOUT_MS);

		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			const hint = (err as NodeJS.ErrnoException).code === 'ENOENT' ? ' — is the gh CLI installed and on PATH?' : '';
			reject(new GhError(`Failed to run gh: ${err.message}${hint}`, ''));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new GhError(`gh ${args[0]} exited with code ${code}`, summarizeStderr(stderr)));
			}
		});
	});

/** Returns the login of the active gh account, or null when gh is missing/unauthenticated. */
export const checkAuth = async (): Promise<string | null> => {
	try {
		const out = await runGh(['api', 'user', '--jq', '.login']);
		return out.trim() || null;
	} catch {
		return null;
	}
};

export const viewRepo = async (repo: string): Promise<IGhRepo> => {
	const out = await runGh([
		'repo',
		'view',
		repo,
		'--json',
		'nameWithOwner,viewerPermission,isPrivate,defaultBranchRef',
	]);
	const raw = JSON.parse(out) as {
		nameWithOwner: string;
		viewerPermission: string;
		isPrivate: boolean;
		defaultBranchRef: { name: string } | null;
	};
	return {
		nameWithOwner: raw.nameWithOwner,
		viewerPermission: raw.viewerPermission,
		isPrivate: raw.isPrivate,
		defaultBranch: raw.defaultBranchRef?.name ?? null,
	};
};

interface IRawIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	url: string;
	labels: Array<{ name: string }>;
	author: { login: string } | null;
	comments: Array<{ author: { login: string } | null; body: string; createdAt: string | null }> | null;
}

export const viewIssue = async (repo: string, number: number): Promise<IGhIssue> => {
	const out = await runGh([
		'issue',
		'view',
		String(number),
		'-R',
		repo,
		'--json',
		'number,title,body,state,url,labels,author,comments',
	]);
	const raw = JSON.parse(out) as IRawIssue;
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? '',
		state: raw.state,
		url: raw.url,
		labels: raw.labels.map((label) => label.name),
		author: raw.author?.login ?? null,
		comments: (raw.comments ?? []).map((comment) => ({
			author: comment.author?.login ?? null,
			body: comment.body,
			createdAt: comment.createdAt ?? null,
		})),
	};
};

export const viewPullRequest = async (repo: string, number: number): Promise<IGhPullRequest> => {
	const out = await runGh([
		'pr',
		'view',
		String(number),
		'-R',
		repo,
		'--json',
		'number,title,body,state,url,labels,comments',
	]);
	const raw = JSON.parse(out) as {
		number: number;
		title: string;
		body: string | null;
		state: string;
		url: string;
		labels: Array<{ name: string }>;
		comments: Array<{ author: { login: string } | null; body: string }> | null;
	};
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? '',
		state: raw.state,
		url: raw.url,
		labels: raw.labels.map((label) => label.name),
		comments: (raw.comments ?? []).map((comment) => ({
			author: comment.author?.login ?? null,
			body: comment.body,
		})),
	};
};

/**
 * Extracts issue references from PR/release text: `#123` shorthands and full
 * `/issues/123` URLs on GitHub or GitLab (`/-/issues/123`) — the release bot's
 * "📋 Issues for this release" comment uses URLs.
 * `&#123;`-style HTML entities are excluded via lookbehind; headings never match
 * because they require a space after `#`.
 */
export const extractIssueRefs = (texts: string[], exclude: number[] = []): number[] => {
	const refs = new Set<number>();
	for (const text of texts) {
		for (const match of text.matchAll(/(?<![\w&])#(\d+)\b/g)) {
			refs.add(Number(match[1]));
		}
		for (const match of text.matchAll(/(?:github|gitlab)\.com\/[\w.-]+\/[\w.-]+\/(?:-\/)?issues\/(\d+)/gi)) {
			refs.add(Number(match[1]));
		}
		// self-hosted GitLab: any host, but only with a real URL scheme to avoid false positives
		for (const match of text.matchAll(/https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/(?:-\/)?issues\/(\d+)/gi)) {
			refs.add(Number(match[1]));
		}
	}
	return [...refs].filter((n) => !exclude.includes(n)).sort((a, b) => a - b);
};
