export interface IChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface IStreamChatOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	messages: IChatMessage[];
	temperature?: number;
	signal?: AbortSignal;
	onDelta: (text: string) => void;
	/** Fired once the upstream accepted the request — before the first content token arrives. */
	onOpen?: () => void;
}

export class GlmApiError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = 'GlmApiError';
		this.status = status;
	}
}

interface IChatCompletionChunk {
	choices?: Array<{ delta?: { content?: string | null } }>;
	error?: { message?: string };
}

interface IChatCompletionError {
	error?: { message?: string };
}

export type IKeyTestResult =
	| { ok: true; model: string; latencyMs: number }
	| { ok: false; message: string };

/** Cheapest reliable proof that a key works and the model is covered: an 8-token completion. */
export const testApiKey = async (options: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): Promise<IKeyTestResult> => {
	if (!options.apiKey.trim()) {
		return { ok: false, message: 'No API key set — paste one first.' };
	}
	const started = Date.now();
	try {
		const endpoint = `${options.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey.trim()}` },
			body: JSON.stringify({
				model: options.model,
				messages: [{ role: 'user', content: 'ping' }],
				max_tokens: 8,
				stream: false,
			}),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			let message = `HTTP ${response.status}`;
			try {
				const parsed = JSON.parse(detail) as IChatCompletionError;
				if (parsed.error?.message) message += `: ${parsed.error.message}`;
			} catch {
				if (detail) message += `: ${detail.slice(0, 200)}`;
			}
			if (response.status === 401) {
				message = '401 — the key itself is invalid. Re-copy it from z.ai.';
			}
			if (response.status === 429) {
				message =
					'429 — this key cannot draw on the Coding Plan. It is most likely a Standard API key: create one under "API Keys → Personal Coding Plan" at z.ai/manage-apikey/apikey-list and use that (Team seats: Team Coding Plan → My Plan).';
			}
			return { ok: false, message };
		}
		return { ok: true, model: options.model, latencyMs: Date.now() - started };
	} catch (err) {
		return { ok: false, message: `Could not reach the API: ${(err as Error).message}` };
	}
};

/**
 * Streams an OpenAI-compatible chat completion (the GLM Coding Plan exposes this shape)
 * and returns the full text while feeding deltas to `onDelta`.
 */
export const streamChatCompletion = async (options: IStreamChatOptions): Promise<string> => {
	const { baseUrl, apiKey, model, messages, temperature = 0.4, signal, onDelta } = options;
	if (!apiKey.trim()) {
		throw new GlmApiError('No GLM API key configured. Open Settings and paste your Coding Plan key.', null);
	}

	const endpoint = `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
			body: JSON.stringify({ model, messages, temperature, stream: true }),
			signal,
		});
	} catch (err) {
		if ((err as Error).name === 'AbortError') throw err;
		throw new GlmApiError(`Could not reach the GLM API at ${endpoint}: ${(err as Error).message}`, null);
	}

	if (!response.ok || !response.body) {
		const detail = await response.text().catch(() => '');
		let message = `GLM API returned HTTP ${response.status}`;
		try {
			const parsed = JSON.parse(detail) as IChatCompletionError;
			if (parsed.error?.message) message += `: ${parsed.error.message}`;
		} catch {
			if (detail) message += `: ${detail.slice(0, 300)}`;
		}
		if (response.status === 401) {
			message = 'GLM API rejected the key (401 Unauthorized). Check the API key in Settings.';
		}
		if (response.status === 429) {
			const retryAfter = response.headers.get('retry-after');
			message = [
				`GLM API refused the request (429): this key cannot draw on a Coding Plan.`,
				'Since Oct 16, 2026 key types are separate — a Standard API Key never consumes plan quota, even on the coding endpoint.',
				'Fix: create a key under "API Keys → Personal Coding Plan" at https://z.ai/manage-apikey/apikey-list and paste that in Settings',
				'(an active plan — Lite/Pro/Max — then covers models like glm-5.3-flash). Otherwise the account may simply be out of API balance.',
			].join(' ') + (retryAfter ? ` Server says retry after ${retryAfter}s.` : '');
		}
		throw new GlmApiError(message, response.status);
	}

	options.onOpen?.();

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let full = '';

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newlineAt = buffer.indexOf('\n');
		while (newlineAt !== -1) {
			const line = buffer.slice(0, newlineAt).trim();
			buffer = buffer.slice(newlineAt + 1);
			if (line.startsWith('data:')) {
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') return full;
				try {
					const chunk = JSON.parse(payload) as IChatCompletionChunk;
					if (chunk.error?.message) {
						throw new GlmApiError(`GLM API error: ${chunk.error.message}`, null);
					}
					const delta = chunk.choices?.[0]?.delta?.content;
					if (delta) {
						full += delta;
						onDelta(delta);
					}
				} catch (err) {
					if (err instanceof GlmApiError) throw err;
					// Keep-alive lines or incomplete frames — skip.
				}
			}
			newlineAt = buffer.indexOf('\n');
		}
	}
	return full;
};
