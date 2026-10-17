/**
 * PhoneCheck remote MCP server (since v0.2.0). Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies.
 * Adapted from WorkdayAPI src/lib/mcp.js (wave 2 sibling), itself from CertGuard src/mcp.js incl. commit c2606ed
 * (modern 2026-07-28 tool errors keep _meta["phonecheck/error"] next to serverInfo), from DnsGuard (recipe r2).
 *
 * Dual-era and stateless: modern 2026-07-28 (server/discover, tools/list, tools/call with per-request _meta and
 * MCP-Protocol-Version / Mcp-Method / Mcp-Name headers) and legacy (initialize, ping, tools/list, tools/call; batches
 * max 10, at most one tools/call). No sessions, no SSE: GET/DELETE → 405.
 *
 * Auth + limits are NOT implemented here: the router passes authenticate() and runApi() from app.js. runApi() runs the
 * exact POST /v1/parse and GET /v1/example/{country} code (same key gate, per-minute limiters, daily pool, monthly
 * quota). One tools/call = one API call. Numbers are never logged or stored; the MCP path uses POST bodies only.
 * Offline libphonenumber metadata only: no carrier, HLR, porting or reachability lookup.
 */
import { VERSION } from '../version.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1;
export const DISCOVERY_PER_MIN = 120;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
const ERROR_META = 'phonecheck/error';
export const PASS_HEADERS = ['retry-after', 'x-phonecheck-plan', 'x-quota-limit', 'x-quota-remaining', 'x-ratelimit-limit']; // what /v1/* sends
export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': ['mcp-protocol-version', ...PASS_HEADERS].join(', '),
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'phonecheck', title: 'PhoneCheck', version: VERSION };
export const instructions = (L = { anonPerMin: 20, keyPerMin: 300, freePerMonth: 1000 }) => 'PhoneCheck validates and formats phone numbers offline against libphonenumber numbering-plan metadata: E.164, international, national and RFC 3966 formats, region, calling code and the line type from the original allocation. "Valid" means the number matches an allocated range; it does not mean the line is connected, reachable or owned by anyone. No carrier, HLR, porting or live-line lookup is made. Numbers are processed in memory and not stored or logged. Anonymous use is limited to about ' + L.anonPerMin + ' calls per minute per IP; send "Authorization: Bearer <key>" or "X-Api-Key: <key>" with a free pc_live_ key for about ' + L.keyPerMin + ' per minute and ' + L.freePerMonth + ' calls per month. Each tools/call counts as one API call.';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const COUNTRY = (d) => S(d, { pattern: '^[A-Za-z]{2}$', minLength: 2, maxLength: 2 });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PARSE_OUT = { type: 'object', properties: {
  input: { type: 'string' }, default_country: { type: 'string' }, national_number: { type: 'string' }, valid: { type: 'boolean' }, possible: { type: 'boolean' }, e164: { type: 'string' }, international: { type: 'string' },
  national: { type: 'string' }, rfc3966: { type: 'string' }, country: { type: 'string' }, country_name: { type: 'string' }, calling_code: { type: 'string' },
  non_geographic: { type: 'boolean' }, line_type: { type: 'string' }, extension: { type: 'string' }, reason: { type: 'string' }, message: { type: 'string' },
}, required: ['valid'] };

export const TOOLS = [
  {
    name: 'parse_phone_number',
    title: 'Validate and format a phone number (offline)',
    description: 'Validate one phone number offline against libphonenumber metadata and return E.164, international, national and RFC 3966 formats, region, calling code and line type (from the original allocation). Valid means the number fits an allocated range, not that the line is connected or reachable; no carrier/HLR lookup. Read-only. Same engine, keys and limits as POST /v1/parse.',
    inputSchema: { type: 'object', properties: {
      number: S('The phone number, e.g. "+44 20 7946 0018" or "(213) 373-4253". Max 64 characters.', { minLength: 1, maxLength: 64 }),
      default_country: COUNTRY('Optional ISO 3166-1 alpha-2 region used when the number has no +country code, e.g. US, GB.'),
    }, required: ['number'], additionalProperties: false },
    outputSchema: PARSE_OUT,
    annotations: { title: 'Parse phone number', ...RO },
  },
  {
    name: 'get_example_number',
    title: 'Get an example number for a region',
    description: 'Return the libphonenumber example (mobile) number for a region, in all formats, for format testing only (do not dial). Read-only. Same data and limits as GET /v1/example/{country}.',
    inputSchema: { type: 'object', properties: { country: COUNTRY('ISO 3166-1 alpha-2 region code, e.g. US, GB, DE.') }, required: ['country'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { country: { type: 'string' }, country_name: { type: 'string' }, calling_code: { type: 'string' }, line_type: { type: 'string' }, rfc3966: { type: 'string' }, e164: { type: 'string' }, international: { type: 'string' }, national: { type: 'string' }, note: { type: 'string' } } },
    annotations: { title: 'Example number', ...RO },
  },
];
const ROUTE = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const PUBLIC_TOOLS = TOOLS;

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Recursively drop null/undefined so structuredContent never carries a null where the outputSchema expects a type. */
const compact = (v) => {
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => [k, compact(x)]));
  return v;
};
const pick = (o, schema) => Object.fromEntries(Object.entries(compact(o || {})).filter(([k, v]) => Object.prototype.hasOwnProperty.call(schema.properties, k) && typeof v === schema.properties[k].type.replace('integer', 'number')).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 600) : v]));

export function summaryText(name, b) {
  if (name === 'get_example_number') return `Example number for ${b.country}: ${b.international || b.e164} (E.164 ${b.e164}). For format testing only; do not dial.`;
  if (!b.valid) return `Not a valid number${b.possible ? ' (possible length, but not in an allocated range)' : ''}${b.message ? `: ${b.message}` : ''}.`;
  return `Valid number: ${b.e164} (${b.international}; national ${b.national})${b.country ? `, region ${b.country_name || b.country}` : ''}${b.line_type ? `, line type ${b.line_type} (from metadata)` : ''}. Valid means it matches an allocated range, not that the line is connected or reachable.`;
}

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}), ...extra };
}

function checkArgs(tool, args) {
  const props = tool.inputSchema.properties;
  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
  if (unknown.length) return { code: 'invalid_arguments', msg: `Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${Object.keys(props).join(', ')}.` };
  for (const k of tool.inputSchema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') return { code: 'missing_parameter', msg: `Missing required argument "${k}".` };
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > props[k].maxLength) return { code: 'invalid_arguments', msg: `"${k}" must be a string of at most ${props[k].maxLength} characters.` };
  }
  return null;
}

async function callTool(params, deps) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  const tool = typeof name === 'string' && Object.prototype.hasOwnProperty.call(ROUTE, name) ? ROUTE[name] : null;
  if (!tool) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  const bad = checkArgs(tool, args);
  if (bad) return { result: toolError(bad.msg, { code: bad.code, httpStatus: 400 }) };
  const res = name === 'parse_phone_number'
    ? await deps.runApi(deps.request, deps.env, deps.ctx, { method: 'POST', path: '/v1/parse', body: { number: args.number, ...(args.default_country ? { defaultCountry: args.default_country } : {}) } })
    : await deps.runApi(deps.request, deps.env, deps.ctx, { method: 'GET', path: `/v1/example/${encodeURIComponent(args.country)}` });
  const headers = Object.fromEntries(res.headers);
  let body;
  try { body = JSON.parse(await res.text()); } catch { body = {}; }
  if (res.status !== 200) {
    const retry = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    const e = (body && body.error) || {};
    const msg = clip(String(e.message || 'The call could not be completed.'), 600) + (retry ? ` (retry after ${retry} seconds)` : '');
    return { result: toolError(msg, compact({ code: String(e.code || 'error'), httpStatus: res.status, retryAfterSeconds: retry })), headers };
  }
  const out = pick(body, tool.outputSchema);
  return { result: { content: [{ type: 'text', text: clip(summaryText(name, out), 2000) }], structuredContent: out, isError: false }, headers };
}

// ---------- transport helpers ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // Modern results carry serverInfo in _meta; merge so a tool error's _meta["phonecheck/error"] is kept.
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });
  const instr = instructions(deps.limits);

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instr, ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, { ...deps, request });
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...MCP_CORS, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS, ...deps.security } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP-bucket cap on non-check messages (calls are governed by the /v1/* limits inside runApi).
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.ipBucket}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same key gate as /v1/*, evaluated once per HTTP request (bad key → 401 for every method).
  const auth = await deps.authenticate(request, env, ctx);
  if (!auth.ok) {
    // No WWW-Authenticate on /mcp: MCP clients treat a 401 Bearer challenge as "start OAuth discovery", which this
    // server doesn't offer; the JSON-RPC error body (data.code = invalid_api_key) is the useful signal.
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), { ...(auth.headers || {}) });
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.headers) headers = out.headers; // the (single) tools/call's /api headers, for batches too
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of PASS_HEADERS) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
