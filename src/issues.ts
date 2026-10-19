import {
	extractIssueRefs,
	GhError,
	type IGhIssue,
} from './gh.ts';
import { ghCliProvider, type IIssueProvider } from './provider.ts';

export interface IParsedInput {
	kind: 'issue' | 'pull';
	number: number;
	repoHint: string | null;
}

export interface IResolvedItem {
	input: string;
	kind: 'issue' | 'pull';
	number: number;
	ok: boolean;
	error?: string;
	/** Present when kind === 'issue' and the fetch succeeded. */
	issue?: IGhIssue;
	/** Present when kind === 'pull' (release PRs are kept out of the note body but can be expanded). */
	title?: string;
	url?: string;
	state?: string;
	labels?: string[];
	/** Issue numbers referenced by a PR body — the client offers one-click expansion for these. */
	referencedIssueNumbers?: number[];
}

/**
 * Issue/PR URL shapes: GitHub (`/issues/123`, `/pull/45`), gitlab.com and self-hosted GitLab
 * (`/-/issues/123`, `/-/merge_requests/45`). The first pattern covers the known hosts without a
 * scheme; the second accepts any host when a real URL scheme is present (self-hosted GitLab).
 */
const RE_KNOWN_HOST_URL = /(?:github|gitlab)\.com\/([\w.-]+)\/([\w.-]+)\/(?:-\/)?(issues|pull|merge_requests)\/(\d+)/i;
const RE_ANY_HOST_URL = /https?:\/\/[\w.-]+\/([\w.-]+)\/([\w.-]+)\/(?:-\/)?(issues|pull|merge_requests)\/(\d+)/i;
const RE_BARE = /^#?(\d+)$/;

export const parseIssueInput = (raw: string): IParsedInput | null => {
	const text = raw.trim();
	if (!text) return null;
	const urlMatch = text.match(RE_KNOWN_HOST_URL) ?? text.match(RE_ANY_HOST_URL);
	if (urlMatch) {
		return {
			kind: /pull|merge_requests/i.test(urlMatch[3]) ? 'pull' : 'issue',
			number: Number(urlMatch[4]),
			repoHint: `${urlMatch[1]}/${urlMatch[2]}`,
		};
	}
	const bareMatch = text.match(RE_BARE);
	if (bareMatch) return { kind: 'issue', number: Number(bareMatch[1]), repoHint: null };
	return null;
};

const asPullItem = (input: string, pr: {
	number: number;
	title: string;
	body: string;
	state: string;
	url: string;
	labels: string[];
	comments: Array<{ author: string | null; body: string }>;
}): IResolvedItem => ({
	input,
	kind: 'pull',
	number: pr.number,
	ok: true,
	title: pr.title,
	url: pr.url,
	state: pr.state,
	labels: pr.labels,
	// The release bot's full issue list lives in a PR comment, not the body — scan both.
	referencedIssueNumbers: extractIssueRefs(
		[pr.body, ...pr.comments.map((comment) => comment.body)],
		[pr.number],
	),
});

const asFailure = (input: string, kind: 'issue' | 'pull', number: number, err: unknown): IResolvedItem => ({
	input,
	kind,
	number,
	ok: false,
	error: err instanceof Error ? err.message : String(err),
});

export const resolveInput = async (repo: string, raw: string, provider: IIssueProvider = ghCliProvider): Promise<IResolvedItem> => {
	const parsed = parseIssueInput(raw);
	if (!parsed) {
		return asFailure(raw, 'issue', 0, 'Not a GitHub/GitLab issue link or a bare number.');
	}
	if (parsed.kind === 'pull') {
		try {
			return asPullItem(raw, await provider.viewPullRequest(repo, parsed.number));
		} catch (err) {
			return asFailure(raw, 'pull', parsed.number, describeGhFailure(err));
		}
	}
	try {
		return { input: raw, kind: 'issue', number: parsed.number, ok: true, issue: await provider.viewIssue(repo, parsed.number) };
	} catch (issueErr) {
		// A bare number can belong to a PR — the issue endpoint refuses those.
		if (!raw.includes('/')) {
			try {
				return asPullItem(raw, await provider.viewPullRequest(repo, parsed.number));
			} catch {
				// fall through to the original issue error
			}
		}
		return asFailure(raw, 'issue', parsed.number, describeGhFailure(issueErr));
	}
};

const describeGhFailure = (err: unknown): string => {
	if (err instanceof GhError && err.stderrSummary) return `${err.message}: ${err.stderrSummary}`;
	return err instanceof Error ? err.message : String(err);
};

const CONCURRENCY = 5;
/** gh occasionally hiccups (network, secondary rate limits) — a failed fetch is retried, not reported dead. */
export const FETCH_RETRIES = 2;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const resolveInputWithRetry = async (repo: string, raw: string, provider: IIssueProvider = ghCliProvider): Promise<IResolvedItem> => {
	let last: IResolvedItem | null = null;
	for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
		const result = await resolveInput(repo, raw, provider);
		// Parse failures (number 0) are deterministic — never retried.
		if (result.ok || result.number === 0) return result;
		last = result;
		if (attempt < FETCH_RETRIES) await sleep(600 * 2 ** attempt);
	}
	return last as IResolvedItem;
};

export const resolveAll = async (repo: string, inputs: string[], provider: IIssueProvider = ghCliProvider): Promise<IResolvedItem[]> => {
	const results: IResolvedItem[] = new Array(inputs.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < inputs.length) {
			const index = cursor++;
			results[index] = await resolveInputWithRetry(repo, inputs[index], provider);
		}
	};
	const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, inputs.length)) }, worker);
	await Promise.all(workers);
	return results;
};

/** Keeps the first occurrence of each issue/PR, preserving the user's order. */
export const dedupeInputs = (inputs: string[]): string[] => {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const input of inputs) {
		const parsed = parseIssueInput(input);
		if (!parsed) {
			kept.push(input);
			continue;
		}
		const key = `${parsed.kind}:${parsed.number}`;
		if (!seen.has(key)) {
			seen.add(key);
			kept.push(input);
		}
	}
	return kept;
};

export const splitInputs = (blob: string): string[] =>
	blob
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean);
