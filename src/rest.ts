/** Shared fetch plumbing for the token-based REST providers (GitHub API, GitLab API). */

const DEFAULT_TIMEOUT_MS = 30_000;

export class RestError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'RestError';
		this.status = status;
	}
}

export const buildUrl = (base: string, apiPath: string, query?: Record<string, string | number | undefined>): string => {
	const url = new URL(apiPath, base.endsWith('/') ? base : `${base}/`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
};

interface IApiErrorBody {
	message?: string;
	error?: string;
	error_description?: string;
}

/** GET one JSON document; non-2xx and network failures become RestError with a usable message. */
export const restGetJson = async (
	url: string,
	headers: Record<string, string>,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		const text = await response.text();
		if (!response.ok) {
			let detail = '';
			try {
				const parsed = JSON.parse(text) as IApiErrorBody;
				detail = parsed.message ?? parsed.error ?? parsed.error_description ?? '';
			} catch {
				detail = text.slice(0, 200);
			}
			throw new RestError(`HTTP ${response.status} for ${url}${detail ? ` — ${detail}` : ''}`, response.status);
		}
		return text.trim() ? (JSON.parse(text) as unknown) : null;
	} catch (err) {
		if (err instanceof RestError) throw err;
		if ((err as Error).name === 'AbortError') throw new RestError(`Request timed out after ${timeoutMs} ms: ${url}`, 0);
		throw new RestError(`${(err as Error).message} (${url})`, 0);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Collects every page of a paginated collection endpoint. `getPage` receives the 1-based page
 * number and returns the items; the loop stops on a short page or at `limit`.
 */
export const collectPages = async <T>(getPage: (page: number) => Promise<T[]>, limit: number): Promise<T[]> => {
	const items: T[] = [];
	const pageSize = 100;
	for (let page = 1; items.length < limit; page += 1) {
		const batch = await getPage(page);
		items.push(...batch);
		if (batch.length < pageSize) break;
	}
	return items.slice(0, limit);
};
