import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compress, detect } from '../src/compress.js';
import { buildFixture } from '../bench/fixture.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
const v = buildFixture(dir);
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

test('small outputs are never touched', () => {
  const r = compress('hello\nworld');
  assert.equal(r.changed, false);
  assert.equal(r.text, 'hello\nworld');
});

test('compression is deterministic (cache-safe)', () => {
  const log = read('logs/server.log');
  assert.equal(compress(log).text, compress(log).text);
});

test('log keeps the single error line', () => {
  const r = compress(read('logs/server.log'));
  assert.equal(r.type, 'log');
  assert.ok(r.after < r.before * 0.5, `expected >50% cut, got ${r.after}/${r.before}`);
  assert.match(r.text, new RegExp(`order_id=${v.paymentOrder}`));
});

test('json keeps the outlier host', () => {
  const r = compress(JSON.stringify(JSON.parse(read('data/metrics.json')), null, 2));
  assert.equal(r.type, 'json');
  assert.match(r.text, new RegExp(v.hotHost));
  assert.ok(r.after < r.before * 0.1);
});

test('csv keeps header and the latency outlier', () => {
  const r = compress(read('data/requests.csv'));
  assert.equal(r.type, 'table');
  assert.match(r.text, /request_id,endpoint/);
  assert.match(r.text, new RegExp(v.slowRequest));
});

test('Claude Code Read output (line-numbered code) is left exact', () => {
  const code = Array.from({ length: 200 }, (_, i) => `${String(i + 1).padStart(6)}→const x${i} = ${i};`).join('\n');
  assert.equal(detect(code).type, 'code');
  assert.equal(compress(code).changed, false);
});

test('failing test output keeps failures', () => {
  const lines = ['TAP version 13'];
  for (let i = 0; i < 300; i++) lines.push(`ok ${i + 1} - lineTotal case ${i + 1}`, '  ---', `  duration_ms: 0.${i}`, '  ...');
  lines.splice(500, 0, 'not ok 999 - total of a single item', '  error: Expected values to be strictly equal');
  const r = compress(lines.join('\n'));
  assert.ok(r.changed);
  assert.match(r.text, /not ok 999/);
  assert.match(r.text, /Expected values/);
});

test('grep results are capped per file', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`src/big.js:${i + 1}:  const value = compute(${i});`);
  lines.push('src/other.js:10:  throw new Error("boom")');
  const r = compress(lines.join('\n'));
  assert.equal(r.type, 'search');
  assert.match(r.text, /src\/other\.js:10/);
  assert.match(r.text, /more matches omitted/);
});

test('markers summarize instead of inviting a re-run', () => {
  for (const r of [compress(read('data/requests.csv')), compress(read('logs/server.log')), compress(JSON.stringify(JSON.parse(read('data/metrics.json')), null, 2))]) {
    assert.ok(r.changed);
    assert.doesNotMatch(r.text, /re-run/);
    assert.match(r.text, /do not mention this condensation/);
  }
});

test('compound shell output with preamble/trailer still detects and compresses JSON keeping outliers', () => {
  const json = JSON.stringify(JSON.parse(read('data/metrics.json')), null, 2);
  const compound = `import fs from 'node:fs';\nconsole.log(data);\n--- exit run ---\n${json}\nexit=0`;
  const r = compress(compound);
  assert.equal(r.type, 'json');
  assert.ok(r.changed);
  assert.match(r.text, /--- exit run ---/);
  assert.match(r.text, /exit=0$/);
  assert.match(r.text, new RegExp(v.hotHost));
});

test('JSON-wrapped multiline CSV/log strings (like Codex tool outputs) keep outliers', () => {
  const csv = read('data/requests.csv');
  const wrapped = JSON.stringify({ chunk_id: '7593f6', exit_code: 0, output: csv });
  const r = compress(wrapped);
  assert.equal(r.type, 'json');
  assert.ok(r.changed);
  assert.match(r.text, new RegExp(v.slowRequest));
});
