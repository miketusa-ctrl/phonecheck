// API keys (read-only on the hot path). Copied from CheckDigit (same storage pattern as DnsGuard): KV "key:<sha256(raw)>" -> JSON record,
// raw keys are never stored. v0.1 has no self-serve sign-up: keys are issued by the operator with
// scripts/mint-key.mjs (prints the raw key once + the `wrangler kv key put` command).
// Record: { keyId, plan: "free" | "pro", createdAt }  (no email or other personal data is required)

export const KEY_PREFIX = 'pc_live_';
const KEY_BODY_RE = /^[a-f0-9]{64}$/;

export class StorageError extends Error {
  constructor(op, cause) {
    super(`KV ${op} failed${cause && cause.message ? `: ${cause.message}` : ''}`);
    this.code = 'storage_unavailable';
  }
}

export function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return KEY_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isKeyFormat(raw) {
  return typeof raw === 'string' && raw.startsWith(KEY_PREFIX) && KEY_BODY_RE.test(raw.slice(KEY_PREFIX.length));
}

export async function hashApiKey(raw) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function extractApiKey(request) {
  const auth = request.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
    return m ? m[1] : auth.trim(); // a malformed header is treated as an (invalid) key, never silently ignored
  }
  const x = request.headers.get('x-api-key');
  return x ? x.trim() : null;
}

const cache = new Map();
const TTL_MS = 60_000;
export function clearKeyCache() { cache.clear(); }

/**
 * Cache-only check, no KV read. Returns { hit: true, rec } when the answer is known without KV (malformed key, or a
 * positive/negative cache entry younger than 60 s), else { hit: false }. Used to rate-limit KV lookups per IP.
 */
export async function peekKey(kv, raw) {
  if (!kv || !isKeyFormat(raw)) return { hit: true, rec: null };
  const c = cache.get(await hashApiKey(raw));
  return c && Date.now() - c.t < TTL_MS ? { hit: true, rec: c.rec } : { hit: false };
}

/** Look up a key. Returns the record or null. Positive AND negative results are cached 60 s per isolate. */
export async function lookupKey(kv, raw) {
  if (!kv || !isKeyFormat(raw)) return null;
  const hash = await hashApiKey(raw);
  const c = cache.get(hash);
  if (c && Date.now() - c.t < TTL_MS) return c.rec;
  let stored;
  try { stored = await kv.get(`key:${hash}`, 'json'); } catch (e) { throw new StorageError('get', e); }
  const rec = stored && typeof stored === 'object'
    ? { keyId: stored.keyId || hash.slice(0, 16), plan: stored.plan === 'pro' ? 'pro' : 'free' }
    : null;
  cache.set(hash, { t: Date.now(), rec });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return rec;
}
