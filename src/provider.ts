import {
	checkAuth as ghCheckAuth,
	runGh,
	viewIssue as ghViewIssue,
	viewPullRequest as ghViewPullRequest,
	viewRepo as ghViewRepo,
	type IGhIssue,
	type IGhPullRequest,
	type IGhRepo,
} from './gh.ts';
import { createGitHubApiProvider } from './provider-github.ts';
import { createGitLabApiProvider } from './provider-gitlab.ts';

export type ProviderName = 'gh-cli' | 'github-api' | 'gitlab-api';

export interface ILabelHit {
	number: number;
	kind: 'issue' | 'pull';
	title: string;
	labels: string[];
	state: string;
}

/**
 * One issue source behind the tool. The web UI always uses the gh CLI (local, interactive);
 * headless runs — CLI in a terminal, GitHub Actions, GitLab CI — may pick a token-based REST
 * provider so the job only needs the repo's own token, no local gh login.
 */
export interface IIssueProvider {
	readonly name: ProviderName;
	/** One-line description of the active backend for progress output, e.g. `GitHub API (token for @user)`. */
	describe(): Promise<string>;
	checkAuth(): Promise<string | null>;
	viewRepo(repo: string): Promise<IGhRepo>;
	viewIssue(repo: string, number: number): Promise<IGhIssue>;
	viewPullRequest(repo: string, number: number): Promise<IGhPullRequest>;
	/**
	 * Issues and pull requests carrying ALL of the given labels; an empty list means everything
	 * (capped). Powers `--label` selection and the `--release-label-prefix` auto-discovery.
	 */
	listByLabel(repo: string, labels: string[]): Promise<ILabelHit[]>;
}

/** The web UI's fixed backend: whatever account `gh auth login` knows. */
export const ghCliProvider: IIssueProvider = {
	name: 'gh-cli',
	describe: async () => {
		const login = await ghCheckAuth();
		return login ? `gh CLI (@${login})` : 'gh CLI (not authenticated)';
	},
	checkAuth: ghCheckAuth,
	viewRepo: ghViewRepo,
	viewIssue: ghViewIssue,
	viewPullRequest: ghViewPullRequest,
	listByLabel: async (repo, labels) => {
		// `gh issue list` refuses PRs and vice versa — list both and merge.
		const args = ['--repo', repo, '--state', 'all', '--limit', '500', '--json', 'number,title,labels,state'];
		const [issues, pulls] = await Promise.all([
			runGhJson(['issue', 'list', ...(labels.length > 0 ? ['--label', labels.join(',')] : []), ...args]),
			runGhJson(['pr', 'list', ...(labels.length > 0 ? ['--label', labels.join(',')] : []), ...args]),
		]);
		return [...mapGhList(issues, 'issue'), ...mapGhList(pulls, 'pull')];
	},
};

interface IGhListItem {
	number: number;
	title: string;
	labels: Array<{ name: string }>;
	state: string;
}

const runGhJson = async (args: string[]): Promise<IGhListItem[]> => {
	const out = await runGh(args);
	return JSON.parse(out) as IGhListItem[];
};

const mapGhList = (items: IGhListItem[], kind: 'issue' | 'pull'): ILabelHit[] =>
	items.map((item) => ({
		number: item.number,
		kind,
		title: item.title,
		labels: item.labels.map((label) => label.name),
		state: item.state,
	}));

export const isProviderName = (value: string | undefined | null): value is ProviderName =>
	value === 'gh-cli' || value === 'github-api' || value === 'gitlab-api';

export const githubToken = (): string => (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();
export const gitlabToken = (): string => (process.env.GITLAB_TOKEN ?? process.env.GL_TOKEN ?? '').trim();

/**
 * CI-first auto-detection: GitLab CI (`GITLAB_CI` + `CI_PROJECT_PATH`) and GitHub Actions
 * (`GITHUB_ACTIONS` + token) are recognized from their own env; anything else falls back to the
 * gh CLI. A stray token on a laptop never silently flips the backend.
 */
export const detectProviderName = (): ProviderName => {
	const explicit = (process.env.RELEASE_NOTE_PROVIDER ?? '').trim();
	if (isProviderName(explicit)) return explicit;
	if (process.env.GITLAB_CI === 'true' && gitlabToken()) return 'gitlab-api';
	if (process.env.GITHUB_ACTIONS === 'true' && githubToken()) return 'github-api';
	return 'gh-cli';
};

export const resolveProvider = (explicit?: string): IIssueProvider => {
	const name = (explicit ?? '').trim() || detectProviderName();
	if (!isProviderName(name)) {
		throw new Error(`Unknown provider "${name}" — use gh-cli, github-api, or gitlab-api.`);
	}
	if (name === 'github-api') return createGitHubApiProvider();
	if (name === 'gitlab-api') return createGitLabApiProvider();
	return ghCliProvider;
};

/** `--repo` unset → CI's own repo → config defaultRepo. Returns null when nothing applies. */
export const resolveDefaultRepo = (): string | null => {
	if (process.env.CI_PROJECT_PATH?.trim()) return process.env.CI_PROJECT_PATH.trim();
	if (process.env.GITHUB_REPOSITORY?.trim()) return process.env.GITHUB_REPOSITORY.trim();
	return null;
};
