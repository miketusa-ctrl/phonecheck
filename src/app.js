// PhoneCheck request router. Free of Worker-only imports so it can be unit-tested in Node. Pattern copied from
// CheckDigit (gate -> per-IP / per-key rate limit -> daily pool -> monthly quota).
// Privacy: numbers are parsed in memory and returned to the caller only. Nothing here logs (no console.*), nothing
// makes a subrequest, and the only things stored are counters (per-key monthly usage, global daily totals).
import { parseNumber, normalizeCountry, exampleFor, COUNTRIES, METADATA_VERSION, MAX_NUMBER_LENGTH, LINE_TYPES } from './lib/phone.js';
import { extractApiKey, lookupKey, peekKey, StorageError } from './lib/keys.js';
import { consumeMonthlyQuota, QuotaUnavailable, secondsToNextUtcMonth } from './lib/quota.js';
import { budgetAllows, budgetRecord, secondsToUtcMidnight } from './lib/budget.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, glamaJson } from './lib/agentdocs.js';
import { VERSION } from './version.js';
import { readBodyCapped, declaredTooLarge, tooLarge, BodyError, MAX_SINGLE_BODY_BYTES, MAX_BULK_BODY_BYTES } from './lib/body.js';

export { VERSION };
export const BULK_MAX = 500; // v0.1.1: cold 1000-number bulk hit ~85 ms once (cpu_ms=50); 500 matches CheckDigit and stays under cold
export const DISCLAIMER = 'PhoneCheck checks numbers offline against libphonenumber numbering-plan metadata. "Valid" means the number matches a range allocated in that metadata; it does not mean the line is connected, reachable, or owned by anyone in particular. No carrier, HLR, porting or live-line lookup is made, so line type reflects the original allocation (a ported number may differ).';
export const PRIVACY = 'Numbers are processed in memory to build the response and are not stored or logged. Only request counts are kept (per API key per month, and a global daily total). Workers observability/logging is off. Use POST so numbers stay out of URLs.';

// Defaults mirror wrangler.toml [vars]. The per-minute values must match the ratelimit bindings' simple.limit
// (the binding enforces; these drive messages and the in-isolate fallback when a binding is missing).
export const DEFAULT_LIMITS = {
  anonPerMin: 20, // VALIDATE_LIMIT_PER_MIN / VALIDATE_LIMITER (per IP)
  keyPerMin: 300, // KEY_LIMIT_PER_MIN / KEY_LIMITER (per API key)
  freePerMonth: 1000, // FREE_MONTHLY_QUOTA (KeyQuota DO, exact)
  proPerMonth: 50000, // PRO_MONTHLY_QUOTA (KeyQuota DO, exact; a bulk call counts one per number)
  callsPerDay: 15000, // DAILY_CALL_POOL: global daily soft cap, all requests (approximate)
  anonPerDay: 10000, // DAILY_ANON_POOL: anonymous share of the pool
};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
export function limitsFor(env = {}) {
  const L = DEFAULT_LIMITS;
  return {
    anonPerMin: num(env.VALIDATE_LIMIT_PER_MIN, L.anonPerMin),
    keyPerMin: num(env.KEY_LIMIT_PER_MIN, L.keyPerMin),
    freePerMonth: num(env.FREE_MONTHLY_QUOTA, L.freePerMonth),
    proPerMonth: num(env.PRO_MONTHLY_QUOTA, L.proPerMonth),
    callsPerDay: num(env.DAILY_CALL_POOL, L.callsPerDay),
    anonPerDay: num(env.DAILY_ANON_POOL, L.anonPerDay),
  };
}
const fmt = (n) => n.toLocaleString('en-US');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key',
  'access-control-expose-headers': 'retry-after, x-phonecheck-plan, x-quota-limit, x-quota-remaining, x-ratelimit-limit',
  'access-control-max-age': '86400',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const staging = (env) => String(env.PUBLIC_LAUNCH || 'false') !== 'true';

function withHygiene(headers, env) {
  if (staging(env)) headers['x-robots-tag'] = 'noindex, nofollow';
  return headers;
}
function json(env, body, status = 200, extra = {}, pretty = true) {
  return new Response(pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body), {
    status,
    headers: withHygiene({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...SECURITY, ...extra }, env),
  });
}
const apiError = (env, status, code, message, extra) => json(env, { error: { code, message } }, status, extra);

function page(env, body, type, status = 200, cache = 'public, max-age=300') {
  return new Response(body, {
    status,
    headers: withHygiene({ 'content-type': type, 'cache-control': cache, 'content-security-policy': CSP, ...SECURITY }, env),
  });
}

// Per-isolate fallback limiter (best effort; the Workers Rate Limiting binding is authoritative when bound).
const memLimits = new Map();
export function clearMemLimits() { memLimits.clear(); }
function memLimit(key, limit, periodMs) {
  const now = Date.now();
  const e = memLimits.get(key);
  if (!e || now - e.start > periodMs) {
    if (memLimits.size > 5000) memLimits.clear();
    memLimits.set(key, { start: now, n: 1 });
    return true;
  }
  e.n++;
  return e.n <= limit;
}
// Buckets: 'key' -> KEY_LIMITER (per API key); 'ip' (anonymous calls) and 'auth' (API-key lookups that need KV, and
// failed auth) -> VALIDATE_LIMITER, per IP.
async function isRateLimited(env, bucket, id, limit) {
  const binding = bucket === 'key' ? env.KEY_LIMITER : env.VALIDATE_LIMITER;
  const key = `${bucket}:${id}`;
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return !success; } catch { /* fall back */ }
  }
  return !memLimit(key, limit, 60_000);
}

// Anonymous limiter key: IPv4 as is, IPv6 -> its /64 (v0.2.0, recipe §1; same output as workdayapi/certguard ipBucket).
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1);
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}
const clientIp = (request) => ipBucket(request.headers.get('cf-connecting-ip') || 'unknown-client');

/** Key gate shared by /v1/* and /mcp. { ok:true, rec } (rec null = anonymous) | { ok:false, status, code, message, headers }. Never echoes the key. */
export async function authenticate(request, env, L = limitsFor(env)) {
  const raw = extractApiKey(request);
  if (raw === null) return { ok: true, rec: null };
  const fail = (status, code, message, headers = {}) => ({ ok: false, status, code, message, headers });
  const authLimited = () => isRateLimited(env, 'auth', clientIp(request), L.anonPerMin);
  const authTooMany = () => fail(429, 'rate_limited', `Too many API key checks from this IP address (limit ${L.anonPerMin} per minute for new or unrecognised keys). Retry in about a minute.`, { 'retry-after': '60', 'x-ratelimit-limit': String(L.anonPerMin) });
  const peek = await peekKey(env.KEYS, raw);
  if (!peek.hit && await authLimited()) return authTooMany();
  let rec;
  try { rec = peek.hit ? peek.rec : await lookupKey(env.KEYS, raw); } catch (e) {
    if (e instanceof StorageError) return fail(503, 'storage_unavailable', 'Key lookup is temporarily unavailable. Retry shortly, or call without a key (anonymous limits apply).', { 'retry-after': '30' });
    throw e;
  }
  if (!rec) {
    if (peek.hit && await authLimited()) return authTooMany();
    return fail(401, 'invalid_api_key', 'API key not recognised. Send it as "Authorization: Bearer pc_live_..." or "X-Api-Key", or omit it to use the anonymous tier.');
  }
  return { ok: true, rec };
}

/** Authenticate + rate-limit. Returns { rec } (rec null = anonymous) or { response }. */
async function gate(request, env, L, { needPaid = false, what = 'POST /v1/bulk' } = {}) {
  const a = await authenticate(request, env, L);
  if (!a.ok) return { response: apiError(env, a.status, a.code, a.message, a.headers) };
  const rec = a.rec;
  if (needPaid) {
    if (!rec) return { response: apiError(env, 401, 'api_key_required', `${what} requires a paid (Pro) API key.`) };
    if (rec.plan !== 'pro') return { response: apiError(env, 403, 'paid_plan_required', `${what} is available on the Pro plan only. Free keys can use POST /v1/parse (one number per request).`, { 'x-phonecheck-plan': rec.plan }) };
  }
  const limited = rec
    ? await isRateLimited(env, 'key', rec.keyId, L.keyPerMin)
    : await isRateLimited(env, 'ip', clientIp(request), L.anonPerMin);
  if (limited) {
    const per = rec ? `${L.keyPerMin} requests per minute per API key` : `${L.anonPerMin} requests per minute per IP address without an API key`;
    return { response: apiError(env, 429, 'rate_limited', `Rate limit reached (${per}). Retry in about a minute.`, { 'retry-after': '60', 'x-ratelimit-limit': String(rec ? L.keyPerMin : L.anonPerMin) }) };
  }
  return { rec };
}

/** Daily pool (one unit per request) + monthly key quota (`units` = numbers in the request). */
async function chargeQuotaAndPool(env, ctx, L, rec, units) {
  const kind = rec ? 'key' : 'anon';
  const pool = budgetAllows(kind, L);
  if (!pool.ok) {
    const msg = pool.pool === 'anon'
      ? 'The free anonymous capacity for today is used up. Use an API key, or try again after 00:00 UTC.'
      : 'PhoneCheck has reached its daily capacity. Try again after 00:00 UTC.';
    return { response: apiError(env, 429, 'daily_capacity_reached', msg, { 'retry-after': String(secondsToUtcMidnight()) }) };
  }
  const headers = {};
  if (rec) {
    const limit = rec.plan === 'pro' ? L.proPerMonth : L.freePerMonth;
    headers['x-phonecheck-plan'] = rec.plan;
    headers['x-quota-limit'] = String(limit);
    try {
      const q = await consumeMonthlyQuota(env.QUOTA, `key:${rec.keyId}`, limit, units);
      if (!q.ok) {
        const left = Math.max(0, q.limit - q.used);
        const msg = units > 1 && left > 0
          ? `This bulk request needs ${fmt(units)} calls but only ${fmt(left)} remain in this month's quota of ${fmt(limit)}.`
          : `Monthly quota of ${fmt(limit)} calls used up for ${q.month} (UTC). It resets on the 1st of next month.`;
        return { response: apiError(env, 429, 'monthly_quota_exceeded', msg, { ...headers, 'x-quota-remaining': String(left), 'retry-after': String(secondsToNextUtcMonth()) }) };
      }
      headers['x-quota-remaining'] = String(Math.max(0, q.limit - q.used));
    } catch (e) {
      if (!(e instanceof QuotaUnavailable)) throw e;
      headers['x-quota-remaining'] = 'unavailable'; // fail open: rate limits + daily pool still apply
    }
  }
  budgetRecord(kind, env.QUOTA, ctx);
  return { headers };
}

function decodePath(rest) {
  try { return decodeURIComponent(rest); } catch { return null; }
}

function meta(env, L) {
  return {
    service: 'PhoneCheck',
    version: VERSION,
    build: env.BUILD_SHA || 'unknown', // git commit the deployed code was built from (set by scripts/deploy.sh)
    built_at: env.BUILD_TIME || null,
    staging: staging(env),
    disclaimer: DISCLAIMER,
    privacy: PRIVACY,
    metadata: { library: 'libphonenumber-js', version: METADATA_VERSION, set: 'max', regions: Object.keys(COUNTRIES).length, offline: true, carrier_lookup: false, hlr_lookup: false },
    line_types: Object.values(LINE_TYPES),
    endpoints: staging(env)
      ? ['POST /v1/parse', 'GET /v1/parse/{number}', 'POST /v1/bulk', 'GET /v1/example/{country}', 'GET /v1/countries', 'GET /v1/meta']
      : ['POST /v1/parse', 'POST /v1/bulk', 'GET /v1/example/{country}', 'GET /v1/countries', 'GET /v1/meta'],
    recommended: staging(env)
      ? 'POST /v1/parse with JSON {"number": "...", "defaultCountry": "US"} keeps the number out of URLs and logs. GET /v1/parse/{number} exists for quick tests on staging.'
      : 'POST /v1/parse with JSON {"number": "...", "defaultCountry": "US"} keeps the number out of URLs and logs. GET /v1/parse/{number} is disabled in production.',
    limits: {
      max_number_length: MAX_NUMBER_LENGTH,
      single_body_max_bytes: MAX_SINGLE_BODY_BYTES,
      bulk_body_max_bytes: MAX_BULK_BODY_BYTES,
      bulk_max_numbers: BULK_MAX,
      bulk_plan: 'pro',
      anonymous_per_minute_per_ip: L.anonPerMin,
      api_key_per_minute: L.keyPerMin,
      free_key_calls_per_month: L.freePerMonth,
      pro_key_calls_per_month: L.proPerMonth,
      bulk_quota_note: 'A bulk request counts one call per number toward the monthly quota.',
      daily_capacity_note: 'A global daily soft cap protects the service; if it is reached, requests get 429 daily_capacity_reached until 00:00 UTC.',
    },
  };
}

function robots(env) {
  return staging(env) ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\nDisallow: /v1/\n';
}

/** Parse a JSON body into an object, or return an error response. */
function parseJsonObject(env, text, example) {
  let body;
  try { body = JSON.parse(text); } catch { return { response: apiError(env, 400, 'invalid_json', `Body must be JSON, e.g. ${example}`) }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { response: apiError(env, 400, 'invalid_body', `Body must be a JSON object, e.g. ${example}`) };
  return { body };
}
const countryError = (env) => apiError(env, 400, 'invalid_default_country', 'defaultCountry must be an ISO 3166-1 alpha-2 region code supported by the metadata (e.g. "US", "GB", "DE"). See GET /v1/countries.');

// --- no-JS form (POST /) ---------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const LT_NAMES = { mobile: 'Mobile', fixed_line: 'Fixed line', fixed_line_or_mobile: 'Fixed line or mobile', toll_free: 'Toll-free', premium_rate: 'Premium rate', shared_cost: 'Shared cost', voip: 'VoIP', personal_number: 'Personal number', pager: 'Pager', uan: 'UAN (company number)', voicemail: 'Voicemail' };
export function renderResultHtml(r) {
  const rows = [
    ['E.164', r.e164], ['International', r.international], ['National', r.national], ['RFC 3966', r.rfc3966],
    ['Region', r.country ? `${r.country_name} (${r.country})` : (r.non_geographic ? 'Non-geographic (global service)' : null)],
    ['Calling code', r.calling_code ? `+${r.calling_code}` : null], ['Line type (from metadata)', r.line_type ? LT_NAMES[r.line_type] || r.line_type : null],
    ['Extension', r.extension],
  ].filter(([, v]) => v);
  const title = r.valid ? 'Valid number' : (r.possible ? 'Possible but not valid' : 'Not a valid number');
  return `<div class="verdict ${r.valid ? 'ok' : 'bad'}"><div class="title">${esc(title)}</div>` +
    (r.message ? `<div class="reason">Reason: ${esc(r.message)}</div>` : '<div class="reason">Matches an allocated number range. This does not prove the line is connected or reachable.</div>') +
    (rows.length ? `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : '') + '</div>';
}

export function createApp({ pages }) {
  const banner = '<div class="staging" role="note">Staging preview. Not public yet. Results and limits may change.</div>';
  const render = (env, html, result = '') => html.replace('<!--STAGING-->', staging(env) ? banner : '').replace('<!--RESULT-->', result);

  async function formPost(request, env, ctx, L) {
    const htmlErr = (status, msg) => page(env, render(env, pages.index, `<p class="error">${esc(msg)}</p>`), 'text/html; charset=utf-8', status, 'no-store');
    if (declaredTooLarge(request, MAX_SINGLE_BODY_BYTES)) return htmlErr(413, 'Request too large.');
    const g = await gate(request, env, L);
    if (g.response) return htmlErr(g.response.status, (await g.response.json()).error.message);
    const params = new URLSearchParams(await readBodyCapped(request, MAX_SINGLE_BODY_BYTES));
    const number = (params.get('number') || '').trim();
    const dc = normalizeCountry(params.get('country') || '');
    if (!number) return htmlErr(400, 'Enter a phone number.');
    if (!dc.ok) return htmlErr(400, 'Unknown default country.');
    const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, 1);
    if (charged.response) return htmlErr(charged.response.status, (await charged.response.json()).error.message);
    return page(env, render(env, pages.index, renderResultHtml(parseNumber(number, dc.country, { example: false }))), 'text/html; charset=utf-8', 200, 'no-store');
  }

  // Internal call into the exact /v1/* route (same gate, limiters, pool, quota) for MCP tools. Only the caller's
  // key + client IP headers are forwarded; the number travels in a POST body, never a URL.
  function runApi(request, env, ctx, { method, path, body }) {
    const h = new Headers({ 'content-type': 'application/json' });
    for (const k of ['authorization', 'x-api-key', 'cf-connecting-ip']) { const v = request.headers.get(k); if (v !== null) h.set(k, v); }
    return handle(new Request(new URL(path, request.url), { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  }

  async function handle(request, env = {}, ctx = undefined) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const L = limitsFor(env);

    if (path === '/mcp') {
      return handleMcp(request, env, ctx, { authenticate: (r, e) => authenticate(r, e, L), runApi, ipBucket: clientIp(request), memLimit, origin: url.origin, allowedOrigins: env.MCP_ALLOWED_ORIGINS, limits: L, security: withHygiene({ ...SECURITY }, env) });
    }
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: withHygiene({ ...CORS }, env) });

    try {
      if (!path.startsWith('/v1/')) {
        if (method === 'POST' && (path === '/' || path === '/index.html')) return await formPost(request, env, ctx, L);
        if (method !== 'GET' && method !== 'HEAD') return page(env, 'Method not allowed\n', 'text/plain; charset=utf-8', 405);
        if (path === '/' || path === '/index.html') return page(env, render(env, pages.index), 'text/html; charset=utf-8');
        if (path === '/docs' || path === '/docs/') return page(env, render(env, pages.docs), 'text/html; charset=utf-8');
        if (path === '/privacy' || path === '/privacy/') return new Response(null, { status: 301, headers: withHygiene({ location: '/docs#privacy', 'cache-control': 'public, max-age=3600', ...SECURITY }, env) });
        if (path === '/style.css') return page(env, pages.css, 'text/css; charset=utf-8');
        if (path === '/app.js') return page(env, pages.js, 'text/javascript; charset=utf-8');
        const X = { bulkMax: BULK_MAX, prodGetDisabled: !staging(env) };
        if (path === '/llms.txt') return page(env, llmsTxt(url.origin, L, X), 'text/plain; charset=utf-8', 200, 'public, max-age=3600');
        if (path === '/openapi.json') return page(env, JSON.stringify(openApiSpec(url.origin, L, X), null, 2), 'application/json; charset=utf-8', 200, 'public, max-age=3600');
        if (path === '/.well-known/mcp-registry-auth') {
          const v = String(env.MCP_REGISTRY_AUTH || '');
          if (/^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(v)) return page(env, v, 'text/plain; charset=utf-8', 200, 'no-store');
          return page(env, 'Not found\n', 'text/plain; charset=utf-8', 404, 'no-store');
        }
        if (path === '/.well-known/glama.json') return page(env, glamaJson(), 'application/json; charset=utf-8', 200, 'public, max-age=3600');
        if (path === '/robots.txt') return page(env, robots(env), 'text/plain; charset=utf-8');
        if (path === '/favicon.ico') return new Response(null, { status: 204, headers: withHygiene({ 'cache-control': 'public, max-age=86400' }, env) });
        return page(env, 'Not found\n', 'text/plain; charset=utf-8', 404, 'no-store');
      }

      if (path === '/v1/bulk') {
        if (method !== 'POST') return apiError(env, 405, 'method_not_allowed', 'Use POST for /v1/bulk.', { allow: 'POST, OPTIONS' });
        if (declaredTooLarge(request, MAX_BULK_BODY_BYTES)) throw tooLarge(MAX_BULK_BODY_BYTES);
        const g = await gate(request, env, L, { needPaid: true });
        if (g.response) return g.response;
        const text = await readBodyCapped(request, MAX_BULK_BODY_BYTES);
        const ex = '{"numbers": ["+1 213 373 4253", "020 7946 0018"], "defaultCountry": "GB"}';
        const pj = parseJsonObject(env, text, ex);
        if (pj.response) return pj.response;
        const numbers = Array.isArray(pj.body.numbers) ? pj.body.numbers : null;
        if (!numbers) return apiError(env, 400, 'invalid_bulk', `Body must be a JSON object with a "numbers" array, e.g. ${ex}`);
        if (numbers.length === 0) return apiError(env, 400, 'empty_bulk', 'The "numbers" array is empty.');
        if (numbers.length > BULK_MAX) return apiError(env, 400, 'bulk_too_large', `A bulk request can hold at most ${fmt(BULK_MAX)} numbers (got ${fmt(numbers.length)}). Split it into several requests.`);
        const dc = normalizeCountry(pj.body.defaultCountry);
        if (!dc.ok) return countryError(env);
        const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, numbers.length);
        if (charged.response) return charged.response;
        const results = numbers.map((item, index) => bulkItem(item, index, dc.country));
        const validCount = results.filter((r) => r.valid).length;
        const unique = new Set(results.filter((r) => r.valid).map((r) => r.e164)).size;
        return json(env, { count: results.length, valid_count: validCount, invalid_count: results.length - validCount, unique_valid_e164: unique, default_country: dc.country, results }, 200, charged.headers, false);
      }

      const parseRoute = path.match(/^\/v1\/parse(?:\/(.*))?$/);

      if (method === 'POST' && parseRoute) {
        if (parseRoute[1]) return apiError(env, 400, 'number_in_url', 'With POST, send the number in the JSON body and leave it out of the URL: POST /v1/parse {"number": "..."}');
        if (declaredTooLarge(request, MAX_SINGLE_BODY_BYTES)) throw tooLarge(MAX_SINGLE_BODY_BYTES);
        const g = await gate(request, env, L);
        if (g.response) return g.response;
        const text = await readBodyCapped(request, MAX_SINGLE_BODY_BYTES);
        const ex = '{"number": "020 7946 0018", "defaultCountry": "GB"}';
        const pj = parseJsonObject(env, text, ex);
        if (pj.response) return pj.response;
        const number = pj.body.number;
        if (typeof number !== 'string' || !number.trim()) return apiError(env, 400, 'missing_number', `Body must have a "number" string, e.g. ${ex}`);
        if (number.length > MAX_NUMBER_LENGTH) return apiError(env, 400, 'input_too_long', `Numbers are at most ${MAX_NUMBER_LENGTH} characters.`);
        const dc = normalizeCountry(pj.body.defaultCountry);
        if (!dc.ok) return countryError(env);
        const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, 1);
        if (charged.response) return charged.response;
        return json(env, parseNumber(number, dc.country), 200, charged.headers);
      }

      if (method !== 'GET' && method !== 'HEAD') {
        const known = parseRoute || /^\/v1\/(meta|countries|example(\/.*)?)\/?$/.test(path);
        if (!known) return apiError(env, 404, 'not_found', 'Unknown endpoint. See /docs or GET /v1/meta.');
        return apiError(env, 405, 'method_not_allowed', 'Use POST /v1/parse {"number": "..."} or GET /v1/parse/{number}, POST for /v1/bulk, GET for /v1/meta, /v1/countries and /v1/example/{country}.', { allow: parseRoute ? 'GET, HEAD, POST, OPTIONS' : 'GET, HEAD, OPTIONS' });
      }

      if (path === '/v1/meta' || path === '/v1/meta/') {
        const g = await gate(request, env, L);
        if (g.response) return g.response;
        return json(env, meta(env, L));
      }

      if (path === '/v1/countries' || path === '/v1/countries/') {
        const g = await gate(request, env, L);
        if (g.response) return g.response;
        return json(env, { count: Object.keys(COUNTRIES).length, countries: Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, calling_code: c.calling_code })) }, 200, { 'cache-control': 'public, max-age=3600' }, false);
      }

      const exRoute = path.match(/^\/v1\/example\/([^/]*)\/?$/);
      if (exRoute) {
        const g = await gate(request, env, L);
        if (g.response) return g.response;
        const c = (decodePath(exRoute[1]) || '').toUpperCase();
        const ex = exampleFor(c);
        if (!ex) return apiError(env, 404, 'unknown_country', 'Unknown or unsupported region code. Use an ISO 3166-1 alpha-2 code such as US, GB or DE (GET /v1/countries lists them).');
        return json(env, { ...ex, note: 'Example numbers come from the libphonenumber metadata (mobile examples). They are for format testing only; do not dial them.' }, 200, { 'cache-control': 'public, max-age=3600' });
      }

      if (!parseRoute) return apiError(env, 404, 'not_found', 'Unknown endpoint. See /docs or GET /v1/meta.');
      // Production (PUBLIC_LAUNCH=true) disables GET parse so numbers never land in URL paths/logs.
      if (!staging(env)) {
        return apiError(env, 405, 'method_not_allowed', 'GET /v1/parse/{number} is disabled in production (numbers in URLs end up in logs). Use POST /v1/parse with JSON {"number": "..."}.', { allow: 'POST, OPTIONS' });
      }
      const number = decodePath(parseRoute[1] || '');
      if (number === null) return apiError(env, 400, 'bad_encoding', 'The number is not valid percent-encoding.');
      if (!number.trim()) return apiError(env, 400, 'missing_number', 'Use POST /v1/parse with {"number": "..."} (recommended), or put the number in the path: /v1/parse/%2B12133734253');
      if (number.length > MAX_NUMBER_LENGTH) return apiError(env, 400, 'input_too_long', `Numbers are at most ${MAX_NUMBER_LENGTH} characters.`);
      const dc = normalizeCountry(url.searchParams.get('defaultCountry') || url.searchParams.get('country') || '');
      if (!dc.ok) return countryError(env);
      const g = await gate(request, env, L);
      if (g.response) return g.response;
      const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, 1);
      if (charged.response) return charged.response;
      return json(env, parseNumber(number, dc.country), 200, charged.headers);
    } catch (e) {
      if (e instanceof BodyError) return apiError(env, e.status, e.code, e.message);
      return apiError(env, 500, 'internal_error', 'Something went wrong. Please retry.');
    }
  }
  return handle;
}

function bulkItem(item, index, defaultCountry) {
  let number = item, dc = defaultCountry;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    number = item.number;
    if (item.defaultCountry !== undefined) {
      const n = normalizeCountry(item.defaultCountry);
      if (!n.ok) return { index, valid: false, error: 'invalid_default_country', reason: 'defaultCountry must be a supported ISO 3166-1 alpha-2 code' };
      dc = n.country;
    }
  }
  if (typeof number !== 'string') return { index, valid: false, error: 'invalid_item', reason: 'each item must be a string or {"number": "...", "defaultCountry": "..."}' };
  if (number.length > MAX_NUMBER_LENGTH) return { index, valid: false, error: 'input_too_long', reason: `numbers are at most ${MAX_NUMBER_LENGTH} characters` };
  return { index, ...parseNumber(number, dc, { example: false }) };
}
