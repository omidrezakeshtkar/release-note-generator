import type { IGhIssue, IGhPullRequest, IGhRepo } from './gh.ts';
import { buildUrl, collectPages, restGetJson } from './rest.ts';
import { gitlabToken, type IIssueProvider, type ILabelHit } from './provider.ts';

/**
 * GitLab over REST v4 with a token from the environment (GITLAB_TOKEN — a project or personal
 * access token with `read_api`; the ephemeral CI_JOB_TOKEN cannot read the issues API). This is
 * the provider for GitLab CI: the job auto-detects `CI_PROJECT_PATH` as the repo.
 * `GITLAB_API_URL` / `CI_SERVER_HOST` / `GITLAB_HOST` override the endpoint.
 */

const LIST_LIMIT = 500;
const COMMENTS_PER_ITEM = 8;

const apiBase = (): string => {
	const explicit = (process.env.GITLAB_API_URL ?? '').trim();
	if (explicit) return explicit.replace(/\/+$/, '');
	const host = (process.env.CI_SERVER_HOST ?? process.env.GITLAB_HOST ?? 'gitlab.com').trim();
	return `https://${host}/api/v4`;
};

const requireToken = (): string => {
	const token = gitlabToken();
	if (!token) {
		throw new Error(
			'No GitLab token — set GITLAB_TOKEN to a project access token with `read_api` scope (CI_JOB_TOKEN cannot read the issues API).',
		);
	}
	return token;
};

const glHeaders = (): Record<string, string> => ({ 'PRIVATE-TOKEN': requireToken() });

/** `group/project` → `group%2Fproject`; a numeric project ID passes through untouched. */
const projectRef = (repo: string): string => {
	const trimmed = repo.trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/\.git$/i, '').replace(/\/-$/, '');
	return /^\d+$/.test(trimmed) ? trimmed : encodeURIComponent(trimmed);
};

interface IRestUser {
	username?: string;
}

interface IRestNote {
	system?: boolean;
	author?: IRestUser | null;
	body?: string | null;
	created_at?: string | null;
}

interface IRestGitLabIssue {
	iid?: number;
	title?: string;
	description?: string | null;
	state?: string;
	web_url?: string;
	labels?: Array<string>;
	author?: IRestUser | null;
}

interface IRestProject {
	path_with_namespace?: string;
	visibility?: string;
	default_branch?: string | null;
	permissions?: {
		project_access?: { access_level?: number } | null;
		group_access?: { access_level?: number } | null;
	};
}

const ACCESS_LEVELS: Array<{ min: number; name: string }> = [
	{ min: 50, name: 'owner' },
	{ min: 40, name: 'maintainer' },
	{ min: 30, name: 'developer' },
	{ min: 20, name: 'reporter' },
	{ min: 10, name: 'guest' },
];

const mapComments = (notes: IRestNote[] | null | undefined) =>
	(notes ?? [])
		.filter((note) => note.system !== true && (note.body ?? '').trim())
		.slice(0, COMMENTS_PER_ITEM)
		.map((note) => ({
			author: note.author?.username ?? null,
			body: note.body ?? '',
			createdAt: note.created_at ?? null,
		}));

const collectNotes = async (path: string): Promise<IRestNote[]> =>
	collectPages<IRestNote>((page) => restGetJson(buildUrl(apiBase(), path, { sort: 'asc', per_page: 100, page }), glHeaders()) as Promise<IRestNote[]>, 200);

export const createGitLabApiProvider = (): IIssueProvider => ({
	name: 'gitlab-api',
	describe: async () => `GitLab API (${(process.env.CI_SERVER_HOST ?? process.env.GITLAB_HOST ?? 'gitlab.com').trim()})`,
	checkAuth: async () => {
		try {
			const user = (await restGetJson(buildUrl(apiBase(), '/user'), glHeaders())) as IRestUser;
			return user?.username ?? null;
		} catch {
			return null;
		}
	},
	viewRepo: async (repo) => {
		const raw = (await restGetJson(buildUrl(apiBase(), `/projects/${projectRef(repo)}`), glHeaders())) as IRestProject;
		const level = raw.permissions?.project_access?.access_level ?? raw.permissions?.group_access?.access_level ?? 0;
		return {
			nameWithOwner: raw.path_with_namespace ?? repo,
			viewerPermission: ACCESS_LEVELS.find((entry) => level >= entry.min)?.name ?? 'none',
			isPrivate: raw.visibility !== 'public',
			defaultBranch: raw.default_branch ?? null,
		};
	},
	viewIssue: async (repo, number) => {
		const base = `/projects/${projectRef(repo)}/issues/${number}`;
		const raw = (await restGetJson(buildUrl(apiBase(), base), glHeaders())) as IRestGitLabIssue;
		return {
			number: raw.iid ?? number,
			title: raw.title ?? '',
			body: raw.description ?? '',
			state: raw.state ?? '',
			url: raw.web_url ?? '',
			labels: raw.labels ?? [],
			author: raw.author?.username ?? null,
			comments: mapComments(await collectNotes(`${base}/notes`)),
		};
	},
	viewPullRequest: async (repo, number) => {
		const base = `/projects/${projectRef(repo)}/merge_requests/${number}`;
		const raw = (await restGetJson(buildUrl(apiBase(), base), glHeaders())) as IRestGitLabIssue;
		return {
			number: raw.iid ?? number,
			title: raw.title ?? '',
			body: raw.description ?? '',
			state: raw.state ?? '',
			url: raw.web_url ?? '',
			labels: raw.labels ?? [],
			comments: mapComments(await collectNotes(`${base}/notes`)).map((comment) => ({
				author: comment.author,
				body: comment.body,
			})),
		};
	},
	listByLabel: async (repo, labels) => {
		const project = projectRef(repo);
		const query = { labels: labels.join(','), state: 'all', per_page: 100 };
		const [issues, merges] = await Promise.all([
			collectPages<IRestGitLabIssue>(
				(page) => restGetJson(buildUrl(apiBase(), `/projects/${project}/issues`, { ...query, page }), glHeaders()) as Promise<IRestGitLabIssue[]>,
				LIST_LIMIT,
			),
			collectPages<IRestGitLabIssue>(
				(page) => restGetJson(buildUrl(apiBase(), `/projects/${project}/merge_requests`, { ...query, page }), glHeaders()) as Promise<IRestGitLabIssue[]>,
				LIST_LIMIT,
			),
		]);
		const toHit = (kind: 'issue' | 'pull') => (item: IRestGitLabIssue): ILabelHit => ({
			number: item.iid ?? 0,
			kind,
			title: item.title ?? '',
			labels: item.labels ?? [],
			state: item.state ?? '',
		});
		return [...issues.map(toHit('issue')), ...merges.map(toHit('pull'))].filter((hit) => hit.number > 0);
	},
});
