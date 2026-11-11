import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { classifyByRules, classifyByJev, route, firstUserPrompt, ROUTE_QUESTION } from '../src/router.js';
import { transformRequest } from '../src/transform.js';
import { resolveProfile, PROFILES, BASIC_TOOLS } from '../src/profiles.js';
import { createProxy } from '../src/server.js';

test('rules: bench prompts land on sensible profiles', () => {
  assert.equal(classifyByRules('The test suite is failing. Run `npm test`, find the bug in src/ and fix it. Do not modify the tests.').profile, 'edit');
  assert.equal(classifyByRules('A payment failed this morning. Look at logs/server.log and tell me which order failed and why.').profile, 'lookup');
  assert.equal(classifyByRules('Run `node scripts/metrics.js` and tell me which host looks overloaded on CPU.').profile, 'lookup');
  assert.equal(classifyByRules('Explain how src/cart.js works and list the edge cases it handles badly.').profile, 'lookup');
  assert.equal(classifyByRules('Design a plugin system and migrate all modules to it').profile, 'open');
  assert.equal(classifyByRules('Corrige o bug no carrinho').profile, 'edit');
  assert.equal(classifyByRules('').profile, 'open');
});

// Fake TypeSafe endpoint: answers with whatever `answer` holds, records requests.
function mockJev(answer, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { model: 'jev-1.13.0', answers: { kind: answer }, usage: { input_tokens: 50, output_tokens: 3 } } : { error: 'nope' }));
    });
  });
  return { server, seen, start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/v1/systemone`))) };
}

test('jev backend: sends state + choice question with bearer key, parses the answer', async () => {
  const m = mockJev({ type: 'choice', choice: 'lookup', confidence: 0.97, probabilities: { lookup: 0.97, edit: 0.02, open: 0.01 } });
  const url = await m.start();
  try {
    const r = await classifyByJev('what does cart.js do?', { apiKey: 'k1', url });
    assert.equal(r.profile, 'lookup');
    assert.equal(r.confidence, 0.97);
    assert.equal(r.backend, 'jev');
    assert.equal(m.seen[0].headers.authorization, 'Bearer k1');
    assert.equal(m.seen[0].body.state, 'what does cart.js do?');
    assert.equal(m.seen[0].body.model, 'jev-latest');
    assert.deepEqual(m.seen[0].body.questions.kind, ROUTE_QUESTION);
  } finally { m.server.close(); }
});

test('route: low confidence falls back to the safe profile, errors fall back to rules', async () => {
  const low = mockJev({ type: 'choice', choice: 'lookup', confidence: 0.5, probabilities: { lookup: 0.5, edit: 0.4, open: 0.1 } });
  const url = await low.start();
  try {
    const r = await route('fix the cart total', { backend: 'jev', apiKey: 'k', url, minConfidence: 0.75 });
    assert.equal(r.profile, 'edit'); // escalated to the higher of the top two, not to the top
    assert.equal(r.suggested, 'lookup');
    assert.match(r.reason, /confidence 0.5/);
  } finally { low.server.close(); }
  const bad = mockJev(null, 500);
  const url2 = await bad.start();
  try {
    const r = await route('fix the cart total', { backend: 'jev', apiKey: 'k', url: url2 });
    assert.equal(r.backend, 'rules');
    assert.equal(r.profile, 'edit');
    assert.match(r.error, /HTTP 500/);
  } finally { bad.server.close(); }
  const r = await route('fix the cart total', { backend: 'jev', apiKey: '', url: 'http://127.0.0.1:1/x' });
  assert.equal(r.backend, 'rules');
  assert.match(r.error, /TYPESAFE_API_KEY/);
});

test('firstUserPrompt strips Claude Code system reminders', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nstuff\n</system-reminder>' }, { type: 'text', text: 'Explain cart.js' }] }] };
  assert.equal(firstUserPrompt(body), 'Explain cart.js');
  assert.equal(firstUserPrompt({ messages: [{ role: 'user', content: 'hi' }] }), 'hi');
});

const req = () => ({
  model: 'claude-sonnet-5-5', max_tokens: 100, stream: true,
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: { effort: 'medium' },
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ name: 'Bash' }, { name: 'Agent' }, { name: 'Read' }, { name: 'mcp__x__y' }, { name: 'Workflow' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    {
      role: 'system',
      output_config: { effort: 'high' },
      content: [{
        type: 'text',
        text: [
          '# Environment\nYou have been invoked in the following environment:',
          'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded.',
          'Available agent types for the Agent tool:\n- claude',
          'When you launch multiple agents for independent work, send them in a single message.',
          'The following skills are available for use with the Skill tool:',
          '- dataviz: Use this skill whenever you are about to create ANY chart.',
          'Today\'s date is 2026-10-24.',
        ].join('\n\n'),
      }],
    },
  ],
});

test('profile rewrites model, effort, cache ttl and tool list, deterministically', () => {
  const a = req(); const sa = transformRequest('anthropic', '/v1/messages', a, 'lookup');
  assert.equal(a.model, 'claude-haiku-5-5');
  assert.equal(a.output_config.effort, 'low');
  assert.equal(a.messages[1].output_config.effort, 'low');
  assert.equal(a.thinking, undefined); // low effort disables adaptive thinking
  assert.equal(a.messages[1].content[0].text, '# Environment\nYou have been invoked in the following environment:\n\nToday\'s date is 2026-10-24.');
  assert.deepEqual(a.system[0].cache_control, { type: 'ephemeral' });           // 5m = no ttl field
  assert.deepEqual(a.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(a.tools.map((t) => t.name), ['Bash', 'Read', 'mcp__x__y']);  // MCP tools kept
  assert.equal(sa.toolsDropped, 2);
  assert.equal(sa.model, 'claude-haiku-5-5'); assert.equal(sa.effort, 'low'); assert.equal(sa.cacheTtl, '5m');
  assert.equal(a.system.length, 2); // terse appended
  const b = req(); transformRequest('anthropic', '/v1/messages', b, 'lookup');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // edit (medium effort) keeps thinking but updates message-level effort and prunes env
  const e = req(); transformRequest('anthropic', '/v1/messages', e, 'edit');
  assert.deepEqual(e.thinking, { type: 'adaptive', display: 'omitted' });
  assert.equal(e.messages[1].output_config.effort, 'medium');
  assert.ok(!e.messages[1].content[0].text.includes('dataviz'));
  // modes still work and touch nothing else
  const c = req(); const sc = transformRequest('anthropic', '/v1/messages', c, 'compress');
  assert.equal(c.model, 'claude-sonnet-5-5'); assert.equal(c.tools.length, 5); assert.equal(sc.model, null);
  // specs
  const d = req(); transformRequest('anthropic', '/v1/messages', d, 'model=opus+effort=high+ttl=1h+tools=Bash/Read');
  assert.equal(d.model, 'claude-opus-5-5'); assert.equal(d.output_config.effort, 'high'); assert.equal(d.system[0].cache_control.ttl, '1h');
  assert.deepEqual(d.tools.map((t) => t.name), ['Bash', 'Read', 'mcp__x__y']);
  assert.deepEqual(resolveProfile('edit').tools, BASIC_TOOLS);
  assert.throws(() => resolveProfile('nope'), /unknown profile/);
  assert.equal(Object.keys(PROFILES).length, 8);
});

test('proxy with route: one decision per session, applied to every request of that session', async () => {
  const seen = [];
  const up = http.createServer((r, res) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { seen.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  let calls = 0;
  const classifier = async (prompt) => { calls++; return { profile: prompt.startsWith('Explain') ? 'lookup' : 'edit', backend: 'test', confidence: 1, ms: 0 }; };
  const proxy = createProxy({ route: { classifier }, logFile: null, anthropicUpstream: `http://127.0.0.1:${up.address().port}` });
  const port = await proxy.listen(0);
  const send = (sid, text) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '1' }, body: JSON.stringify({ ...req(), metadata: { user_id: JSON.stringify({ session_id: sid }) }, messages: [{ role: 'user', content: text }] }) });
  try {
    await send('s1', 'Explain cart.js'); await send('s1', 'Explain cart.js'); await send('s2', 'fix the bug');
    assert.equal(calls, 2);
    assert.equal(seen[0].model, 'claude-haiku-5-5'); assert.equal(seen[1].model, 'claude-haiku-5-5'); assert.equal(seen[2].model, 'claude-sonnet-5-5');
    assert.equal(proxy.records[0].profile, 'lookup'); assert.equal(proxy.records[2].profile, 'edit');
    assert.equal(proxy.records[0].route.backend, 'test');
    assert.equal(proxy.mode, 'route');
  } finally { await proxy.close(); up.close(); }
});

test('escalate: low confidence goes one rung up between the two most probable', async () => {
  const { escalate } = await import('../src/router.js');
  assert.equal(escalate({ lookup: 0, edit: 0.48, build: 0, open: 0.52 }, 'open'), 'open');
  assert.equal(escalate({ lookup: 0.01, edit: 0.53, build: 0.46, open: 0 }, 'edit'), 'build');
  assert.equal(escalate({ lookup: 0.6, edit: 0.4, build: 0, open: 0 }, 'lookup'), 'edit');
  assert.equal(escalate(null, 'lookup'), 'open');
});

test('rules: four rungs, cheapest that covers the request', () => {
  assert.equal(classifyByRules('Create a simple landing page in public/index.html for a coffee shop. Plain HTML and CSS, no framework.').profile, 'lookup');
  assert.equal(classifyByRules('Add an order history: src/orders.js, a scripts/order.js CLI and tests for both.').profile, 'build');
  assert.equal(classifyByRules('Set up CI with lint, tests and a release pipeline.').profile, 'build');
  assert.equal(classifyByRules('The app is slow on large carts and I don\'t know why. Investigate and fix the root cause.').profile, 'open');
  assert.equal(classifyByRules('Rename lineTotal to itemTotal everywhere.').profile, 'edit');
  assert.equal(resolveProfile('build').model, 'sonnet');
  assert.equal(resolveProfile('build').effort, 'high');
  assert.equal(resolveProfile('build').tools, undefined);
  assert.equal(resolveProfile('open').model, undefined);
  assert.equal(ROUTE_QUESTION.criteria.build.length > 0, true);
  assert.deepEqual(Object.keys(ROUTE_QUESTION.criteria), Object.keys(PROFILES).filter((k) => ['lookup', 'edit', 'build', 'open'].includes(k)));
});

test('prompts.json: 100 labeled prompts, rules fallback stays above 80% on them (no network)', async () => {
  const fs = await import('node:fs');
  const { prompts } = JSON.parse(fs.readFileSync(new URL('../bench/prompts.json', import.meta.url), 'utf8'));
  assert.equal(prompts.length, 100);
  for (const p of prompts) assert.ok(['lookup', 'edit', 'build', 'open'].includes(p.label) && p.text.trim(), JSON.stringify(p));
  const ok = prompts.filter((p) => classifyByRules(p.text).profile === p.label).length;
  assert.ok(ok >= 80, `rules agree on ${ok}/100`);
});
