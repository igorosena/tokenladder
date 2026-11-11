// Builds the benchmark project into a directory. Deterministic (seeded), so
// every run of every variant sees byte-identical files.

import fs from 'node:fs';
import path from 'node:path';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// opts.nonce: a per-run string written into the data the tasks read (JSON,
// log, CSV, source). The prefix the agent sends (system, tools, prompt) stays
// identical, but each tool output is new to the provider's cache, as in a
// real session where every command output is seen for the first time.
export function buildFixture(dir, opts = {}) {
  const nonce = opts.nonce || null;
  const r = rng(42);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  // --- small app with one bug and a large passing test suite
  w('package.json', JSON.stringify({ name: 'shop', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  w('src/cart.js', `// Shopping cart helpers${nonce ? ` (build ${nonce})` : ''}
export function lineTotal(item) {
  return item.price * item.qty;
}

export function cartTotal(items, { discountPct = 0, taxPct = 0 } = {}) {
  let subtotal = 0;
  for (let i = 1; i < items.length; i++) {
    subtotal += lineTotal(items[i]);
  }
  const discounted = subtotal * (1 - discountPct / 100);
  const total = discounted * (1 + taxPct / 100);
  return Math.round(total * 100) / 100;
}

export function applyCoupon(total, coupon) {
  if (!coupon) return total;
  if (coupon.type === 'fixed') return Math.max(0, total - coupon.amount);
  if (coupon.type === 'percent') return Math.round(total * (1 - coupon.amount / 100) * 100) / 100;
  throw new Error('unknown coupon type: ' + coupon.type);
}
`);
  w('test/cart.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, applyCoupon } from '../src/cart.js';

test('total of a single item', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }]), 20);
});
test('total with discount and tax', () => {
  assert.equal(cartTotal([{ price: 10, qty: 1 }, { price: 5, qty: 2 }], { discountPct: 10, taxPct: 10 }), 19.8);
});
test('fixed coupon never goes below zero', () => {
  assert.equal(applyCoupon(5, { type: 'fixed', amount: 10 }), 0);
});
`);
  let misc = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { lineTotal } from '../src/cart.js';\n\n`;
  for (let i = 1; i <= 120; i++) {
    const p = Math.round(r() * 1000) / 100;
    const q = 1 + Math.floor(r() * 9);
    misc += `test('lineTotal case ${i}', () => { assert.equal(lineTotal({ price: ${p}, qty: ${q} }), ${p} * ${q}); });\n`;
  }
  w('test/line.test.js', misc);

  // Sizes are chosen to land between 2 KB and 30 KB: Claude Code itself already
  // swaps outputs above ~30 KB for a 2 KB preview + a file on disk, so that is
  // the band where a proxy can still save input tokens.

  // --- server log with a single payment failure
  const routes = ['/api/cart', '/api/products', '/api/user', '/health', '/api/search', '/api/orders'];
  const log = [];
  const failAt = 263;
  for (let i = 0; i < 380; i++) {
    const ts = new Date(Date.UTC(2026, 9, 14, 8, 0, 0) + i * 1370).toISOString();
    if (i === failAt) {
      log.push(`${ts} ERROR payments: gateway timeout after 30000ms charging order_id=88213 customer=c_5521`);
    } else if (r() < 0.01) {
      log.push(`${ts} WARN cache: slow lookup ${Math.floor(r() * 400 + 200)}ms key=prod:${Math.floor(r() * 9000)}`);
    } else {
      log.push(`${ts} INFO http: ${pick(['GET', 'POST'])} ${pick(routes)} 200 ${Math.floor(r() * 80 + 5)}ms req=${Math.floor(r() * 1e9).toString(16)}`);
    }
  }
  if (nonce) log.unshift(`${new Date(Date.UTC(2026, 9, 14, 7, 59, 59)).toISOString()} INFO boot: server started build=${nonce}`);
  w('logs/server.log', `${log.join('\n')}\n`);

  // --- metrics json with one overloaded host
  const regions = ['us-east', 'us-west', 'eu-central', 'sa-east'];
  const metrics = [];
  for (let i = 1; i <= 150; i++) {
    metrics.push({
      host: `web-${String(i).padStart(3, '0')}`,
      region: pick(regions),
      cpu: Math.round((20 + r() * 40) * 10) / 10,
      memMb: Math.floor(1500 + r() * 1500),
      rps: Math.floor(100 + r() * 300),
    });
  }
  metrics[97].cpu = 99.4;
  w('data/metrics.json', JSON.stringify({ generatedAt: '2026-10-14T12:00:00Z', ...(nonce ? { export: nonce } : {}), hosts: metrics }, null, 2));
  w('scripts/metrics.js', `import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(new URL('../data/metrics.json', import.meta.url)));
console.log(JSON.stringify(data, null, 2));
`);

  // --- csv with one latency outlier
  const csv = ['request_id,endpoint,status,latency_ms,bytes'];
  for (let i = 0; i < 700; i++) {
    const id = `req_${(100000 + i).toString(36)}`;
    const lat = i === 451 ? 48211 : Math.floor(20 + r() * 180);
    const route = pick(routes);
    // The nonce rides in the first row's endpoint so the file stays a plain CSV.
    csv.push(`${id},${i === 0 && nonce ? `/health?build=${nonce}` : route},200,${lat},${Math.floor(500 + r() * 9000)}`);
  }
  w('data/requests.csv', `${csv.join('\n')}\n`);

  return {
    paymentOrder: '88213',
    hotHost: metrics[97].host,
    slowRequest: `req_${(100000 + 451).toString(36)}`,
  };
}
