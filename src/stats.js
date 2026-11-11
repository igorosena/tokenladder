// Summaries of logged usage, grouped by mode/label.

import { addUsage, emptyUsage, units } from './usage.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b ? `${((1 - a / b) * 100).toFixed(1)}%` : '—');

export function summarize(records, { groupBy = (r) => (r.label ? `${r.mode}/${r.label}` : r.mode) } = {}) {
  const groups = new Map();
  for (const r of records) {
    const key = groupBy(r);
    const g = groups.get(key) || { key, requests: 0, usage: emptyUsage(), units: 0, cBefore: 0, cAfter: 0, cBlocks: 0, sessions: new Set() };
    g.requests++;
    g.sessions.add(r.session);
    if (r.usage) { addUsage(g.usage, r.usage); g.units += units(r.usage); }
    if (r.compression) { g.cBefore += r.compression.before; g.cAfter += r.compression.after; g.cBlocks += r.compression.blocks; }
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function renderSummary(groups) {
  const head = ['group', 'sessions', 'requests', 'input', 'cache write', 'cache read', 'output', 'weighted units', 'compressed blocks', 'chars cut'];
  const rows = groups.map((g) => [
    g.key, g.sessions.size, g.requests, fmt(g.usage.input), fmt(g.usage.cacheWrite), fmt(g.usage.cacheRead), fmt(g.usage.output), fmt(g.units),
    g.cBlocks, g.cBefore ? pct(g.cAfter, g.cBefore) : '—',
  ]);
  const out = [table(head, rows)];
  const base = groups.find((g) => g.key.startsWith('passthrough'));
  if (base) {
    for (const g of groups) {
      if (g === base) continue;
      out.push(`${g.key} vs ${base.key}: weighted units ${pct(g.units, base.units)} lower, output ${pct(g.usage.output, base.usage.output)} lower (per-session totals; compare only runs of the same task)`);
    }
  }
  return out.join('\n');
}

export function table(head, rows) {
  const all = [head, ...rows].map((r) => r.map(String));
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(all[0]), w.map((n) => '-'.repeat(n)).join('  '), ...all.slice(1).map(line)].join('\n');
}
