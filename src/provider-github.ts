import type { IGhIssue, IGhPullRequest, IGhRepo } from './gh.ts';
import { buildUrl, collectPages, restGetJson } from './rest.ts';
import { githubToken, type IIssueProvider, type ILabelHit } from './provider.ts';

/**
 * GitHub over the REST API with a token from the environment (GH_TOKEN / GITHUB_TOKEN). This is
 * the provider for CI: a GitHub Actions job supplies the repo's own `GITHUB_TOKEN` and needs no
 * gh login. `GITHUB_API_URL` overrides the endpoint (GitHub Enterprise Server).
 */

const API_ROOT = 'https://api.github.com';
const LIST_LIMIT = 500;
const COMMENTS_PER_ITEM = 8;

const apiBase = (): string => (process.env.GITHUB_API_URL ?? API_ROOT).trim().replace(/\/+$/, '');

const requireToken = (): string => {
	const token = githubToken();
	if (!token) {
		throw new Error(
			'No GitHub token — set GH_TOKEN (or GITHUB_TOKEN). In GitHub Actions add `env: GH_TOKEN: ${{ github.token }}` and `permissions: issues: read`.',
		);
	}
	return token;
};

const ghHeaders = (): Record<string, string> => ({
	Authorization: `Bearer ${requireToken()}`,
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2022-11-28',
	'User-Agent': 'release-note-generator',
});

interface IRestUser {
	login?: string;
}

interface IRestLabel {
	name?: string;
}

interface IRestComment {
	user?: IUserOrBot | null;
	body?: string | null;
	created_at?: string | null;
}

interface IUserOrBot {
	login?: string;
	type?: string;
}

interface IRestIssue {
	number: number;
	title?: string;
	body?: string | null;
	state?: string;
	html_url?: string;
	labels?: IRestLabel[];
	user?: IRestUser | null;
	comments?: Array<IRestComment>;
	pull_request?: unknown;
}

interface IRestRepo {
	full_name?: string;
	private?: boolean;
	default_branch?: string | null;
	permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
}

const mapComments = (comments: IRestComment[] | undefined | null) =>
	(comments ?? []).slice(0, COMMENTS_PER_ITEM).map((comment) => ({
		author: comment.user?.login ?? null,
		body: comment.body ?? '',
		createdAt: comment.created_at ?? null,
	}));

const splitRepo = (repo: string): string => repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');

const issueComments = async (owner: string, name: string, number: number) =>
	(await restGetJson(
		buildUrl(apiBase(), `/repos/${owner}/${name}/issues/${number}/comments`, { per_page: 100 }),
		ghHeaders(),
	)) as IRestComment[] | null;

export const createGitHubApiProvider = (): IIssueProvider => ({
	name: 'github-api',
	describe: async function () {
		const login = await this.checkAuth();
		return login ? `GitHub API (@${login})` : 'GitHub API (token only, no user scope)';
	},
	checkAuth: async () => {
		try {
			const user = (await restGetJson(buildUrl(apiBase(), '/user'), ghHeaders())) as IRestUser;
			return user?.login ?? null;
		} catch {
			return null;
		}
	},
	viewRepo: async (repo) => {
		const [owner, name] = splitRepo(repo).split('/');
		const raw = (await restGetJson(buildUrl(apiBase(), `/repos/${owner}/${name}`), ghHeaders())) as IRestRepo;
		const permission = raw.permissions?.admin ? 'admin' : raw.permissions?.push ? 'write' : raw.permissions?.pull ? 'read' : 'none';
		return {
			nameWithOwner: raw.full_name ?? `${owner}/${name}`,
			viewerPermission: permission,
			isPrivate: raw.private === true,
			defaultBranch: raw.default_branch ?? null,
		};
	},
	viewIssue: async (repo, number) => {
		const [owner, name] = splitRepo(repo).split('/');
		const raw = (await restGetJson(
			buildUrl(apiBase(), `/repos/${owner}/${name}/issues/${number}`),
			ghHeaders(),
		)) as IRestIssue;
		// GitHub's issues endpoint also returns pull requests — refuse them so bare numbers fall
		// through to the PR path instead of silently losing the release-PR expansion.
		if (raw.pull_request) {
			throw new Error(`#${number} is a pull request, not an issue.`);
		}
		return {
			number: raw.number,
			title: raw.title ?? '',
			body: raw.body ?? '',
			state: raw.state ?? '',
			url: raw.html_url ?? '',
			labels: (raw.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
			author: raw.user?.login ?? null,
			comments: mapComments(await issueComments(owner, name, number)),
		};
	},
	viewPullRequest: async (repo, number) => {
		const [owner, name] = splitRepo(repo).split('/');
		const raw = (await restGetJson(
			buildUrl(apiBase(), `/repos/${owner}/${name}/pulls/${number}`),
			ghHeaders(),
		)) as IRestPull;
		// labels and conversation comments (incl. the release bot's issue list) live on the issue
		const [asIssue, comments] = await Promise.all([
			restGetJson(buildUrl(apiBase(), `/repos/${owner}/${name}/issues/${number}`), ghHeaders()) as Promise<IRestIssue>,
			issueComments(owner, name, number),
		]);
		return {
			number: raw.number,
			title: raw.title ?? '',
			body: raw.body ?? '',
			state: raw.state ?? '',
			url: raw.html_url ?? '',
			labels: (asIssue.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
			comments: mapComments(comments).map((comment) => ({ author: comment.author, body: comment.body })),
		};
	},
	listByLabel: async (repo, labels) => {
		const [owner, name] = splitRepo(repo).split('/');
		const items = await collectPages<IRestIssue>(
			(page) =>
				restGetJson(
					buildUrl(
						apiBase(),
						`/repos/${owner}/${name}/issues`,
						{ labels: labels.join(','), state: 'all', per_page: 100, page },
					),
					ghHeaders(),
				) as Promise<IRestIssue[]>,
			LIST_LIMIT,
		);
		return items.map((item) => ({
			number: item.number,
			kind: item.pull_request ? ('pull' as const) : ('issue' as const),
			title: item.title ?? '',
			labels: (item.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
			state: item.state ?? '',
		}));
	},
});

interface IRestPull {
	number: number;
	title?: string;
	body?: string | null;
	state?: string;
	html_url?: string;
}
