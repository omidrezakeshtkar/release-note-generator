import { effectiveConfig } from './config.ts';
import { streamChatCompletion } from './glm.ts';
import { resolveInputWithRetry, sleep } from './issues.ts';
import { buildSystemPrompt, buildUserPrompt, formatReleaseDate, type IIssueForPrompt } from './prompt.ts';
import {
	appendIssue,
	loadRelease,
	releaseExists,
	saveRelease,
	type IRelease,
	type IStoredIssue,
} from './store.ts';

export interface IJobSnapshot {
	kind: 'fetch' | 'generate';
	phase: string;
	done: number;
	total: number;
	characters: number;
	elapsedMs: number;
}

interface IActiveJob {
	kind: 'fetch' | 'generate';
	controller: AbortController;
	phase: string;
	done: number;
	total: number;
	characters: number;
	ttfb: number | null;
	startedAt: number;
}

const active = new Map<string, IActiveJob>();

export const activeJobSnapshot = (id: string): IJobSnapshot | null => {
	const job = active.get(id);
	if (!job) return null;
	return {
		kind: job.kind,
		phase: job.phase,
		done: job.done,
		total: job.total,
		characters: job.characters,
		elapsedMs: Date.now() - job.startedAt,
	};
};

export const isBusy = (id: string): boolean => active.has(id);

export const stopJob = (id: string): boolean => {
	const job = active.get(id);
	if (!job) return false;
	job.controller.abort();
	return true;
};

const storedFromIssue = (issue: {
	number: number;
	title: string;
	url: string;
	labels: string[];
	body: string;
	comments: Array<{ author: string | null; body: string }>;
}): IStoredIssue => ({
	number: issue.number,
	kind: 'issue',
	title: issue.title,
	url: issue.url,
	labels: issue.labels,
	body: issue.body,
	comments: issue.comments.map((comment) => ({ author: comment.author, body: comment.body })),
	isHotfix: false,
});

/**
 * Issue fetch job: resolves the given inputs against the release's repo, appending issues as they
 * land. PR inputs are auto-expanded — the bot's "Issues for this release" comment lists every
 * issue, so pasting the release PR alone pulls in the whole release. Progress is pollable via
 * activeJobSnapshot() and every wave is persisted, so a page refresh loses nothing.
 */
export const startFetchJob = (releaseId: string, rawInputs: string[]): boolean => {
	if (active.has(releaseId)) return false;
	const release = loadRelease(releaseId);
	if (!release || !release.repo) return false;

	const job: IActiveJob = {
		kind: 'fetch',
		controller: new AbortController(),
		phase: 'fetching',
		done: 0,
		total: 0,
		characters: 0,
		ttfb: null,
		startedAt: Date.now(),
	};
	active.set(releaseId, job);
	release.status = 'fetching';
	release.error = null;
	saveRelease(release);

	void (async () => {
		try {
			// work queue of `#N` inputs; PRs push their referenced issues back onto it
			const queue: string[] = rawInputs.map((input) => input.trim()).filter(Boolean);
			const seen = new Set<string>();
			let failed = 0;

			while (queue.length > 0 && !job.controller.signal.aborted) {
				const wave = queue.splice(0, 5);
				const results = await Promise.all(wave.map((raw) => resolveInputWithRetry(release.repo, raw)));
				for (let i = 0; i < results.length; i += 1) {
					const item = results[i];
					job.done += 1;
					if (!item.ok) {
						failed += 1;
						continue;
					}
					if (item.kind === 'issue' && item.issue) {
						appendIssue(release, storedFromIssue(item.issue));
					} else if (item.kind === 'pull') {
						for (const number of item.referencedIssueNumbers ?? []) {
							const key = `#${number}`;
							if (!seen.has(key)) {
								seen.add(key);
								queue.push(key);
								job.total += 1;
							}
						}
					}
				}
				saveRelease(release); // every wave is durable — a refresh mid-fetch keeps the rows
			}

			if (job.controller.signal.aborted) {
				release.status = 'stopped';
				release.error = 'Stopped — what was fetched so far is kept.';
			} else {
				release.error = failed > 0
					? `${failed} reference${failed === 1 ? '' : 's'} failed to fetch — run "Fetch issues" again to retry.`
					: null;
				release.status = release.note ? 'ready' : 'draft';
			}
		} catch (err) {
			release.status = 'error';
			release.error = `Issue fetch failed: ${(err as Error).message}`;
			saveRelease(release);
		} finally {
			if (releaseExists(releaseId)) saveRelease(release);
			active.delete(releaseId);
		}
	})();
	return true;
};

/**
 * Generation job: runs fully server-side. The browser can refresh, close, or lose the connection —
 * the note keeps streaming into the release file and the client picks it up by polling.
 */
export const startGenerateJob = (releaseId: string): boolean => {
	if (active.has(releaseId)) return false;
	const release = loadRelease(releaseId);
	if (!release || release.issues.length === 0) return false;

	const saved = effectiveConfig();
	const job: IActiveJob = {
		kind: 'generate',
		controller: new AbortController(),
		phase: 'building',
		done: 0,
		total: 0,
		characters: 0,
		ttfb: null,
		startedAt: Date.now(),
	};
	active.set(releaseId, job);
	release.status = 'generating';
	release.error = null;
	saveRelease(release);

	void (async () => {
		let lastPersist = 0;
		const persistThrottled = (): void => {
			const now = Date.now();
			if (now - lastPersist > 700 && releaseExists(releaseId)) {
				lastPersist = now;
				saveRelease(release);
			}
		};
		try {
			const promptIssues: IIssueForPrompt[] = release.issues.map((issue) => ({
				number: issue.number,
				title: issue.title,
				labels: issue.labels,
				body: issue.body,
				isHotfix: issue.isHotfix,
				comments: issue.comments,
			}));
			const userPrompt = buildUserPrompt({
				version: release.version,
				releaseDate: formatReleaseDate(release.date),
				issues: promptIssues,
				contextFiles: release.contextFiles,
				instructions: release.instructions,
			});
			job.phase = 'prompt-built';

			const full = await streamChatCompletion({
				baseUrl: saved.glmBaseUrl,
				apiKey: saved.glmApiKey,
				model: saved.glmModel,
				messages: [
					{ role: 'system', content: buildSystemPrompt() },
					{ role: 'user', content: userPrompt },
				],
				signal: job.controller.signal,
				onOpen: () => {
					job.phase = 'waiting';
				},
				onDelta: (text) => {
					if (job.phase !== 'streaming') job.phase = 'streaming';
					if (job.ttfb === null) job.ttfb = Date.now() - job.startedAt;
					job.characters += text.length;
					release.note += text;
					persistThrottled();
				},
			});

			release.status = 'ready';
			release.error = null;
			release.stats = {
				characters: full.length,
				elapsedMs: Date.now() - job.startedAt,
				ttfbMs: job.ttfb ?? 0,
			};
		} catch (err) {
			if (job.controller.signal.aborted) {
				release.status = 'stopped';
				release.error = 'Stopped — the partial note is kept.';
			} else {
				release.status = 'error';
				release.error = (err as Error).message;
			}
		} finally {
			if (releaseExists(releaseId)) saveRelease(release);
			active.delete(releaseId);
		}
	})();
	return true;
};

/** Waits (briefly) for a job to wind down after an abort, e.g. before deleting the release. */
export const waitUntilIdle = async (id: string, timeoutMs = 4000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (active.has(id) && Date.now() < deadline) {
		await sleep(100);
	}
};
