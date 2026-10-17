// Global daily soft cap (shared pools), same approach as DnsGuard's budget.js: a cost backstop so PhoneCheck stays well
// inside its share of the account's Workers Paid allowance, however many IPs or keys show up.
// - calls: every validation request (anonymous + keyed; a bulk request counts once), capped at limits.callsPerDay
// - anon:  the anonymous share of that, capped at limits.anonPerDay (the rest stays available to key holders)
// Counting is APPROXIMATE on purpose: each isolate batches increments and flushes them to ONE KeyQuota DO instance
// (BUDGET_DO_NAME) at most every FLUSH_EVERY_N events or FLUSH_EVERY_MS. Overshoot <= active isolates x FLUSH_EVERY_N.
// If the DO is unreachable we fail open (per-minute limiters and per-key monthly quotas still apply).
// Nothing but counts is sent or stored.
import { utcDay, POOL_FIELDS } from './quota.js';

export const BUDGET_DO_NAME = 'global:budget';
export const FLUSH_EVERY_N = 25;
export const FLUSH_EVERY_MS = 60_000;

const zero = () => Object.fromEntries(POOL_FIELDS.map((f) => [f, 0]));
const state = { day: null, seen: zero(), pending: zero(), lastFlush: 0, inflight: null };

export function resetBudgetState() {
  Object.assign(state, { day: null, seen: zero(), pending: zero(), lastFlush: 0, inflight: null });
}
export function budgetSnapshot() { return { day: state.day, seen: { ...state.seen }, pending: { ...state.pending } }; }

function roll(day) {
  if (state.day !== day) Object.assign(state, { day, seen: zero(), pending: zero(), lastFlush: 0 });
}
const used = (f) => state.seen[f] + state.pending[f];

export function secondsToUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Is there room in today's shared pool? kind: 'anon' | 'key'. */
export function budgetAllows(kind, limits, now = new Date()) {
  roll(utcDay(now));
  if (used('calls') >= limits.callsPerDay) return { ok: false, pool: 'calls' };
  if (kind === 'anon' && used('anon') >= limits.anonPerDay) return { ok: false, pool: 'anon' };
  return { ok: true };
}

/** Count one request and flush the batch to the budget DO when due (in ctx.waitUntil when available). */
export function budgetRecord(kind, ns, ctx, now = new Date()) {
  roll(utcDay(now));
  state.pending.calls++;
  if (kind === 'anon') state.pending.anon++;
  const due = state.pending.calls >= FLUSH_EVERY_N || now.getTime() - state.lastFlush >= FLUSH_EVERY_MS;
  if (!ns || !due || state.inflight) return null;
  const p = flushBudget(ns, now);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}

export async function flushBudget(ns, now = new Date()) {
  const day = utcDay(now);
  roll(day);
  const batch = { ...state.pending };
  state.pending = zero();
  state.lastFlush = now.getTime();
  const qs = POOL_FIELDS.map((f) => `${f}=${batch[f]}`).join('&');
  const p = (async () => {
    try {
      const stub = ns.get(ns.idFromName(BUDGET_DO_NAME));
      const res = await stub.fetch(`https://quota/add?day=${day}&${qs}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.json();
      if (state.day === day) for (const f of POOL_FIELDS) state.seen[f] = Math.max(state.seen[f], Number(t[f]) || 0);
      return t;
    } catch {
      if (state.day === day) for (const f of POOL_FIELDS) state.pending[f] += batch[f];
      return null;
    }
  })();
  state.inflight = p;
  p.finally(() => { if (state.inflight === p) state.inflight = null; });
  return p;
}
