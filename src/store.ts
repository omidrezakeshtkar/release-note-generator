import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toolRoot } from './config.ts';

export type ReleaseStatus = 'draft' | 'fetching' | 'generating' | 'ready' | 'error' | 'stopped';

export interface IStoredComment {
	author: string | null;
	body: string;
}

export interface IStoredIssue {
	number: number;
	kind: 'issue' | 'pull';
	title: string;
	url: string;
	labels: string[];
	body: string;
	comments: IStoredComment[];
	isHotfix: boolean;
}

export interface IContextFile {
	name: string;
	content: string;
}

export interface IRelease {
	id: string;
	version: string;
	date: string;
	repo: string;
	instructions: string;
	contextFiles: IContextFile[];
	issues: IStoredIssue[];
	note: string;
	status: ReleaseStatus;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	stats: { characters: number; elapsedMs: number; ttfbMs: number } | null;
}

export interface IReleaseMeta {
	id: string;
	version: string;
	date: string;
	repo: string;
	status: ReleaseStatus;
	issueCount: number;
	hotfixCount: number;
	noteChars: number;
	updatedAt: string;
}

const dataDir = path.join(toolRoot, 'data', 'releases');

const filePath = (id: string): string => path.join(dataDir, `${id}.json`);
const validId = (id: string): boolean => /^[\w-]+$/.test(id);

export const initStore = (): void => {
	mkdirSync(dataDir, { recursive: true });
};

export const releaseExists = (id: string): boolean => validId(id) && existsSync(filePath(id));

export const createRelease = (initial: Partial<IRelease> = {}): IRelease => {
	const now = new Date().toISOString();
	const release: IRelease = {
		id: randomUUID().slice(0, 8),
		version: '',
		date: new Date().toISOString().slice(0, 10),
		repo: '',
		instructions: '',
		contextFiles: [],
		issues: [],
		note: '',
		status: 'draft',
		error: null,
		createdAt: now,
		updatedAt: now,
		stats: null,
		...initial,
	};
	saveRelease(release);
	return release;
};

export const saveRelease = (release: IRelease): void => {
	release.updatedAt = new Date().toISOString();
	const tmp = `${filePath(release.id)}.tmp`;
	writeFileSync(tmp, JSON.stringify(release, null, '\t'), 'utf8');
	renameSync(tmp, filePath(release.id));
};

export const loadRelease = (id: string): IRelease | null => {
	if (!validId(id)) return null;
	if (!existsSync(filePath(id))) return null;
	try {
		return JSON.parse(readFileSync(filePath(id), 'utf8')) as IRelease;
	} catch {
		return null;
	}
};

export const toMeta = (release: IRelease): IReleaseMeta => ({
	id: release.id,
	version: release.version,
	date: release.date,
	repo: release.repo,
	status: release.status,
	issueCount: release.issues.length,
	hotfixCount: release.issues.filter((issue) => issue.isHotfix).length,
	noteChars: release.note.length,
	updatedAt: release.updatedAt,
});

export const listReleases = (): IReleaseMeta[] => {
	if (!existsSync(dataDir)) return [];
	return readdirSync(dataDir)
		.filter((name) => name.endsWith('.json'))
		.map((name) => loadRelease(name.slice(0, -5)))
		.filter((release): release is IRelease => release !== null)
		.map(toMeta)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const updateRelease = (id: string, patch: Partial<IRelease>): IRelease | null => {
	const release = loadRelease(id);
	if (!release) return null;
	Object.assign(release, patch);
	saveRelease(release);
	return release;
};

export const deleteRelease = (id: string): boolean => {
	if (!validId(id) || !existsSync(filePath(id))) return false;
	rmSync(filePath(id));
	return true;
};

export const appendIssue = (release: IRelease, issue: IStoredIssue): boolean => {
	if (release.issues.some((existing) => existing.kind === issue.kind && existing.number === issue.number)) {
		return false;
	}
	release.issues.push(issue);
	return true;
};

/** A server restart kills in-flight jobs — mark those releases honestly instead of lying "generating" forever. */
export const markInterrupted = (): number => {
	if (!existsSync(dataDir)) return 0;
	let count = 0;
	for (const name of readdirSync(dataDir).filter((n) => n.endsWith('.json'))) {
		const release = loadRelease(name.slice(0, -5));
		if (release && (release.status === 'generating' || release.status === 'fetching')) {
			release.status = 'stopped';
			release.error = 'Interrupted by a server restart — what was generated so far is kept.';
			saveRelease(release);
			count += 1;
		}
	}
	return count;
};
