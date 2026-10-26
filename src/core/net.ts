import { AssetLoadError } from './errors';

const MAX_ATTEMPTS = 3;

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 250 * 2 ** (attempt - 1);
      console.warn('[net] retrying asset fetch', { url, attempt, delayMs, error: lastError });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new AssetLoadError(url, lastError);
}

export async function fetchText(url: string): Promise<string> {
  return (await fetchWithRetry(url)).text();
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetchWithRetry(url);
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    throw new AssetLoadError(url, `invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  return (await fetchWithRetry(url)).arrayBuffer();
}
