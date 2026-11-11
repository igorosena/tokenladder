import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, variantSpec } from '../bench/run.js';
import { buildFixture } from '../bench/fixture.js';
import { units, usd } from '../src/usage.js';
import { detect } from '../src/compress.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const row = (task, variant, run, usage, extra = {}) => ({
  task, variant, run, measured: true, pass: true, turns: 2, model: 'claude-test',
  requests: [{ seq: 1, usage }, { seq: 2, usage }],
  usage, context: usage.input + usage.cacheWrite + usage.cacheRead, units: 0, costUsd: 0.01,
  compression: { blocks: 0, before: 0, after: 0, byType: {} }, ms: 1000, result: 'ok', ...extra,
});

test('report shows context (input + cache write + cache read), min–max, reqs and separate Δs', () => {
  const rows = [
    row('t', 'passthrough', 1, { input: 10, cacheWrite: 20_000, cacheRead: 80_000, output: 100 }),
    row('t', 'passthrough', 2, { input: 10, cacheWrite: 0, cacheRead: 100_000, output: 120 }),
    row('t', 'full', 1, { input: 10, cacheWrite: 5_000, cacheRead: 75_000, output: 220 }, { compression: { blocks: 1, before: 10_000, after: 1_000, byType: {} } }),
    row('t', 'full', 2, { input: 10, cacheWrite: 0, cacheRead: 80_000, output: 200 }),
  ];
  const r = buildReport(rows, ['passthrough', 'full'], { agent: 'x', model: 'm', runs: 2 });
  const line = (v) => r.split('\n').find((l) => l.startsWith('t ') && l.includes(` ${v} `));
  // passthrough: context is 100,010 in both runs even though cache write differs (20,000 vs 0)
  assert.match(line('passthrough'), /2\.0\s+100,010\s+100,010\s+baseline\s+110\s+100–120\s+baseline/);
  // full: context mean 80,010 → -20.0%; output mean 210 → +90.9%; cut 90% of 5,000 chars/run
  assert.match(line('full'), /2\.0\s+80,010\s+80,010\s+-20\.0%\s+210\s+200–220\s+\+90\.9%\s+90% of 5,000/);
  assert.match(r, /cache w min–max/);
  assert.match(r, /0–20,000/); // passthrough cache write range in the cache table
  assert.match(r, /full\s+2\/2\s+80,010\s+-20\.0%\s+210\s+\+90\.9%/); // totals
});

test('report accepts legacy runs.json rows (requests as a count, no context field)', () => {
  const legacy = { task: 't', variant: 'passthrough', run: 1, pass: null, requests: 3, usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }, units: 0, costUsd: null, compression: { blocks: 0, before: 0, after: 0 } };
  const r = buildReport([legacy], ['passthrough'], { agent: 'x', model: 'm', runs: 1 });
  assert.match(r, /t\s+passthrough\s+n\/a\s+3\.0\s+6\s+6\s+baseline\s+4\s+4\s+baseline/);
});

test('report drops runs where the agent failed to start and says so', () => {
  const ok = row('t', 'passthrough', 1, { input: 1, cacheWrite: 0, cacheRead: 99, output: 10 });
  const dead = { ...row('t', 'passthrough', 2, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }), requests: [], exit: -2, pass: false, stderr: 'spawn claude ENOENT' };
  const r = buildReport([ok, dead], ['passthrough'], { agent: 'x', model: 'm', runs: 2 });
  assert.match(r, /1 run\(s\) where the agent failed to start/);
  assert.match(r, /t\s+passthrough\s+1\/1\s+2\.0\s+100\s+100\s+baseline\s+10\s+10/);
});

test('variants: modes, profiles, specs and route', () => {
  assert.deepEqual(variantSpec('full'), { name: 'full', proxy: { mode: 'full' }, agentArgs: [] });
  assert.deepEqual(variantSpec('route'), { name: 'route', proxy: { route: { backend: 'jev' } }, agentArgs: [] });
  assert.deepEqual(variantSpec('route:rules').proxy, { route: { backend: 'rules' } });
  const l = variantSpec('lookup');
  assert.deepEqual(l.proxy, { profile: 'lookup' });
  assert.deepEqual(l.agentArgs, ['--tools', 'Bash,Read,Edit,Write,Grep,Glob']);
  assert.deepEqual(variantSpec('model=haiku+compress').agentArgs, []);
  assert.equal(variantSpec('model=sonnet+effort=low+compress+terse+ttl=5m+tools=basic').agentArgs.length, 2);
  assert.throws(() => variantSpec('bogus'), /unknown profile/);
});

test('fresh output: nonce lands in every data file, prefix-relevant files unchanged otherwise', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-fx-')); const b = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-fx-'));
  const va = buildFixture(a); const vb = buildFixture(b, { nonce: 'nonce-xq7' });
  assert.deepEqual(va, vb); // same answers
  for (const f of ['src/cart.js', 'logs/server.log', 'data/metrics.json', 'data/requests.csv']) {
    assert.match(fs.readFileSync(path.join(b, f), 'utf8'), /nonce-xq7/);
    assert.doesNotMatch(fs.readFileSync(path.join(a, f), 'utf8'), /nonce-xq7/);
  }
  assert.equal(fs.readFileSync(path.join(a, 'test/cart.test.js'), 'utf8'), fs.readFileSync(path.join(b, 'test/cart.test.js'), 'utf8'));
  assert.equal(detect(fs.readFileSync(path.join(b, 'data/requests.csv'), 'utf8')).type, 'table'); // nonce must not break the CSV compressor
  assert.equal(detect(fs.readFileSync(path.join(b, 'logs/server.log'), 'utf8')).type, 'log');
  fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
});

test('units: 1h cache writes cost 2x, 5m ones 1.25x', () => {
  assert.equal(units({ input: 0, cacheWrite: 1000, cacheRead: 0, output: 0 }), 1250);
  assert.equal(units({ input: 0, cacheWrite: 1000, cacheWrite1h: 1000, cacheRead: 0, output: 0 }), 2000);
  assert.equal(units({ input: 0, cacheWrite: 1000, cacheWrite1h: 400, cacheRead: 0, output: 0 }), 600 * 1.25 + 400 * 2);
});

test('usd: list price per model, Haiku long-prompt tier, unknown model = null', () => {
  const u = { input: 1_000_000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  assert.equal(usd(u, 'claude-sonnet-5-5'), 2);
  assert.equal(usd({ ...u, input: 0, cacheRead: 1_000_000 }, 'claude-sonnet-5-5'), 0.1);
  assert.equal(usd({ ...u, input: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }, 'claude-sonnet-5-5'), 4);
  assert.equal(usd({ ...u, input: 0, cacheWrite: 1_000_000 }, 'claude-sonnet-5-5'), 2.5);
  assert.equal(usd({ ...u, input: 0, output: 1_000_000 }, 'claude-opus-5-5'), 20);
  assert.equal(usd({ input: 50_000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }, 'claude-haiku-5-5'), 0.005);
  assert.equal(usd({ input: 200_000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }, 'claude-haiku-5-5'), 0.1); // >100K tier
  assert.equal(usd(u, 'gpt-x'), null);
});

test('report prices each request at the model that answered it', () => {
  const sonnet = { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 100_000, output: 1000 }; // $0.01 + $0.01
  const haiku = { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 100_000, output: 1000 };  // $0.001 + $0.0005
  const mk = (variant, model, usage) => ({ ...row('t', variant, 1, usage), model, requests: [{ seq: 1, model, usage }], costUsd: 0.5 });
  const r = buildReport([mk('passthrough', 'claude-sonnet-5-5', sonnet), mk('lookup', 'claude-haiku-5-5', haiku)], ['passthrough', 'lookup'], { agent: 'x', model: 'm', runs: 1 });
  assert.match(r, /t\s+passthrough\s+sonnet-5-5.*\$0\.0200\s+baseline/);
  assert.match(r, /t\s+lookup\s+haiku-5-5\s.*\$0\.0015\s+-92\.5%/);
  assert.match(r, /lookup\s+1\/1.*\$0\.0015\s+-92\.5%/); // totals
});

test('direct variant: router picks the rung, proxy switches only the model', async () => {
  const { createProxy } = await import('../src/server.js');
  const http = await import('node:http');
  const seen = [];
  const up = http.createServer((r, res) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { seen.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const spec = variantSpec('direct');
  assert.equal(spec.proxy.route.bare, true); assert.equal(spec.proxy.route.backend, 'jev'); assert.deepEqual(spec.agentArgs, []);
  assert.equal(variantSpec('direct:rules').proxy.route.backend, 'rules');
  const classifier = async () => ({ profile: 'lookup', backend: 'test', confidence: 1, ms: 0 });
  const proxy = createProxy({ route: { ...spec.proxy.route, classifier }, logFile: null, anthropicUpstream: `http://127.0.0.1:${up.address().port}` });
  const port = await proxy.listen(0);
  try {
    const big = 'x'.repeat(3000).replace(/x/g, () => 'row,1,2\n').slice(0, 6000);
    const body = { model: 'claude-fable-5-1', max_tokens: 10, output_config: { effort: 'high' }, system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }], tools: [{ name: 'Bash', input_schema: {} }, { name: 'Task', input_schema: {} }], messages: [{ role: 'user', content: 'Explain' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] }] };
    await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '1' }, body: JSON.stringify(body) });
    const s = seen[0];
    assert.equal(s.model, 'claude-haiku-5-5');            // only the model changes
    assert.equal(s.output_config.effort, 'high');           // effort untouched
    assert.equal(s.system[0].cache_control.ttl, '1h');      // ttl untouched
    assert.equal(s.tools.length, 2);                        // tools untouched
    assert.equal(s.messages[2].content[0].content, big);    // no compression
    assert.equal(proxy.records[0].profile, 'lookup:direct');
  } finally { await proxy.close(); up.close(); }
});

test('diffSnapshot: reports added, changed and deleted files, caps size', async () => {
  const { diffSnapshot } = await import('../bench/run.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-snap-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/x/i.js'), 'ignored');
    const before = { 'src/a.js': 'a', 'b.txt': 'b', 'gone.txt': 'g' };
    assert.deepEqual(diffSnapshot(dir, { 'src/a.js': 'a', 'b.txt': 'b' }), {});
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'a2');
    fs.writeFileSync(path.join(dir, 'new.js'), 'n'.repeat(30_000));
    const d = diffSnapshot(dir, before);
    assert.equal(d['src/a.js'], 'a2');
    assert.equal(d['gone.txt'], null);
    assert.ok(d['new.js'].startsWith('n'.repeat(100)) && d['new.js'].includes('more chars'));
    assert.equal('b.txt' in d, false);
    assert.equal(Object.keys(d).some((k) => k.includes('node_modules')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('judge: blind pairwise prompt, verdict parsing, outcome mapping, report rows', async () => {
  const { buildJudgePrompt, parseVerdict, baselineFirst, judgeRuns, qualityRows, renderRun } = await import('../bench/judge.js');
  const p = buildJudgePrompt('Fix it', 'AAA', 'BBB');
  assert.ok(p.includes('=== ATTEMPT A ===\nAAA') && p.includes('=== ATTEMPT B ===\nBBB') && p.includes('Fix it'));
  assert.deepEqual(parseVerdict('Sure:\n```json\n{"a":{"score":4,"issues":""},"b":{"score":2,"issues":"missed tests"},"better":"a"}\n```'), { a: { score: 4, issues: '' }, b: { score: 2, issues: 'missed tests' }, better: 'a' });
  assert.throws(() => parseVerdict('{"a":{"score":9},"b":{"score":1},"better":"a"}'), /bad score/);
  assert.equal(baselineFirst('t', 'v', 1), baselineFirst('t', 'v', 1)); // seeded
  assert.ok(renderRun({ result: 'hi', changes: { 'x.js': '1', 'y.js': null } }).includes('--- y.js (deleted)'));
  assert.ok(renderRun({ result: 'hi' }).includes('NOT RECORDED'));
  assert.ok(renderRun({ result: 'hi', changes: {} }).includes('changed by the agent: none'));

  const rows = [
    { task: 't1', variant: 'passthrough', run: 1, result: 'base1' }, { task: 't1', variant: 'passthrough', run: 2, result: 'base2' },
    { task: 't1', variant: 'route', run: 1, result: 'r1' }, { task: 't1', variant: 'route', run: 2, result: 'r2' },
    { task: 't1', variant: 'direct', run: 1, result: 'd1' },
  ];
  // Fake judge: the side holding the baseline always gets 5, the other 3, and wins.
  const call = async (agent, model, prompt) => {
    const aIsBase = /=== ATTEMPT A ===\nFinal message to the user:\nbase/.test(prompt);
    const [sa, sb] = aIsBase ? [5, 3] : [3, 5];
    return { text: JSON.stringify({ a: { score: sa, issues: aIsBase ? '' : 'weak' }, b: { score: sb, issues: aIsBase ? 'weak' : '' }, better: aIsBase ? 'a' : 'b' }), usage: { input: 1000, output: 50 }, model: 'claude-sonnet-5-5' };
  };
  const j = await judgeRuns(rows, ['passthrough', 'route', 'direct'], { model: 'sonnet', call, prompts: { t1: 'do t1' } });
  assert.equal(j.comparisons.length, 3);
  for (const c of j.comparisons) { assert.equal(c.baseScore, 5); assert.equal(c.variantScore, 3); assert.equal(c.outcome, 'loss'); assert.equal(c.variantIssues, 'weak'); }
  assert.equal(j.comparisons.find((c) => c.variant === 'route' && c.run === 2).baseRun, 2);
  assert.ok(j.usd > 0);
  let calls = 0;
  const j2 = await judgeRuns(rows, ['passthrough', 'route', 'direct'], { model: 'sonnet', call: async (...a) => { calls++; return call(...a); }, prompts: { t1: 'do t1' }, previous: { ...j, comparisons: j.comparisons.slice(0, 2) } });
  assert.equal(calls, 1); assert.equal(j2.comparisons.length, 3); // only the missing one was judged
  const rerun = rows.map((r) => (r.variant === 'route' && r.run === 1 ? { ...r, result: 'r1 again' } : r));
  calls = 0;
  const j2b = await judgeRuns(rerun, ['passthrough', 'route', 'direct'], { model: 'sonnet', call: async (...a) => { calls++; return call(...a); }, prompts: { t1: 'do t1' }, previous: j2 });
  assert.equal(calls, 1); assert.notEqual(j2b.comparisons[0].fingerprint, j2.comparisons[0].fingerprint); // a re-run cell is judged again, the rest reused
  const legacy = { ...j2, comparisons: j2.comparisons.map(({ fingerprint, ...c }) => c) };
  calls = 0;
  const j2c = await judgeRuns(rows, ['passthrough', 'route', 'direct'], { model: 'sonnet', call: async (...a) => { calls++; return call(...a); }, prompts: { t1: 'do t1' }, previous: legacy });
  assert.equal(calls, 0); assert.ok(j2c.comparisons.every((c) => c.fingerprint)); // old judge.json without fingerprints is adopted and stamped
  let fails = 2;
  const flaky = async (...a) => { if (fails-- > 0) throw new Error('spawn claude ENOENT'); return call(...a); };
  const j3 = await judgeRuns(rows.slice(0, 3), ['passthrough', 'route'], { model: 'sonnet', call: flaky, prompts: { t1: 'do t1' }, retryWaitMs: 1 });
  assert.equal(j3.comparisons[0].error, null); assert.equal(j3.comparisons[0].outcome, 'loss'); // survived two spawn failures
  const { perCell, perVariant, anyNoFiles } = qualityRows(j, ['passthrough', 'route', 'direct'], 'passthrough', rows.map((r) => ({ ...r, measured: true, changes: r.variant === 'direct' ? {} : undefined })));
  assert.deepEqual(perVariant[0].slice(0, 3), ['passthrough', '5.00', 'baseline']);
  assert.deepEqual(perVariant[1], ['route', '3.00', '-2.00', '0–0–2']);
  assert.equal(perCell.length, 3);
  assert.equal(perCell[0][2], '5.00†'); assert.equal(perCell[1][2], '3.00†'); assert.equal(perCell[2][2], '3.00'); assert.equal(anyNoFiles, true);
  const rep = buildReport(rows.map((r) => ({ ...r, measured: true, pass: true, exit: 0, usage: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 }, requests: [{ usage: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 }, model: 'claude-sonnet-5-5' }], units: 6, compression: { blocks: 0, before: 0, after: 0, byType: {} } })), ['passthrough', 'route', 'direct'], { agent: 'claude', model: 'fable', runs: 2 }, j);
  assert.ok(rep.includes('## Quality (judge: sonnet') && rep.includes('0–0–2'));
});
