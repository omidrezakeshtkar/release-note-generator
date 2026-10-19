import { readdirSync } from 'node:fs';
import path from 'node:path';

export type VersionBumpKind = 'patch' | 'minor' | 'major';

export interface IParsedVersion {
	major: number;
	minor: number | null;
	patch: number | null;
}

/** `1`, `1.19`, `v2.0.1`, `1.18.1-beta` → parts; garbage → null. */
export const parseVersion = (value: string): IParsedVersion | null => {
	const match = String(value ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: match[2] === undefined ? null : Number(match[2]),
		patch: match[3] === undefined ? null : Number(match[3]),
	};
};

/** Canonical display form: `1.19`, not `v1.19.0`. */
export const formatVersion = (parsed: IParsedVersion): string => {
	if (parsed.patch === null) return `${parsed.major}.${parsed.minor ?? 0}`;
	return `${parsed.major}.${parsed.minor ?? 0}.${parsed.patch}`;
};

export const compareVersions = (a: IParsedVersion, b: IParsedVersion): number =>
	(a.major - b.major)
	|| ((a.minor ?? 0) - (b.minor ?? 0))
	|| ((a.patch ?? 0) - (b.patch ?? 0));

export const sortVersions = (values: string[]): string[] =>
	values
		.map((value) => ({ value, parsed: parseVersion(value) }))
		.filter((entry): entry is { value: string; parsed: IParsedVersion } => entry.parsed !== null)
		.sort((a, b) => compareVersions(a.parsed, b.parsed))
		.map((entry) => entry.value);

/**
 * semver bump, displayed the way the team reads it: `major` → `2.0`, `minor` → `1.19`,
 * `patch` → `1.18.1`.
 */
export const bumpVersion = (parsed: IParsedVersion, kind: VersionBumpKind): string => {
	const minor = parsed.minor ?? 0;
	if (kind === 'major') return `${parsed.major + 1}.0`;
	if (kind === 'minor') return `${parsed.major}.${minor + 1}`;
	return `${parsed.major}.${minor}.${(parsed.patch ?? 0) + 1}`;
};

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The release version carried by a label such as `Release v1.19`: every label starting with
 * `prefix` must end in a parseable version; the highest wins. Returns the version string.
 */
export const versionFromLabels = (labels: string[], prefix: string): string | null => {
	const pattern = new RegExp(`^${escapeRegExp(prefix.trim())}\\s*v?(\\d+(?:\\.\\d+){0,2})$`, 'i');
	const versions: string[] = [];
	for (const label of labels) {
		const match = label.trim().match(pattern);
		if (match) versions.push(match[1]);
	}
	return sortVersions(versions).at(-1) ?? null;
};

/**
 * Highest version among `release-note-v<version>-<YYYYMMDD>.md` files in `dir` — the baseline
 * for `--bump` when no explicit base version is given.
 */
export const latestNoteVersion = (dir: string): string | null => {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const versions: string[] = [];
	for (const name of names) {
		const match = name.match(/^release-note-v(.+)-(\d{8})\.md$/i);
		if (match && parseVersion(match[1])) versions.push(match[1]);
	}
	return sortVersions(versions).at(-1) ?? null;
};
