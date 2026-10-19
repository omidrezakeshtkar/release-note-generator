import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { asFlag, asList, asString, parseArgs, UsageError } from './args.ts';
import { configFilePath, effectiveConfig, readConfig, toolRoot, writeConfig, type IAppConfig } from './config.ts';
import { splitInputs } from './issues.ts';
import { testApiKey } from './glm.ts';
import { DEFAULT_RELEASE_LABEL_PREFIX, runPipeline } from './pipeline.ts';
import { resolveDefaultRepo, resolveProvider } from './provider.ts';
import type { IContextFile } from './prompt.ts';
import type { VersionBumpKind } from './version.ts';

const VERSION: string = (JSON.parse(readFileSync(path.join(toolRoot, 'package.json'), 'utf8')) as { version: string }).version;

/* ============================== help texts ============================== */

const GLOBAL_HELP = `release-note ${VERSION} — turn a release's GitHub/GitLab issues into a polished release note

Usage: release-note <command> [options]

Commands:
  generate      Select a release's issues (refs, labels, or auto-discovery) and write the note
  serve         Start the local web UI (default http://127.0.0.1:4310)
  config        Show or edit the stored settings (config.local.json)
  check         Verify provider auth and repository access
  test-key      Verify the GLM API key with a tiny request
  man           Show the full manual page
  help          Show help for a command ("release-note help generate")

Quick start:
  release-note generate --repo owner/repo --release-label-prefix     # current "Release vX" release
  release-note generate --repo owner/repo --label "Release v1.19" --out release-note.md
  release-note serve

Backends ("providers"): locally the gh CLI is used; in CI set GH_TOKEN (GitHub) or GITLAB_TOKEN
(GitLab) and the matching REST API is used automatically. See "release-note help generate".

Environment overrides: RELEASE_NOTE_GLM_API_KEY, RELEASE_NOTE_GLM_BASE_URL, RELEASE_NOTE_GLM_MODEL,
RELEASE_NOTE_DEFAULT_REPO, RELEASE_NOTE_PRODUCT_NAME, RELEASE_NOTE_OUTPUT_DIR,
RELEASE_NOTE_PROVIDER, RELEASE_NOTE_PORT.

Full documentation: README.md (repo root) or "man release-note" after a global install.`;

const COMMAND_HELP: Record<string, string> = {
	generate: `release-note generate — fetch a release's issues and generate the release note

Selection (combine freely; at least one source is required):
  --issue <ref>…               Issue refs: #123, 123, or full GitHub/GitLab URLs. Also accepted
                               as bare positional args. A value of @file reads refs (one per
                               line) from a file; "-" reads them from stdin.
  --release-pr <n>…            Expand a release PR: every issue referenced in its body/comments
                               is pulled in (the release bot's "Issues for this release" list).
  --label <label>…             Select every issue/PR carrying this exact label (repeatable; the
                               union is fetched).
  --release-label-prefix [<p>] Auto-discover the current release: every issue whose labels start
                               with the prefix (default "Release v") is grouped by the version in
                               its label and the newest group is selected.

Version (first match wins):
  --version <v>                Use this exact version (e.g. 1.19).
  (automatic)                  The highest "Release vX.Y" label on the selected issues.
  --bump <patch|minor|major>   Bump a base version (see --from; default: the newest
                               release-note-v*.md in the output folder).

Hotfixes:
  --hotfix <n,n,…>             Mark these issue numbers as hotfixes (🔥 section).
  --hotfix-label <label>       Mark every selected issue carrying this label as a hotfix.

Content:
  --repo <owner/name>          Target repository. Default: --repo > config defaultRepo > the CI
                               repo (CI_PROJECT_PATH / GITHUB_REPOSITORY).
  --date <YYYY-MM-DD>          Release date (default: today).
  --instructions <text>        Extra instructions for the model.
  --instructions-file <path>   Same, read from a file. (Mutually exclusive with --instructions.)
  --context-file <path>        Attach a local file as context (repeatable).
  --product <name>             Product name for the note header (default: productName setting).

Output:
  --out <path|->               Write the note to a file; "-" (default) writes stdout.
  --force                      Overwrite an existing --out file.

Connection:
  --provider <name>            gh-cli | github-api | gitlab-api (default: auto-detected —
                               GITHUB_ACTIONS+GH_TOKEN → github-api, GITLAB_CI+GITLAB_TOKEN →
                               gitlab-api, otherwise the gh CLI).
  --api-key <key>              GLM key for this run (default: env / config).
  --base-url <url> --model <id>  Override the GLM endpoint/model for this run.
  --quiet                      Suppress progress output on stderr.

Examples:
  # The whole current release, version taken from its "Release v1.19" labels:
  release-note generate --repo owner/repo --release-label-prefix

  # In GitHub Actions, with the repo's own token:
  release-note generate --provider github-api --release-label-prefix --out note.md

  # Same on GitLab CI (repo comes from CI_PROJECT_PATH):
  release-note generate --provider gitlab-api --label "Release v1.19" --out note.md

  # Explicit issues, hotfixes marked, version bumped from the last saved note:
  release-note generate -R omitted --issue "#101 #102" --release-pr 312 \\
      --hotfix 101 --bump minor --out releases/release-note-v1.20.md`,
	serve: `release-note serve — start the local web UI

  --port <n>   Port to listen on (default: 4310, or RELEASE_NOTE_PORT). The server binds
               127.0.0.1 only and has no auth — never expose it.

Example:
  release-note serve --port 5000`,
	config: `release-note config — show or edit the stored settings (config.local.json)

  release-note config list            All fields; the API key is masked (default)
  release-note config get <field>     Print one field
  release-note config set <field> <value>   Set a field ("" clears it → default applies)
  release-note config path            Print the config file location

Fields: glmApiKey, glmBaseUrl, glmModel, defaultRepo, productName, outputDir.

outputDir is where notes are saved (web UI "Save" and the --bump baseline); relative paths
resolve against the tool folder. Environment variables override every field — see README.

Example:
  release-note config set glmApiKey zpka_…
  release-note config set productName "My Product"`,
	check: `release-note check — verify provider auth and repository access

  --repo <owner/name>   Repository to check (default: config defaultRepo, then the CI repo)
  --provider <name>     gh-cli | github-api | gitlab-api (default: auto-detected)

Prints the active account and your permission level. Exit code 1 on any failure.

Example:
  GITLAB_TOKEN=glpat-… release-note check --provider gitlab-api`,
	'test-key': `release-note test-key — verify the GLM API key with an 8-token request

  --api-key <key>      Key to test (default: env / config)
  --base-url <url>     Endpoint override (default: the Coding Plan endpoint)
  --model <id>         Model override (default: glm-5.3-flash)

Exit code 0 = the key works and covers the model; 1 = it does not, with the reason.

Example:
  release-note test-key`,
	man: `release-note man — show the full manual page

Renders docs/release-note.1 through man(1). After a global npm install, "man release-note"
works directly.`,
};

const usageHint = (command: string): string => `Run "release-note help ${command}" for usage.`;

/* ============================== helpers ============================== */

const fail = (message: string): never => {
	process.stderr.write(`error: ${message}\n`);
	process.exit(2);
};

const readStdin = (): string => readFileSync(0, 'utf8');

/** Positional + --issue refs; `@file` reads one ref per line, `-` reads stdin. */
const collectIssueRefs = (positionals: string[], flagRefs: string[]): string[] => {
	const raw: string[] = [];
	for (const source of [...positionals, ...flagRefs]) {
		if (source === '-') {
			raw.push(readStdin());
		} else if (source.startsWith('@')) {
			const file = source.slice(1);
			if (!existsSync(file)) fail(`Issue ref file not found: ${file}`);
			raw.push(readFileSync(file, 'utf8'));
		} else {
			raw.push(source);
		}
	}
	return dedupeRefs(splitInputs(raw.join('\n')));
};

const dedupeRefs = (refs: string[]): string[] => [...new Set(refs)];

const splitNumbers = (value: string): number[] =>
	value
		.split(/[\s,]+/)
		.map((part) => Number(part.replace(/^#?v?/i, '')))
		.filter((n) => Number.isInteger(n) && n > 0);

const readContextFiles = (paths: string[]): IContextFile[] =>
	paths.map((file) => {
		if (!existsSync(file)) fail(`Context file not found: ${file}`);
		return { name: path.basename(file), content: readFileSync(file, 'utf8') };
	});

const writeNote = (target: string, note: string, force: boolean): void => {
	if (existsSync(target) && !force) {
		throw new UsageError(`${target} already exists — pass --force to overwrite.`);
	}
	const dir = path.dirname(target);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(target, note.endsWith('\n') ? note : `${note}\n`, 'utf8');
};

/* ============================== commands ============================== */

const runGenerate = async (argv: string[]): Promise<number> => {
	const parsed = parseArgs(argv, {
		'--repo': 'string',
		'--provider': 'string',
		'--label': 'string[]',
		'--release-label-prefix': 'string?',
		'--release-pr': 'string[]',
		'--issue': 'string[]',
		'--version': 'string',
		'--bump': 'string',
		'--from': 'string',
		'--hotfix': 'string',
		'--hotfix-label': 'string',
		'--date': 'string',
		'--instructions': 'string',
		'--instructions-file': 'string',
		'--context-file': 'string[]',
		'--product': 'string',
		'--out': 'string',
		'--force': 'boolean',
		'--api-key': 'string',
		'--base-url': 'string',
		'--model': 'string',
		'--quiet': 'boolean',
	});
	const v = parsed.values;

	const repo = (asString(v, '--repo') ?? effectiveConfig().defaultRepo) || resolveDefaultRepo() || '';
	if (!repo) fail('No repository — pass --repo owner/name, set defaultRepo, or run inside CI.');

	const instructionsFlag = asString(v, '--instructions');
	const instructionsFile = asString(v, '--instructions-file');
	if (instructionsFlag && instructionsFile) fail('Use either --instructions or --instructions-file, not both.');
	const instructions = instructionsFile ? readFileSync(instructionsFile, 'utf8').trim() : instructionsFlag ?? '';

	const bumpRaw = asString(v, '--bump') ?? '';
	if (bumpRaw && !['patch', 'minor', 'major'].includes(bumpRaw)) fail(`--bump must be patch, minor, or major — got "${bumpRaw}".`);

	const date = asString(v, '--date') ?? new Date().toISOString().slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD — got "${date}".`);

	// per-run GLM overrides: flags mutate the in-memory env read by effectiveConfig()
	if (asString(v, '--api-key')) process.env.RELEASE_NOTE_GLM_API_KEY = asString(v, '--api-key');
	if (asString(v, '--base-url')) process.env.RELEASE_NOTE_GLM_BASE_URL = asString(v, '--base-url');
	if (asString(v, '--model')) process.env.RELEASE_NOTE_GLM_MODEL = asString(v, '--model');

	const quiet = asFlag(v, '--quiet');
	const started = Date.now();
	const prefixFlag = v['--release-label-prefix'];
	const result = await runPipeline({
		repo,
		provider: resolveProvider(asString(v, '--provider')),
		inputs: collectIssueRefs(parsed.positionals, asList(v, '--issue')),
		releasePrs: asList(v, '--release-pr').flatMap((value) => splitNumbers(value)),
		labels: asList(v, '--label'),
		releaseLabelPrefix: prefixFlag === undefined
			? null
			: asString(v, '--release-label-prefix')!.trim() || DEFAULT_RELEASE_LABEL_PREFIX,
		version: asString(v, '--version') ?? null,
		bump: (bumpRaw || null) as VersionBumpKind | null,
		bumpFrom: asString(v, '--from') ?? null,
		outputDir: effectiveConfig().outputDir,
		date,
		instructions,
		contextFiles: readContextFiles(asList(v, '--context-file')),
		hotfixNumbers: asList(v, '--hotfix').flatMap((value) => splitNumbers(value)),
		hotfixLabel: asString(v, '--hotfix-label') ?? null,
		productNameOverride: asString(v, '--product') ?? null,
		onProgress: quiet ? undefined : (message) => process.stderr.write(`• ${message}\n`),
	});

	const out = asString(v, '--out') ?? '-';
	if (out !== '-' && out.trim()) {
		const target = path.resolve(out);
		writeNote(target, result.note, asFlag(v, '--force'));
	} else {
		process.stdout.write(`${result.note}\n`);
	}

	const seconds = Math.round((Date.now() - started) / 1000);
	process.stderr.write(`✓ v${result.version} (${result.versionSource}) — ${result.issues.length} issue(s), ${result.stats.characters} characters, ${seconds}s${out !== '-' && out.trim() ? ` → ${path.resolve(out)}` : ''}\n`);
	if (result.failed.length > 0) {
		process.stderr.write(`✗ ${result.failed.length} reference(s) failed to fetch:\n`);
		for (const item of result.failed) process.stderr.write(`  ${item.input}: ${item.error}\n`);
		return 1;
	}
	return 0;
};

const runServe = async (argv: string[]): Promise<number> => {
	const parsed = parseArgs(argv, { '--port': 'string' });
	const port = asString(parsed.values, '--port');
	if (port) process.env.RELEASE_NOTE_PORT = port;
	const { startServer } = await import('./server.ts');
	startServer();
	return 0;
};

const maskKey = (value: string): string => {
	if (!value) return '(not set)';
	return `•••• (set, ${value.length} characters)`;
};

const runConfig = async (argv: string[]): Promise<number> => {
	const [subcommand, field, value] = argv;
	const fields = Object.keys(readConfig()) as Array<keyof IAppConfig>;
	if (!subcommand || subcommand === 'list') {
		const stored = readConfig();
		for (const key of fields) {
			const display = key === 'glmApiKey' ? maskKey(stored[key]) : stored[key] || '(not set)';
			process.stdout.write(`${key} = ${display}\n`);
		}
		process.stdout.write(`\nconfig file: ${configFilePath()}\n`);
		return 0;
	}
	if (subcommand === 'path') {
		process.stdout.write(`${configFilePath()}\n`);
		return 0;
	}
	if (subcommand === 'get') {
		if (!field || !fields.includes(field as keyof IAppConfig)) {
			fail(`Unknown or missing field — one of: ${fields.join(', ')}`);
		}
		const stored = readConfig();
		process.stdout.write(`${stored[field as keyof IAppConfig] || ''}\n`);
		return 0;
	}
	if (subcommand === 'set') {
		if (!field || !fields.includes(field as keyof IAppConfig) || value === undefined) {
			fail(`Usage: release-note config set <field> <value> — fields: ${fields.join(', ')}`);
		}
		writeConfig({ [field]: value } as Partial<IAppConfig>);
		process.stderr.write(`✓ ${field} saved to ${configFilePath()}\n`);
		return 0;
	}
	return fail(`Unknown config command "${subcommand}" — use list, get, set, or path.`);
};

const runCheck = async (argv: string[]): Promise<number> => {
	const parsed = parseArgs(argv, { '--repo': 'string', '--provider': 'string' });
	const provider = resolveProvider(asString(parsed.values, '--provider'));
	process.stderr.write(`provider: ${await provider.describe()}\n`);
	const login = await provider.checkAuth();
	if (!login) {
		process.stderr.write(`✗ not authenticated — ${provider.name} needs a token or a gh login (see README → Providers).\n`);
		return 1;
	}
	process.stderr.write(`account: @${login}\n`);
	const repo = (asString(parsed.values, '--repo') ?? effectiveConfig().defaultRepo) || resolveDefaultRepo() || '';
	if (!repo) {
		process.stderr.write('no repository given — pass --repo owner/name to finish the check.\n');
		return 0;
	}
	try {
		const info = await provider.viewRepo(repo);
		const visibility = info.isPrivate ? 'private' : 'public';
		process.stderr.write(`repo: ${info.nameWithOwner} — permission ${info.viewerPermission} (${visibility}${info.defaultBranch ? `, default branch ${info.defaultBranch}` : ''})\n`);
		return 0;
	} catch (err) {
		process.stderr.write(`✗ cannot access ${repo}: ${(err as Error).message}\n`);
		return 1;
	}
};

const runTestKey = async (argv: string[]): Promise<number> => {
	const parsed = parseArgs(argv, { '--api-key': 'string', '--base-url': 'string', '--model': 'string' });
	const saved = effectiveConfig();
	const result = await testApiKey({
		apiKey: asString(parsed.values, '--api-key') || saved.glmApiKey,
		baseUrl: asString(parsed.values, '--base-url') || saved.glmBaseUrl,
		model: asString(parsed.values, '--model') || saved.glmModel,
	});
	if (result.ok) {
		process.stderr.write(`✓ key works — model ${result.model} responded in ${result.latencyMs} ms.\n`);
		return 0;
	}
	process.stderr.write(`✗ ${result.message}\n`);
	return 1;
};

const runMan = async (): Promise<number> => {
	const manPath = path.join(toolRoot, 'docs', 'release-note.1');
	if (existsSync(manPath)) {
		// a path argument (it contains "/") works on both macOS man and Linux man-db
		const result = spawnSync('man', [manPath], { stdio: 'inherit' });
		if (result.status === 0) return 0;
	}
	process.stderr.write('could not render the man page — showing the summary help instead:\n\n');
	process.stdout.write(GLOBAL_HELP);
	return 0;
};

/* ============================== entry ============================== */

const printHelp = (command: string | undefined): number => {
	if (!command) {
		process.stdout.write(GLOBAL_HELP);
		return 0;
	}
	const help = COMMAND_HELP[command];
	if (!help) {
		process.stderr.write(`No help entry for "${command}". Commands: ${Object.keys(COMMAND_HELP).join(', ')}.\n`);
		return 2;
	}
	process.stdout.write(`${help}\n`);
	return 0;
};

const main = async (argv: string[]): Promise<number> => {
	const [command, ...rest] = argv;
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		return printHelp(rest[0]);
	}
	if (command === '--version' || command === '-v' || command === 'version') {
		process.stdout.write(`release-note ${VERSION}\n`);
		return 0;
	}
	switch (command) {
		case 'generate':
			return runGenerate(rest);
		case 'serve':
			return runServe(rest);
		case 'config':
			return runConfig(rest);
		case 'check':
			return runCheck(rest);
		case 'test-key':
			return runTestKey(rest);
		case 'man':
			return runMan();
		default:
			process.stderr.write(`Unknown command "${command}".\n\n${GLOBAL_HELP}\n`);
			return 2;
	}
};

const invoked = async (): Promise<void> => {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (err) {
		if (err instanceof UsageError) {
			process.stderr.write(`error: ${err.message}\n${usageHint(process.argv[2] ?? 'generate')}\n`);
			process.exitCode = 2;
		} else {
			process.stderr.write(`error: ${(err as Error).message}\n`);
			process.exitCode = 1;
		}
	}
};

void invoked();
