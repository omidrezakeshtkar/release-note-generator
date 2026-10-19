import { effectiveConfig } from './config.ts';
import { dedupeInputs, parseIssueInput, resolveInputWithRetry, splitInputs, type IResolvedItem } from './issues.ts';
import { GlmApiError, streamChatCompletion } from './glm.ts';
import type { IIssueProvider, ILabelHit } from './provider.ts';
import { buildSystemPrompt, buildUserPrompt, formatReleaseDate, type IContextFile, type IIssueForPrompt } from './prompt.ts';
import {
	bumpVersion,
	compareVersions,
	latestNoteVersion,
	parseVersion,
	versionFromLabels,
	type VersionBumpKind,
} from './version.ts';

export const DEFAULT_RELEASE_LABEL_PREFIX = 'Release v';
export const MAX_ISSUES = 300;
const FETCH_WAVE = 5;

export class PipelineError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PipelineError';
	}
}

export interface IPipelineOptions {
	repo: string;
	provider: IIssueProvider;
	/** Explicit issue/PR refs: `#123`, `123`, or full URLs. */
	inputs: string[];
	/** Release PRs whose referenced issues are pulled in. */
	releasePrs: number[];
	/** Exact labels to select issues/PRs by (union across labels). */
	labels: string[];
	/**
	 * Auto-discovery: select every issue/PR carrying a label that starts with this prefix, grouped
	 * by the version inside the label, keeping the highest version (the current release).
	 * null disables the mode.
	 */
	releaseLabelPrefix: string | null;
	/** Explicit version — wins over label detection and --bump. */
	version: string | null;
	bump: VersionBumpKind | null;
	/** Base version for --bump; falls back to the newest existing note file in `outputDir`. */
	bumpFrom: string | null;
	outputDir: string;
	date: string;
	instructions: string;
	contextFiles: IContextFile[];
	hotfixNumbers: number[];
	hotfixLabel: string | null;
	productNameOverride: string | null;
	onProgress?: (message: string) => void;
	onDelta?: (text: string) => void;
}

export interface IPipelineResult {
	repo: string;
	version: string;
	versionSource: string;
	date: string;
	issues: IIssueForPrompt[];
	failed: IResolvedItem[];
	note: string;
	stats: { characters: number; elapsedMs: number };
}

const collectLabelHits = async (options: IPipelineOptions): Promise<ILabelHit[]> => {
	const { provider, repo, labels, releaseLabelPrefix, onProgress } = options;
	const hits: ILabelHit[] = [];
	if (labels.length > 0) {
		onProgress?.(`Listing issues labeled ${labels.map((label) => `"${label}"`).join(', ')} …`);
		hits.push(...(await provider.listByLabel(repo, labels)));
	}
	if (releaseLabelPrefix !== null) {
		onProgress?.(`Looking for labels starting with "${releaseLabelPrefix}" …`);
		const all = await provider.listByLabel(repo, []);
		hits.push(...all.filter((hit) => hit.labels.some((label) => label.toLowerCase().startsWith(releaseLabelPrefix.toLowerCase()))));
	}
	return hits;
};

/**
 * The newest `Release vX.Y` group among label hits — the current release in auto-discovery mode.
 * Returns the hits plus the version their labels carry.
 */
const newestLabelGroup = (hits: ILabelHit[], prefix: string): { version: string; hits: ILabelHit[] } | null => {
	const groups = new Map<string, ILabelHit[]>();
	for (const hit of hits) {
		const version = versionFromLabels(hit.labels, prefix);
		if (!version) continue;
		const bucket = groups.get(version) ?? [];
		bucket.push(hit);
		groups.set(version, bucket);
	}
	let best: { version: string; hits: ILabelHit[] } | null = null;
	for (const [version, group] of groups) {
		if (!best || compareVersions(parseVersion(version)!, parseVersion(best.version)!) > 0) best = { version, hits: group };
	}
	return best;
};

/** Resolves every seed into a full issue, expanding release PRs' referenced issues as they appear. */
const fetchIssues = async (options: IPipelineOptions, seeds: string[]): Promise<{ issues: IResolvedItem[]; failed: IResolvedItem[] }> => {
	const { provider, repo, onProgress } = options;
	const collected: IResolvedItem[] = [];
	const failed: IResolvedItem[] = [];
	const seen = new Set<string>();
	const queue: string[] = [];
	const enqueue = (ref: string): void => {
		const parsed = parseIssueInput(ref);
		const key = parsed ? `${parsed.kind}:${parsed.number}` : ref;
		if (!seen.has(key)) {
			seen.add(key);
			queue.push(parsed ? `#${parsed.number}` : ref);
		}
	};
	for (const seed of seeds) enqueue(seed);

	let done = 0;
	while (queue.length > 0 && collected.length + failed.length < MAX_ISSUES) {
		const wave = queue.splice(0, FETCH_WAVE);
		const results = await Promise.all(wave.map((ref) => resolveInputWithRetry(repo, ref, provider)));
		for (const item of results) {
			done += 1;
			if (!item.ok) {
				failed.push(item);
				continue;
			}
			if (item.kind === 'issue' && item.issue) {
				collected.push(item);
			} else if (item.referencedIssueNumbers) {
				// release PR: kept out of the note body, its referenced issues join the queue
				onProgress?.(`PR #${item.number} references ${item.referencedIssueNumbers.length} issue(s) — expanding …`);
				for (const number of item.referencedIssueNumbers) enqueue(`#${number}`);
			}
		}
		onProgress?.(`Fetched ${done}/${done + queue.length} …`);
	}
	return { issues: collected, failed };
};

export const runPipeline = async (options: IPipelineOptions): Promise<IPipelineResult> => {
	const started = Date.now();
	const { provider, repo } = options;
	if (!repo.includes('/') && !/^\d+$/.test(repo)) {
		throw new PipelineError(`Repository must be owner/name (or a full URL) — got "${repo}".`);
	}

	// ---- select ----
	const seeds: string[] = [...dedupeInputs(splitInputs(options.inputs.join('\n')))];
	for (const number of options.releasePrs) seeds.push(`#${number}`);

	const hits = await collectLabelHits(options);
	if (options.releaseLabelPrefix !== null) {
		const group = newestLabelGroup(hits, options.releaseLabelPrefix);
		if (!group) {
			throw new PipelineError(
				`No issue carries a label starting with "${options.releaseLabelPrefix}" — tag the release's issues (e.g. "${DEFAULT_RELEASE_LABEL_PREFIX}1.19") or use --label/--issue.`,
			);
		}
		for (const hit of group.hits) seeds.push(`#${hit.number}`);
	} else {
		for (const hit of hits) seeds.push(`#${hit.number}`);
	}
	if (seeds.length === 0) {
		throw new PipelineError('Nothing selected — pass issue refs, --label, or --release-label-prefix.');
	}

	// ---- fetch ----
	options.onProgress?.(`Fetching ${seeds.length} reference(s) from ${repo} via ${provider.name} …`);
	const { issues: resolved, failed } = await fetchIssues(options, seeds);
	if (resolved.length === 0) {
		const detail = failed.length > 0 ? ` All ${failed.length} reference(s) failed — first: ${failed[0].error}` : '';
		throw new PipelineError(`No issues could be fetched.${detail}`);
	}
	resolved.sort((a, b) => a.number - b.number);

	// ---- hotfix marking ----
	const hotfixNumbers = new Set(options.hotfixNumbers);
	const pickedIssues: IIssueForPrompt[] = resolved.map((item) => ({
		number: item.issue!.number,
		title: item.issue!.title,
		labels: item.issue!.labels,
		body: item.issue!.body,
		comments: item.issue!.comments.map((comment) => ({ author: comment.author, body: comment.body })),
		isHotfix:
			hotfixNumbers.has(item.issue!.number)
			|| (options.hotfixLabel !== null && item.issue!.labels.some((label) => label.toLowerCase() === options.hotfixLabel!.toLowerCase())),
	}));

	// ---- version: explicit > release label on the selected issues > --bump ----
	let version = options.version?.trim() ?? '';
	let versionSource = 'explicit';
	const prefix = options.releaseLabelPrefix ?? DEFAULT_RELEASE_LABEL_PREFIX;
	if (!version) {
		// the highest `<prefix><semver>` label across the selected issues; in prefix mode the
		// selection is already narrowed to the newest group, so this yields exactly that version
		version = versionFromLabels(pickedIssues.flatMap((issue) => issue.labels), prefix) ?? '';
		if (version) versionSource = `label "${prefix}…"`;
	}
	if (!version && options.bump) {
		const base = options.bumpFrom?.trim() || latestNoteVersion(options.outputDir);
		const parsed = base ? parseVersion(base) : null;
		if (!parsed) {
			throw new PipelineError(
				`--bump needs a base version: pass --from <version>, or generate a previous note into ${options.outputDir} first.`,
			);
		}
		version = bumpVersion(parsed, options.bump);
		versionSource = `bump ${options.bump} from ${base}`;
	}
	if (!version) {
		throw new PipelineError(
			`No version determined — tag the issues (e.g. "${DEFAULT_RELEASE_LABEL_PREFIX}1.19"), or pass --version, or --bump minor|patch|major.`,
		);
	}

	// ---- generate ----
	const config = effectiveConfig();
	options.onProgress?.(`Generating the note for v${version} from ${pickedIssues.length} issue(s) via ${config.glmModel} …`);
	const note = await streamChatCompletion({
		baseUrl: config.glmBaseUrl,
		apiKey: config.glmApiKey,
		model: config.glmModel,
		messages: [
			{ role: 'system', content: buildSystemPrompt(options.productNameOverride ?? undefined) },
			{
				role: 'user',
				content: buildUserPrompt({
					version,
					releaseDate: formatReleaseDate(options.date),
					issues: pickedIssues,
					contextFiles: options.contextFiles,
					instructions: options.instructions,
				}),
			},
		],
		onDelta: options.onDelta ?? (() => {}),
	}).catch((err: unknown) => {
		if (err instanceof GlmApiError) throw new PipelineError(err.message);
		throw err;
	});

	if (!note.trim()) {
		throw new PipelineError('The model returned an empty note.');
	}

	return {
		repo,
		version,
		versionSource,
		date: options.date,
		issues: pickedIssues,
		failed,
		note,
		stats: { characters: note.length, elapsedMs: Date.now() - started },
	};
};
