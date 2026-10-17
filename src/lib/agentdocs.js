// llms.txt + OpenAPI 3.1, generated from code constants and limitsFor(env) (agent-ready recipe §3/§4). No number
// is hard-coded twice; drift tests in test/agent.test.js keep these in sync with the router.
import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES } from './mcp.js';
import { VERSION } from '../version.js';

export const CONTACT = 'digitalpromohub.support@gmail.com';
export const mcpClientConfig = (origin) => ({ mcpServers: { phonecheck: { type: 'http', url: `${origin}/mcp` } } });

export const llmsTxt = (origin, L, X) => `# PhoneCheck

> Offline phone-number validation and formatting (libphonenumber metadata): E.164, international, national and RFC 3966 formats, region, calling code and allocated line type. Public JSON API plus a remote MCP server for AI agents. No carrier, HLR, porting or reachability lookup; numbers are not stored or logged.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tools: ${TOOLS.map((t) => `\`${t.name}\` (${Object.keys(t.inputSchema.properties).join(', ')})`).join(', ')}. Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [Docs](${origin}/docs): human-readable API docs

## JSON API

- \`POST ${origin}/v1/parse\` with JSON \`{"number": "+44 20 7946 0018", "defaultCountry": "GB"}\`: validity, formats, region, calling code, line type. Send numbers in the POST body only${X.prodGetDisabled ? ' (GET /v1/parse/{number} returns 405)' : ''}. "Valid" means the number matches an allocated range, not that the line is connected or reachable.
- \`POST ${origin}/v1/bulk\`: up to ${X.bulkMax} numbers per request, Pro keys only (Pro is not on sale yet).
- \`GET ${origin}/v1/example/{country}\`, \`GET ${origin}/v1/countries\`, \`GET ${origin}/v1/meta\`.
- Errors: { "error": { "code", "message" } } with 400 (invalid_json, invalid_body, missing_number, input_too_long, invalid_default_country, number_in_url, bad_encoding, invalid_bulk, empty_bulk, bulk_too_large), 401 (invalid_api_key, api_key_required), 403 (paid_plan_required), 404 (not_found, unknown_country), 405 (method_not_allowed), 413 (body_too_large), 429 (rate_limited, daily_capacity_reached, monthly_quota_exceeded), 503 (storage_unavailable).

## Limits, keys and pricing

- Anonymous: about ${L.anonPerMin}/min per IP. Free key: about ${L.keyPerMin}/min and ${L.freePerMonth} calls per month (send \`Authorization: Bearer pc_live_...\` or \`X-Api-Key\`). Pro (planned, not on sale): ${L.proPerMonth} calls per month and bulk. A global daily soft cap applies. The MCP endpoint uses the same keys and counters: each \`tools/call\` is one call. Non-call messages don't count as calls, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After).

## Optional

- [Privacy](${origin}/docs#privacy)
- Contact: ${CONTACT}
`;

const errSchema = { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] };
const resp = (d) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const H = (d) => ({ description: d, schema: { type: 'string' } });
const okHeaders = { 'x-phonecheck-plan': H('Key plan (free or pro), keyed calls only'), 'x-quota-limit': H('Monthly quota, keyed calls only'), 'x-quota-remaining': H('Calls left this month, keyed calls only') };
const limHeaders = { 'retry-after': H('Seconds to wait'), 'x-ratelimit-limit': H('Per-minute limit that was hit') };
const r429 = { description: 'rate_limited, daily_capacity_reached or monthly_quota_exceeded', headers: limHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

export function openApiSpec(origin, L, X) {
  const parseRes = { type: 'object', properties: Object.fromEntries(Object.entries(TOOLS[0].outputSchema.properties)) };
  const paths = {
    '/v1/parse': { post: {
      operationId: 'parsePhoneNumber', summary: 'Validate and format one number (offline metadata; no carrier/HLR lookup)',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { number: { type: 'string', maxLength: 64 }, defaultCountry: { type: 'string', pattern: '^[A-Za-z]{2}$', maxLength: 2 } }, required: ['number'] } } } },
      responses: { 200: { description: 'Parsed (valid may be false)', headers: okHeaders, content: { 'application/json': { schema: parseRes } } }, 400: resp('Bad input'), 401: resp('invalid_api_key'), 413: resp('body_too_large'), 429: r429, 500: resp('internal_error'), 503: resp('storage_unavailable') },
    } },
    '/v1/bulk': { post: {
      operationId: 'bulkParse', summary: `Parse up to ${X.bulkMax} numbers (Pro keys only; each number counts one call)`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { numbers: { type: 'array', maxItems: X.bulkMax, items: { oneOf: [{ type: 'string', maxLength: 64 }, { type: 'object', properties: { number: { type: 'string', maxLength: 64 }, defaultCountry: { type: 'string', maxLength: 2 } } }] } }, defaultCountry: { type: 'string', maxLength: 2 } }, required: ['numbers'] } } } },
      responses: { 200: { description: 'Results', headers: okHeaders, content: { 'application/json': { schema: { type: 'object' } } } }, 400: resp('Bad input'), 401: resp('api_key_required or invalid_api_key'), 403: resp('paid_plan_required'), 405: resp('method_not_allowed'), 413: resp('body_too_large'), 429: r429, 500: resp('internal_error'), 503: resp('storage_unavailable') },
    } },
    '/v1/example/{country}': { get: {
      operationId: 'exampleNumber', summary: 'Example (mobile) number for a region, for format testing only',
      parameters: [{ name: 'country', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z]{2}$', maxLength: 2 } }],
      responses: { 200: { description: 'Example', content: { 'application/json': { schema: { type: 'object' } } } }, 401: resp('invalid_api_key'), 404: resp('unknown_country'), 429: r429 },
    } },
    '/v1/countries': { get: { operationId: 'listCountries', summary: 'Supported regions', responses: { 200: { description: 'Regions', content: { 'application/json': { schema: { type: 'object' } } } }, 401: resp('invalid_api_key'), 429: r429 } } },
    '/v1/meta': { get: { operationId: 'meta', summary: 'Service version, limits, disclaimer and privacy', responses: { 200: { description: 'Meta', content: { 'application/json': { schema: { type: 'object' } } } }, 401: resp('invalid_api_key'), 429: r429 } } },
    '/mcp': {
      post: {
        operationId: 'mcp', summary: `MCP JSON-RPC 2.0 (Streamable HTTP, stateless). Protocol versions ${SUPPORTED_VERSIONS.join(', ')}. Max body ${MAX_BODY_BYTES} bytes.`,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'JSON-RPC response (tool errors are results with isError)', headers: limHeaders }, 202: { description: 'Notification or client response accepted' }, 400: { description: 'Parse error, invalid request, header mismatch or unsupported version' }, 401: { description: 'invalid_api_key (no WWW-Authenticate)' }, 403: { description: 'Origin not allowed' }, 404: { description: 'Unknown method (2026-07-28)' }, 413: { description: 'Body too large' }, 429: { description: 'Too many MCP requests', headers: { 'retry-after': H('Seconds') } }, 500: { description: 'Internal error' }, 503: { description: 'storage_unavailable' } },
      },
      get: { operationId: 'mcpGet', summary: 'Not supported (stateless, no SSE)', responses: { 405: { description: 'Method not allowed', headers: { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } } } } },
      delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } } } } },
    },
  };
  if (!X.prodGetDisabled) paths['/v1/parse/{number}'] = { get: { operationId: 'parseGet', summary: 'Staging only: number in the path (disabled in production; use POST)', parameters: [{ name: 'number', in: 'path', required: true, schema: { type: 'string', maxLength: 64 } }, { name: 'defaultCountry', in: 'query', schema: { type: 'string', maxLength: 2 } }], responses: { 200: { description: 'Parsed', content: { 'application/json': { schema: parseRes } } }, 400: resp('Bad input'), 401: resp('invalid_api_key'), 429: r429 } } };
  else paths['/v1/parse/{number}'] = { get: { operationId: 'parseGet', summary: 'Disabled in production: numbers in URLs end up in logs. Use POST /v1/parse.', parameters: [{ name: 'number', in: 'path', required: true, schema: { type: 'string', maxLength: 64 } }], responses: { 405: resp('method_not_allowed') } } };
  return {
    openapi: '3.1.0',
    info: { title: 'PhoneCheck', version: VERSION, description: `Offline phone-number validation and formatting (libphonenumber metadata). No carrier/HLR/reachability lookup; numbers are not stored or logged. Anonymous ~${L.anonPerMin}/min per IP; free key ~${L.keyPerMin}/min, ${L.freePerMonth}/month.`, contact: { email: CONTACT } },
    servers: [{ url: origin }],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }, schemas: { Error: errSchema } },
    paths,
  };
}

// v0.2.2: Glama connector ownership claim (served at /.well-known/glama.json). Token transcribed from the
// Glama "HTTP file" screen (28cO = capital letter O; VI1BI = capital I, digit 1, B, capital I).
export const GLAMA_CLAIM = '<GLAMA_CLAIM_TOKEN>';
export const glamaJson = () => JSON.stringify({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: GLAMA_CLAIM }, null, 2);

