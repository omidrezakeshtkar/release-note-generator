import { readFileSync } from 'node:fs';
import path from 'node:path';
import { effectiveConfig, toolRoot } from './config.ts';

const formatExamplePath = path.join(toolRoot, 'samples', 'format-example.md');

export const loadFormatExample = (): string => {
	try {
		return readFileSync(formatExamplePath, 'utf8').trim();
	} catch {
		return '';
	}
};

export interface IIssueForPrompt {
	number: number;
	title: string;
	labels: string[];
	body: string;
	isHotfix: boolean;
	comments: Array<{ author: string | null; body: string }>;
}

export interface IContextFile {
	name: string;
	content: string;
}

export interface IGeneratePromptInput {
	version: string;
	releaseDate: string;
	issues: IIssueForPrompt[];
	contextFiles: IContextFile[];
	instructions: string;
}

const BODY_LIMIT = 8_000;
const COMMENT_LIMIT = 3_000;
const MAX_COMMENTS = 5;
const CONTEXT_FILE_LIMIT = 12_000;

const clip = (text: string, limit: number): string =>
	text.length <= limit ? text : `${text.slice(0, limit)}\n[…truncated]`;

const SYSTEM_PROMPT_HEADER = (product: string): string => `You are the release-notes writer for ${product}.

You turn the raw GitHub issues of one release into polished, user-facing release notes written in markdown. Follow EXACTLY the structure, headings, and tone of the example given at the end of these instructions.

Output rules:
- Respond with the release note markdown only. No preamble, no explanations, no code fences around the whole note.
- First line: the heading \`🚀   Release Notes – Version <VERSION>\` (rocket emoji, three spaces, en dash).
- Second line: \`Release Date: <Month DD, YYYY>\` exactly as provided by the user.
- Then the sections, in this order (omit a section only when nothing belongs to it):
  1. \`✨ New Features & Improvements\` — group items by the persona or role they serve. Each group starts with the role name followed by a colon on its own line (e.g. \`Administrators:\`, \`Editors:\`), matching the role style of the example. Under each role, one bullet per feature shaped like \`Feature Name: what users can now do.\` Changes that affect everyone (login, redirects, public pages, migrations) go after the role groups as ungrouped bullets.
  2. \`🐞 Bug Fixes\` — plain bullets; each names the broken behavior and states that it now works correctly.
  3. \`♻️ Improvement\` — plain bullets for polish/UX/performance changes that are neither new features nor bugs.
- When hotfix issues are provided, put a \`🔥 Hotfixes\` section before everything else: one bullet per hotfix, phrased as the problem users hit plus the fix.
- Every bullet is user-facing English: say what the user can now do or what now works. Never mention issue numbers, PR numbers, branches, commits, component or file names, APIs, databases, or dev tooling.
- Merge issues that describe the same feature into one bullet; split a large multi-part issue into several bullets under the right role.
- Skip noise: chores, dependency bumps, CI, refactors, and internal test work without user-visible effect.
- Terminology: use the product's own vocabulary exactly as it appears in the issues and the example. Sentence case, concise, factual, no marketing fluff.`;

/** "2026-10-17" → "October 17, 2026" (the Release Date line format). */
export const formatReleaseDate = (isoDate: string): string => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
	const date = new Date(`${isoDate}T00:00:00Z`);
	return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date);
};

export const buildSystemPrompt = (productNameOverride?: string): string => {
	const product = (productNameOverride ?? effectiveConfig().productName).trim() || 'the product';
	const example = loadFormatExample();
	const header = SYSTEM_PROMPT_HEADER(product);
	if (!example) return header;
	return `${header}\n\n## Example of the expected output (imitate this structure and tone)\n\n\`\`\`\n${example}\n\`\`\``;
};

export const buildUserPrompt = (input: IGeneratePromptInput): string => {
	const parts: string[] = [];

	parts.push(`Produce the release note for:\n- Version: ${input.version}\n- Release Date line: ${input.releaseDate}`);

	const hotfixes = input.issues.filter((issue) => issue.isHotfix);
	parts.push(
		hotfixes.length > 0
			? `Hotfix issues (must go to the 🔥 Hotfixes section): ${hotfixes.map((issue) => `#${issue.number}`).join(', ')}`
			: 'Hotfix issues: none this release.',
	);

	parts.push(
		`## Issues (${input.issues.length})\n\n${input.issues
			.map((issue) => {
				const chunks = [`### Issue #${issue.number} — ${issue.title}`];
				if (issue.labels.length > 0) chunks.push(`Labels: ${issue.labels.join(', ')}`);
				chunks.push(`Body:\n${clip(issue.body.trim() || '(empty)', BODY_LIMIT)}`);
				const comments = issue.comments.slice(0, MAX_COMMENTS).filter((comment) => comment.body.trim());
				if (comments.length > 0) {
					chunks.push(
						`Comments:\n${comments
							.map((comment) => `- ${comment.author ? `@${comment.author}` : 'user'}: ${clip(comment.body.trim(), COMMENT_LIMIT)}`)
							.join('\n')}`,
					);
				}
				return chunks.join('\n');
			})
			.join('\n\n')}`,
	);

	if (input.contextFiles.length > 0) {
		parts.push(
			`## Context files (supporting material — use them to phrase and group items; do not copy blindly)\n\n${input.contextFiles
				.map((file) => `### File: ${file.name}\n${clip(file.content, CONTEXT_FILE_LIMIT)}`)
				.join('\n\n')}`,
		);
	}

	if (input.instructions) {
		parts.push(`## Extra instructions from the user (obey these)\n\n${input.instructions}`);
	}

	return parts.join('\n\n');
};
