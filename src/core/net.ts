import { AssetLoadError } from './errors';

const MAX_ATTEMPTS = 3;

export interface FetchOptions {
  signal?: AbortSignal;
  /** Bounds the complete request, including response decoding. Default 30000 ms. */
  timeoutMs?: number;
}

function requestSignal(options: FetchOptions): AbortSignal {
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout <= 0) throw new RangeError('Asset timeout must be a positive integer');
  const deadline = AbortSignal.timeout(timeout);
  return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
}

async function fetchWithRetry(url: string, signal: AbortSignal): Promise<Response> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      signal.throwIfAborted();
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      if (signal.aborted) throw new AssetLoadError(url, signal.reason instanceof Error ? signal.reason.message : 'request aborted');
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 250 * 2 ** (attempt - 1);
      console.warn('[net] retrying asset fetch', { url, attempt, delayMs, error: lastError });
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { clearTimeout(timer); reject(new AssetLoadError(url, 'request aborted during retry')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  throw new AssetLoadError(url, lastError);
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await fetchWithRetry(url, requestSignal(options));
  try { return await response.text(); }
  catch (error) { throw new AssetLoadError(url, error instanceof Error ? error.message : 'text decoding failed'); }
}

export async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const res = await fetchWithRetry(url, requestSignal(options));
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    throw new AssetLoadError(url, `invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function fetchBuffer(url: string, options: FetchOptions = {}): Promise<ArrayBuffer> {
  const response = await fetchWithRetry(url, requestSignal(options));
  try { return await response.arrayBuffer(); }
  catch (error) { throw new AssetLoadError(url, error instanceof Error ? error.message : 'buffer decoding failed'); }
}
