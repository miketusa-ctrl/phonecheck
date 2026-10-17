// Usage counters in a SQLite-backed Durable Object. Same pattern as DnsGuard's KeyQuota (dnsguard/src/lib/quota.js):
// - Per API key: one instance per key id (idFromName("key:<keyId>")), POST /consume, exact (DO input gates serialize
//   get -> put). PhoneCheck (like CheckDigit) counts per UTC MONTH ("m:YYYY-MM") instead of per day, and a request may consume n > 1
//   units (bulk: one unit per number, app BULK_MAX=500; DO accepts n≤1000). All-or-nothing: if n does not fit, nothing is written.
// - Shared daily soft-cap pools: ONE instance named BUDGET_DO_NAME (see budget.js), POST /add with batched increments.
// Plain fetch()-style class (no `cloudflare:workers` import) so it is unit-testable in Node.
// Only counts are stored: no identifiers, no IPs, no raw API keys.

export const POOL_FIELDS = ['calls', 'anon'];
export const MONTH_RETENTION = 2; // keep this month + last month
export const DAY_RETENTION = 2; // keep today + yesterday

export function utcDay(now = new Date()) { return now.toISOString().slice(0, 10); }
export function utcMonth(now = new Date()) { return now.toISOString().slice(0, 7); }

function monthMinus(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return utcMonth(d);
}
function dayMinus(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return utcDay(d);
}

export class KeyQuota {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.clock = () => Date.now(); // overridable in tests
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/add') {
      const day = url.searchParams.get('day') || utcDay();
      if (request.method !== 'POST' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: 'bad_request' }, { status: 400 });
      const inc = {};
      for (const f of POOL_FIELDS) {
        const n = Number(url.searchParams.get(f) || 0);
        if (!Number.isInteger(n) || n < 0 || n > 100_000) return Response.json({ error: 'bad_request' }, { status: 400 });
        inc[f] = n;
      }
      return Response.json(await this.add(day, inc));
    }
    const month = url.searchParams.get('month') || utcMonth();
    const limit = Number(url.searchParams.get('limit') || 0);
    const n = Number(url.searchParams.get('n') || 1);
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(n) || n < 1 || n > 1000) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }
    if (url.pathname === '/peek') {
      const used = (await this.storage.get(`m:${month}`)) || 0;
      return Response.json({ ok: used < limit, used, limit, month });
    }
    if (url.pathname !== '/consume' || request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(await this.consume(month, limit, n));
  }

  async consume(month, limit, n = 1) {
    const key = `m:${month}`;
    const used = (await this.storage.get(key)) || 0;
    if (used + n > limit) return { ok: false, used, limit, month }; // denied requests write nothing
    await this.storage.put(key, used + n);
    if (used === 0) await this.ensureCleanup(expiryFor(key));
    return { ok: true, used: used + n, limit, month };
  }

  async add(day, inc) {
    const totals = { day };
    let first = false;
    for (const f of POOL_FIELDS) {
      const key = `d:${day}:${f}`;
      const cur = (await this.storage.get(key)) || 0;
      if (inc[f] > 0) {
        if (cur === 0) first = true;
        await this.storage.put(key, cur + inc[f]);
      }
      totals[f] = cur + inc[f];
    }
    if (first) await this.ensureCleanup(expiryFor(`d:${day}:calls`));
    return totals;
  }

  // Keep the EARLIEST pending alarm.
  async ensureCleanup(at) {
    const cur = await this.storage.getAlarm();
    if (!cur || cur > at) await this.storage.setAlarm(at);
  }

  async alarm() {
    const now = new Date(this.clock());
    const keepMonth = monthMinus(utcMonth(now), MONTH_RETENTION - 1);
    const keepDay = dayMinus(utcDay(now), DAY_RETENTION - 1);
    const all = await this.storage.list();
    const old = [];
    let next = Infinity; // re-arm for the earliest time a remaining counter expires (not daily: fewer billed alarms)
    for (const k of all.keys()) {
      if (k.startsWith('m:')) {
        if (k.slice(2, 9) < keepMonth) old.push(k);
        else next = Math.min(next, expiryFor(k));
      } else if (k.startsWith('d:')) {
        if (k.slice(2, 12) < keepDay) old.push(k);
        else next = Math.min(next, expiryFor(k));
      }
    }
    if (old.length) await this.storage.delete(old);
    if (next !== Infinity) await this.storage.setAlarm(Math.max(next, now.getTime() + 1000));
  }
}

/** When a counter key becomes deletable: "m:YYYY-MM" -> 1st of month+2; "d:YYYY-MM-DD:*" -> day+3 (00:00 UTC). */
export function expiryFor(key) {
  if (key.startsWith('m:')) return Date.parse(`${monthMinus(key.slice(2, 9), -MONTH_RETENTION)}-01T00:00:00Z`);
  return Date.parse(`${key.slice(2, 12)}T00:00:00Z`) + (DAY_RETENTION + 1) * 86400_000;
}

export class QuotaUnavailable extends Error {
  constructor(message) { super(message); this.code = 'quota_unavailable'; }
}

// Per-isolate memo of keys already at their monthly cap ("quotaId|limit" -> month): later requests in this isolate
// get the 429 without another billed DO request. (A batch that didn't fit doesn't set the memo; smaller ones may.)
const exhausted = new Map();
export function clearQuotaMemo() { exhausted.clear(); }

/** Consume n units from the key's monthly quota. Throws QuotaUnavailable if the DO can't be reached. */
export async function consumeMonthlyQuota(ns, quotaId, limit, n = 1, now = new Date()) {
  if (!ns) throw new QuotaUnavailable('QUOTA binding missing');
  const month = utcMonth(now);
  const memoKey = `${quotaId}|${limit}`;
  if (exhausted.get(memoKey) === month) return { ok: false, used: limit, limit, month, memo: true };
  let out;
  try {
    const stub = ns.get(ns.idFromName(quotaId));
    const res = await stub.fetch(`https://quota/consume?month=${month}&limit=${limit}&n=${n}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    out = await res.json();
  } catch (e) {
    throw new QuotaUnavailable(`quota counter unavailable: ${e.message}`);
  }
  if (out && out.ok === false && out.used >= limit) {
    exhausted.set(memoKey, month);
    if (exhausted.size > 5000) exhausted.delete(exhausted.keys().next().value);
  }
  return out;
}

/** Seconds until 00:00 UTC on the 1st of next month. */
export function secondsToNextUtcMonth(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
