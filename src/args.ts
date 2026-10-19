export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

export type ArgKind = 'string' | 'string[]' | 'boolean' | 'string?';

export interface IArgsResult {
	values: Record<string, string | string[] | boolean | undefined>;
	positionals: string[];
}

/**
 * Minimal zero-dependency parser shared by every command: `--flag value`, `--flag=value`,
 * repeatable `string[]` flags, bare boolean flags, and a `--` terminator that makes everything
 * after it positional. Unknown options and missing values throw UsageError (exit code 2).
 */
export const parseArgs = (argv: string[], spec: Record<string, ArgKind>): IArgsResult => {
	const values: Record<string, string | string[] | boolean | undefined> = {};
	const positionals: string[] = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--') {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith('--')) {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf('=');
		const name = eq === -1 ? arg : arg.slice(0, eq);
		const kind = spec[name];
		if (!kind) throw new UsageError(`Unknown option ${name}`);
		if (kind === 'boolean') {
			if (eq !== -1) throw new UsageError(`${name} does not take a value`);
			values[name] = true;
			continue;
		}
		const inline = eq === -1 ? null : arg.slice(eq + 1);
		if (kind === 'string?') {
			// optional value: bare flag → '' (the command's default). A following token is only
			// consumed as the value when it is not another option.
			if (inline !== null) {
				values[name] = inline;
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith('--')) {
					values[name] = next;
					i += 1;
				} else {
					values[name] = '';
				}
			}
			continue;
		}
		const value = inline ?? argv[i + 1];
		if (value === undefined || value === '') throw new UsageError(`${name} expects a value`);
		if (inline === null) i += 1;
		if (kind === 'string') {
			values[name] = value;
		} else {
			const list = (values[name] as string[] | undefined) ?? [];
			list.push(value);
			values[name] = list;
		}
	}
	return { values, positionals };
};

export const asString = (values: IArgsResult['values'], name: string): string | undefined => {
	const value = values[name];
	return typeof value === 'string' ? value : undefined;
};

export const asList = (values: IArgsResult['values'], name: string): string[] => {
	const value = values[name];
	return Array.isArray(value) ? value : [];
};

export const asFlag = (values: IArgsResult['values'], name: string): boolean => values[name] === true;
