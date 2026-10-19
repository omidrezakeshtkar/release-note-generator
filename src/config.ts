import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const configPath = path.join(toolRoot, 'config.local.json');

export interface IAppConfig {
	glmApiKey: string;
	glmBaseUrl: string;
	glmModel: string;
	defaultRepo: string;
	/** Name used in the prompt header ("…release-notes writer for <product>"). Empty → generic wording. */
	productName: string;
	/** Where "save" writes notes; relative paths resolve against the tool folder. Empty → `releases/`. */
	outputDir: string;
}

/** Used for every field the user left empty. */
export const CONFIG_DEFAULTS: IAppConfig = {
	glmApiKey: '',
	// GLM Coding Plan, OpenAI-compatible endpoint.
	glmBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
	glmModel: 'glm-5.3-flash',
	defaultRepo: '',
	productName: '',
	outputDir: 'releases',
};

const EMPTY: IAppConfig = { glmApiKey: '', glmBaseUrl: '', glmModel: '', defaultRepo: '', productName: '', outputDir: '' };

/** Environment variable per config field — CI runs set these instead of config.local.json. */
export const CONFIG_ENV_VARS: Record<keyof IAppConfig, string> = {
	glmApiKey: 'RELEASE_NOTE_GLM_API_KEY',
	glmBaseUrl: 'RELEASE_NOTE_GLM_BASE_URL',
	glmModel: 'RELEASE_NOTE_GLM_MODEL',
	defaultRepo: 'RELEASE_NOTE_DEFAULT_REPO',
	productName: 'RELEASE_NOTE_PRODUCT_NAME',
	outputDir: 'RELEASE_NOTE_OUTPUT_DIR',
};

const envValue = (name: string): string => (process.env[name] ?? '').trim();

/** Exactly what is stored — empty string means "not set, use the default". */
export const readConfig = (): IAppConfig => {
	if (!existsSync(configPath)) return { ...EMPTY };
	try {
		const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<IAppConfig>;
		return { ...EMPTY, ...raw };
	} catch {
		return { ...EMPTY };
	}
};

/**
 * Resolution order per field: environment variable → stored config → CONFIG_DEFAULTS.
 * Env vars win over the file so CI jobs (and `--api-key`-style overrides) never need a local
 * config; the file wins over defaults for everything the user actually saved.
 */
export const effectiveConfig = (stored: IAppConfig = readConfig()): IAppConfig => ({
	glmApiKey: envValue(CONFIG_ENV_VARS.glmApiKey) || stored.glmApiKey || CONFIG_DEFAULTS.glmApiKey,
	glmBaseUrl: envValue(CONFIG_ENV_VARS.glmBaseUrl) || stored.glmBaseUrl || CONFIG_DEFAULTS.glmBaseUrl,
	glmModel: envValue(CONFIG_ENV_VARS.glmModel) || stored.glmModel || CONFIG_DEFAULTS.glmModel,
	defaultRepo: envValue(CONFIG_ENV_VARS.defaultRepo) || stored.defaultRepo || CONFIG_DEFAULTS.defaultRepo,
	productName: envValue(CONFIG_ENV_VARS.productName) || stored.productName || CONFIG_DEFAULTS.productName,
	outputDir: envValue(CONFIG_ENV_VARS.outputDir) || stored.outputDir || CONFIG_DEFAULTS.outputDir,
});

export const writeConfig = (patch: Partial<IAppConfig>): IAppConfig => {
	const next = { ...readConfig(), ...patch };
	const tmp = `${configPath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, '\t')}\n`, 'utf8');
	renameSync(tmp, configPath);
	return next;
};

export const configFilePath = (): string => configPath;
