import { createReadStream, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DEFAULTS, configFilePath, effectiveConfig, readConfig, toolRoot, writeConfig, type IAppConfig } from './config.ts';
import { checkAuth, viewRepo } from './gh.ts';
import { GlmApiError, streamChatCompletion, testApiKey, type IChatMessage } from './glm.ts';
import { activeJobSnapshot, isBusy, startFetchJob, startGenerateJob, stopJob, waitUntilIdle } from './jobs.ts';
import { dedupeInputs, splitInputs } from './issues.ts';
import { buildSystemPrompt, buildUserPrompt, formatReleaseDate, type IIssueForPrompt } from './prompt.ts';
import {
	createRelease,
	deleteRelease,
	initStore,
	listReleases,
	loadRelease,
	markInterrupted,
	saveRelease,
	toMeta,
	type IContextFile,
	type IStoredIssue,
} from './store.ts';

const PORT = Number(process.env.RELEASE_NOTE_PORT ?? 4310);
const HOST = '127.0.0.1';
const publicDir = path.join(toolRoot, 'public');
const JSON_BODY_LIMIT = 64 * 1024 * 1024;

/** Where "save" writes notes: the outputDir setting (relative → tool folder), default `releases/`. */
const resolveOutputDir = (): string => {
	const configured = effectiveConfig().outputDir.trim() || CONFIG_DEFAULTS.outputDir;
	return path.isAbsolute(configured) ? configured : path.resolve(toolRoot, configured);
};

const MAX_ISSUES = 300;
const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_FILE_CHARS = 200_000;

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > JSON_BODY_LIMIT) {
				reject(new Error('Request body too large.'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new Error('Invalid JSON body.'));
			}
		});
		req.on('error', reject);
	});

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(payload));
};

const sendError = (res: ServerResponse, status: number, message: string): void =>
	sendJson(res, status, { error: message });

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
};

const serveFile = (res: ServerResponse, filePath: string): boolean => {
	if (!existsSync(filePath) || !filePath.startsWith(publicDir)) return false;
	// no-cache: a local single-user tool must never run a stale script after an edit
	res.writeHead(200, {
		'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
		'Cache-Control': 'no-cache',
	});
	createReadStream(filePath).pipe(res);
	return true;
};

const VENDOR_FILES: Record<string, string[]> = {
	'marked.js': ['marked/lib/marked.umd.js'],
	// the bundles reference these maps; serving them keeps devtools free of 404s
	'marked.umd.js.map': ['marked/lib/marked.umd.js.map'],
	'purify.js': ['dompurify/dist/purify.min.js'],
	'purify.min.js.map': ['dompurify/dist/purify.min.js.map'],
};

const resolveVendorFile = (name: string): string | null => {
	const candidates = VENDOR_FILES[name];
	if (!candidates) return null;
	for (const relative of candidates) {
		const absolute = path.join(toolRoot, 'node_modules', relative);
		if (existsSync(absolute)) return absolute;
	}
	return null;
};

const parseStoredIssues = (value: unknown): IStoredIssue[] =>
	(Array.isArray(value) ? value : []).slice(0, MAX_ISSUES).map((entry): IStoredIssue => {
		const item = (entry ?? {}) as Record<string, unknown>;
		const rawComments = Array.isArray(item.comments) ? item.comments.slice(0, 8) : [];
		return {
			number: Number(item.number) || 0,
			kind: item.kind === 'pull' ? 'pull' : 'issue',
			title: asString(item.title).slice(0, 500),
			url: asString(item.url),
			labels: Array.isArray(item.labels) ? item.labels.map((label) => asString(label)).filter(Boolean).slice(0, 20) : [],
			body: asString(item.body),
			comments: rawComments.map((comment) => {
				const inner = (comment ?? {}) as Record<string, unknown>;
				return { author: typeof inner.author === 'string' ? inner.author : null, body: asString(inner.body) };
			}),
			isHotfix: item.isHotfix === true,
		};
	}).filter((issue) => issue.number > 0);

const parseContextFiles = (value: unknown): IContextFile[] =>
	(Array.isArray(value) ? value : [])
		.slice(0, MAX_CONTEXT_FILES)
		.map((entry) => {
			const item = (entry ?? {}) as Record<string, unknown>;
			return {
				name: asString(item.name, 'context.txt').slice(0, 200),
				content: asString(item.content).slice(0, MAX_CONTEXT_FILE_CHARS),
			};
		})
		.filter((file) => file.name && file.content.trim());

const sanitizeFilename = (raw: string): string => {
	const base = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	const name = base || `release-note-${Date.now()}.md`;
	return name.endsWith('.md') ? name : `${name}.md`;
};

const handleKeyTest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const body = (await readJsonBody(req)) as Record<string, unknown>;
	const raw = ((body.config ?? body) ?? {}) as Record<string, unknown>;
	const saved = effectiveConfig();
	const result = await testApiKey({
		baseUrl: asString(raw.glmBaseUrl) || saved.glmBaseUrl,
		apiKey: asString(raw.glmApiKey) || saved.glmApiKey,
		model: asString(raw.glmModel) || saved.glmModel,
	});
	sendJson(res, 200, result);
};

const handleSave = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const raw = (await readJsonBody(req)) as { filename?: unknown; content?: unknown };
	const filename = sanitizeFilename(asString(raw.filename));
	const content = asString(raw.content);
	if (!content.trim()) {
		sendError(res, 400, 'Nothing to save — generate a release note first.');
		return;
	}
	const releasesDir = resolveOutputDir();
	mkdirSync(releasesDir, { recursive: true });
	const target = path.join(releasesDir, filename);
	if (existsSync(target)) {
		sendError(res, 409, `${filename} already exists in releases/ — pick another name.`);
		return;
	}
	writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
	sendJson(res, 200, { saved: target });
};

/** legacy non-streaming generate — kept for curl users; the UI uses release jobs */
const handleLegacyGenerate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const raw = (await readJsonBody(req)) as Record<string, unknown>;
	const rawIssues = Array.isArray(raw.issues) ? raw.issues : [];
	const issues = parseStoredIssues(rawIssues).map((issue) => ({
		number: issue.number,
		title: issue.title,
		labels: issue.labels,
		body: issue.body,
		isHotfix: issue.isHotfix,
		comments: issue.comments,
	}));
	if (!asString(raw.version).trim()) {
		sendError(res, 400, 'Version is required (e.g. 1.19).');
		return;
	}
	if (issues.length === 0) {
		sendError(res, 400, 'No issues to write a release note from.');
		return;
	}
	const saved = effectiveConfig();
	const config = ((raw.config ?? {}) as Record<string, unknown>);
	const apiKey = asString(config.glmApiKey) || saved.glmApiKey;
	const baseUrl = asString(config.glmBaseUrl) || saved.glmBaseUrl;
	const model = asString(config.glmModel) || saved.glmModel;
	const promptIssues: IIssueForPrompt[] = issues;

	res.writeHead(200, {
		'Content-Type': 'application/x-ndjson; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Accel-Buffering': 'no',
	});
	const upstream = new AbortController();
	req.on('close', () => {
		if (!res.writableEnded) upstream.abort();
	});
	const emit = (payload: Record<string, unknown>): void => {
		res.write(`${JSON.stringify(payload)}\n`);
	};
	try {
		const full = await streamChatCompletion({
			baseUrl,
			apiKey,
			model,
			messages: [
				{ role: 'system', content: buildSystemPrompt() },
				{
					role: 'user',
					content: buildUserPrompt({
						version: asString(raw.version).trim(),
						releaseDate: formatReleaseDate(asString(raw.date).trim()),
						issues: promptIssues,
						contextFiles: parseContextFiles(raw.contextFiles),
						instructions: asString(raw.instructions).slice(0, 4_000),
					}),
				},
			],
			signal: upstream.signal,
			onDelta: (text) => emit({ type: 'delta', text }),
		});
		emit({ type: 'done', characters: full.length });
	} catch (err) {
		if ((err as Error).name === 'AbortError') {
			emit({ type: 'done', characters: 0, stopped: true });
		} else {
			const message = err instanceof GlmApiError ? err.message : `Generation failed: ${(err as Error).message}`;
			emit({ type: 'error', message });
		}
	} finally {
		res.end();
	}
};

const routeRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const method = req.method ?? 'GET';
	const segments = url.pathname.split('/').filter(Boolean); // e.g. ['api', 'releases', ':id', 'generate']

	if (method === 'GET' || method === 'HEAD') {
		if (url.pathname === '/') {
			serveFile(res, path.join(publicDir, 'index.html'));
			return;
		}
		if (url.pathname === '/styles.css') {
			serveFile(res, path.join(publicDir, 'styles.css'));
			return;
		}
		if (url.pathname === '/app.js') {
			serveFile(res, path.join(publicDir, 'app.js'));
			return;
		}
		if (url.pathname.startsWith('/vendor/')) {
			const vendorPath = resolveVendorFile(url.pathname.slice('/vendor/'.length));
			if (vendorPath) {
				res.writeHead(200, {
					'Content-Type': vendorPath.endsWith('.map') ? 'application/json' : 'text/javascript; charset=utf-8',
					'Cache-Control': 'no-cache',
				});
				createReadStream(vendorPath).pipe(res);
			} else {
				sendError(res, 404, 'Vendor bundle missing — run `npm install` in the tool folder.');
			}
			return;
		}
		if (url.pathname === '/api/config') {
			sendJson(res, 200, { config: readConfig(), defaults: CONFIG_DEFAULTS, configFile: configFilePath(), outputDir: resolveOutputDir() });
			return;
		}
		if (url.pathname === '/api/gh/status') {
			const login = await checkAuth();
			sendJson(res, 200, { authenticated: login !== null, login });
			return;
		}
		if (segments[0] === 'api' && segments[1] === 'releases' && segments.length === 2) {
			sendJson(res, 200, listReleases());
			return;
		}
		if (segments[0] === 'api' && segments[1] === 'releases' && segments.length === 3) {
			const release = loadRelease(segments[2]);
			if (!release) {
				sendError(res, 404, 'Release not found.');
				return;
			}
			sendJson(res, 200, { release, job: activeJobSnapshot(release.id) });
			return;
		}
	}

	if (method === 'POST') {
		if (url.pathname === '/api/config') {
			const body = (await readJsonBody(req)) as Record<string, unknown>;
			const patch: Partial<IAppConfig> = {};
			for (const key of ['glmApiKey', 'glmBaseUrl', 'glmModel', 'defaultRepo', 'productName'] as const) {
				if (typeof body[key] === 'string') patch[key] = (body[key] as string).trim();
			}
			sendJson(res, 200, { config: writeConfig(patch) });
			return;
		}
		if (url.pathname === '/api/repo/check') {
			const body = (await readJsonBody(req)) as { repo?: unknown };
			const repo = asString(body.repo).trim();
			if (!repo) {
				sendError(res, 400, 'Repository is required (owner/name or a GitHub URL).');
				return;
			}
			try {
				const info = await viewRepo(repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, ''));
				sendJson(res, 200, { ok: true, repo: info });
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				sendJson(res, 200, { ok: false, error: `Cannot access this repository with the current gh account. ${detail}` });
			}
			return;
		}
		if (url.pathname === '/api/key/test') {
			await handleKeyTest(req, res);
			return;
		}
		if (url.pathname === '/api/save') {
			await handleSave(req, res);
			return;
		}
		if (url.pathname === '/api/generate') {
			await handleLegacyGenerate(req, res);
			return;
		}
		if (segments[0] === 'api' && segments[1] === 'releases' && segments.length === 2) {
			const body = (await readJsonBody(req)) as Record<string, unknown>;
			const saved = readConfig();
			const release = createRelease({
				version: asString(body.version).trim().slice(0, 40),
				date: /^\d{4}-\d{2}-\d{2}$/.test(asString(body.date)) ? asString(body.date) : new Date().toISOString().slice(0, 10),
				repo: asString(body.repo).trim() || saved.defaultRepo,
			});
			sendJson(res, 200, { release, job: null });
			return;
		}
		if (segments[0] === 'api' && segments[1] === 'releases' && segments.length === 4) {
			const id = segments[2];
			const action = segments[3];
			if (action === 'issues') {
				const release = loadRelease(id);
				if (!release) {
					sendError(res, 404, 'Release not found.');
					return;
				}
				if (!release.repo) {
					sendError(res, 400, 'Set the repository on this release first.');
					return;
				}
				if (isBusy(id)) {
					sendError(res, 409, 'A job is already running on this release.');
					return;
				}
				const body = (await readJsonBody(req)) as { inputs?: unknown };
				const blob = Array.isArray(body.inputs)
					? body.inputs.map((input) => asString(input)).join('\n')
					: asString(body.inputs);
				const inputs = dedupeInputs(splitInputs(blob));
				if (inputs.length === 0) {
					sendError(res, 400, 'Paste at least one issue link or number.');
					return;
				}
				if (release.issues.length + inputs.length > MAX_ISSUES) {
					sendError(res, 400, `Too many issues — the limit is ${MAX_ISSUES}.`);
					return;
				}
				startFetchJob(id, inputs);
				sendJson(res, 200, { started: true, job: activeJobSnapshot(id) });
				return;
			}
			if (action === 'generate') {
				const release = loadRelease(id);
				if (!release) {
					sendError(res, 404, 'Release not found.');
					return;
				}
				if (isBusy(id)) {
					sendError(res, 409, 'A job is already running on this release.');
					return;
				}
				if (release.issues.length === 0) {
					sendError(res, 400, 'Fetch at least one issue into this release first.');
					return;
				}
				if (!release.version) {
					sendError(res, 400, 'Set the version on this release first.');
					return;
				}
				if (!startGenerateJob(id)) {
					sendError(res, 409, 'Could not start the generation job.');
				}
				sendJson(res, 200, { started: true, job: activeJobSnapshot(id) });
				return;
			}
			if (action === 'stop') {
				const stopped = stopJob(id);
				sendJson(res, 200, { stopped });
				return;
			}
		}
	}

	if (method === 'PATCH' && segments[0] === 'api' && segments[1] === 'releases' && segments.length === 3) {
		const id = segments[2];
		const release = loadRelease(id);
		if (!release) {
			sendError(res, 404, 'Release not found.');
			return;
		}
		if (isBusy(id)) {
			sendError(res, 409, 'A job is running on this release — wait for it to finish before editing.');
			return;
		}
		const body = (await readJsonBody(req)) as Record<string, unknown>;
		const patch: Record<string, unknown> = {};
		for (const key of ['version', 'date', 'repo', 'instructions', 'note'] as const) {
			if (typeof body[key] === 'string') patch[key] = (body[key] as string).slice(0, key === 'note' ? 2_000_000 : 4_000);
		}
		if (body.contextFiles !== undefined) patch.contextFiles = parseContextFiles(body.contextFiles);
		if (body.issues !== undefined) patch.issues = parseStoredIssues(body.issues);
		const updated = { ...release, ...patch };
		saveRelease(updated);
		sendJson(res, 200, { release: updated, job: activeJobSnapshot(id) });
		return;
	}

	if (method === 'DELETE' && segments[0] === 'api' && segments[1] === 'releases' && segments.length === 3) {
		const id = segments[2];
		if (!loadRelease(id)) {
			sendError(res, 404, 'Release not found.');
			return;
		}
		if (isBusy(id)) {
			stopJob(id);
			await waitUntilIdle(id);
		}
		sendJson(res, 200, { deleted: deleteRelease(id) });
		return;
	}

	sendError(res, 404, `No route for ${method} ${url.pathname}`);
};

const main = (): void => {
	initStore();
	const interrupted = markInterrupted();
	if (interrupted > 0) {
		console.log(`  ${interrupted} release${interrupted === 1 ? '' : 's'} were mid-job at last shutdown — marked as stopped (content kept).`);
	}
	const server = createServer((req, res) => {
		routeRequest(req, res).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				sendError(res, 500, message);
			} else if (!res.writableEnded) {
				res.end(`${JSON.stringify({ type: 'error', message })}\n`);
			}
		});
	});

	server.listen(PORT, HOST, () => {
		console.log(`Release Note Generator → http://${HOST}:${PORT}`);
		if (!readConfig().glmApiKey) {
			console.log('  note: no GLM API key yet — open Settings in the UI and paste your Coding Plan key.');
		}
		void checkAuth().then((login) => {
			if (!login) console.log('  warning: gh is not authenticated — run `gh auth login` first.');
		});
	});
};

/** True only when this file is the process's entry script — `release-note serve` imports it. */
const isDirectRun = (): boolean => {
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
	} catch {
		return false;
	}
};

export { main as startServer };

if (isDirectRun()) main();
