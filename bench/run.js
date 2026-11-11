// A/B benchmark: run the same tasks with the same prompts through the proxy in
// different modes, on fresh identical copies of a fixture project, and compare
// provider-reported tokens plus whether the task was actually solved.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProxy } from '../src/server.js';
import { addUsage, emptyUsage, units, usd } from '../src/usage.js';
import { table } from '../src/stats.js';
import { buildFixture } from './fixture.js';
import { resolveProfile } from '../src/profiles.js';
import { MODES } from '../src/transform.js';
import { judgeRuns, qualityRows } from './judge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// A variant is a proxy mode (passthrough|compress|terse|full), a profile name
// (lookup|edit|build|open), a spec (model=haiku+effort=low+...), route[:jev|rules]
// where the proxy picks the profile itself from the first prompt, or
// direct[:jev|rules]: the model the router would pick, and nothing else (no
// compression, terse, tools or ttl), i.e. the user choosing that model by hand.
export function variantSpec(v) {
  if (MODES.includes(v)) return { name: v, proxy: { mode: v }, agentArgs: [] };
  if (v === 'route' || v.startsWith('route:')) return { name: v, proxy: { route: { backend: v.split(':')[1] || 'jev' } }, agentArgs: [] };
  if (v === 'direct' || v.startsWith('direct:')) return { name: v, proxy: { route: { backend: v.split(':')[1] || 'jev', bare: true } }, agentArgs: [] };
  const p = resolveProfile(v);
  return { name: v, proxy: { profile: v }, agentArgs: p.agentArgs || [] };
}

function runAgent(agent, { prompt, model, cwd, baseUrl, extraArgs = [] }) {
  const args = agent.args.map((a) => fill(a, { prompt }));
  if (model && agent.modelArgs) args.push(...agent.modelArgs.map((a) => fill(a, { model })));
  args.push(...extraArgs);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(agent.cmd, args, {
      cwd,
      env: { ...process.env, ...(agent.env || {}), [agent.baseUrlEnv]: baseUrl + (agent.baseUrlSuffix || '') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), (agent.timeoutSec || 600) * 1000);
    child.on('error', (err) => { stderr += err.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = stdout.trim();
      let turns = null;
      let costUsd = null;
      try {
        const j = JSON.parse(stdout);
        result = j.result ?? result;
        turns = j.num_turns ?? null;
        costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
      } catch { /* plain text agents */ }
      resolve({ code, result, turns, costUsd, stderr: stderr.slice(-2000), ms: Date.now() - started });
    });
  });
}

function check(task, result, cwd, vars) {
  const c = task.check || { type: 'none' };
  if (c.type === 'none') return null;
  if (c.type === 'regex') return new RegExp(fill(c.pattern, vars), 'i').test(result || '');
  if (c.type === 'cmd') {
    return new Promise((resolve) => {
      const p = spawn('sh', ['-c', c.cmd], { cwd, stdio: 'ignore' });
      p.on('close', (code) => resolve(code === 0));
    });
  }
  return null;
}

// Files under the fixture (path -> content) so the judge can see what the
// agent wrote, not only what it said. Capped so runs.json stays readable.
const SNAP_SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (SNAP_SKIP.test(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { out[rel] = fs.readFileSync(p, 'utf8'); } catch { /* binary or unreadable */ } }
    }
  };
  try { walk(dir); } catch { /* dir gone */ }
  return out;
}
const CHANGE_CAP = { file: 24_000, total: 80_000 };
export function diffSnapshot(dir, before) {
  const after = snapshot(dir);
  const changes = {};
  let total = 0;
  for (const [rel, content] of Object.entries(after)) {
    if (before[rel] === content) continue;
    let c = content.length > CHANGE_CAP.file ? `${content.slice(0, CHANGE_CAP.file)}\n… [${content.length - CHANGE_CAP.file} more chars]` : content;
    if (total + c.length > CHANGE_CAP.total) { changes[rel] = `[${content.length} chars, omitted: change cap reached]`; continue; }
    total += c.length;
    changes[rel] = c;
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) changes[rel] = null; // deleted
  return changes; // {} = nothing changed; undefined (older runs.json) = not recorded
}

// Per-request detail kept in runs.json: usage, model, and which blocks were
// compressed (type, chars before/after). `dump` names the request body file
// under <outDir>/dump/ when the bench ran with --dump.
function requestLog(records) {
  return records.map((r) => ({
    seq: r.seq, ts: r.ts, model: r.model, profile: r.profile, status: r.status, ms: r.ms, usage: r.usage, usageRaw: r.usageRaw, units: r.units,
    compression: r.compression
      ? { blocks: r.compression.blocks, before: r.compression.before, after: r.compression.after, terse: r.compression.terse, byType: r.compression.byType, list: r.compression.list }
      : null,
    dump: r.dump,
  }));
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.report) return rebuild(args.report, args);

  const config = JSON.parse(fs.readFileSync(args.config || path.join(HERE, 'tasks.json'), 'utf8'));
  const variants = (args.variants || config.variants.join(',')).split(',');
  const runs = Number(args.runs || config.runs || 3);
  const wanted = args.tasks ? args.tasks.split(',') : null;
  const tasks = config.tasks.filter((t) => !wanted || wanted.includes(t.id));
  const agent = config.agent;
  if (args.agent) agent.cmd = args.agent;
  const outDir = path.resolve(args.out || 'bench-results', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const dump = Boolean(args.dump);
  const fresh = Boolean(args['fresh-output']);
  const specs = Object.fromEntries(variants.map((v) => [v, variantSpec(v)])); // validates names early

  console.log(`tokenladder bench: ${tasks.length} task(s) × ${variants.length} variant(s) × ${runs} run(s) = ${tasks.length * variants.length * runs} measured runs (+${tasks.length * variants.length * Number(args.warmup ?? 1)} warm-up)`);
  console.log(`agent: ${agent.cmd}${args.model ? ` (model ${args.model})` : ''} · results → ${outDir}${dump ? ' · dumping request bodies' : ''}${fresh ? ' · fresh tool output per run' : ''}\n`);

  const warmup = Number(args.warmup ?? 1);
  const results = [];
  const meta = { agent: agent.cmd, agentArgs: agent.args, model: args.model || 'default', runs, warmup, variants, freshOutput: fresh, startedAt: new Date().toISOString(), node: process.version };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  // One agent run on a fixed path per task/variant. The path is fixed because
  // Claude Code puts the working directory in its system prompt: a random temp
  // dir per run would make every run a cold-cache run, which no real user sees.
  async function once(task, variant, run, measured) {
    const cwd = path.join(os.tmpdir(), 'tp-bench', task.id, variant);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
    const runName = measured ? `run${run}` : `warmup${run}`;
    const vars = buildFixture(cwd, { nonce: fresh ? `${task.id}-${variant}-${runName}-${Date.now().toString(36)}` : null });
    const before = snapshot(cwd);
    const dumpDir = dump ? path.join(outDir, 'dump', task.id, variant, runName) : null;
    const spec = specs[variant];
    const proxy = createProxy({ ...spec.proxy, label: `bench:${task.id}`, logFile: args.log || null, dumpDir });
    const port = await proxy.listen(0);
    const startedAt = new Date().toISOString();
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await runAgent(agent, { prompt: task.prompt, model: args.model, cwd, baseUrl: `http://127.0.0.1:${port}`, extraArgs: spec.agentArgs });
      // No request reached the proxy and the process died at once: the agent
      // binary is missing or being replaced (e.g. Claude Code auto-updating).
      // Retry a few times, then stop instead of recording empty runs.
      const spawnFailed = !proxy.records.length && res.code !== 0 && res.ms < 2000;
      if (!spawnFailed) break;
      if (attempt >= 5) { await proxy.close(); throw new Error(`"${agent.cmd}" failed to start ${attempt} times (${res.stderr.trim().split('\n').pop()}); stopping. Results so far are in ${outDir}`); }
      console.log(`  ! "${agent.cmd}" failed to start (${res.stderr.trim().split('\n').pop()}); retrying in 10s (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 10000));
    }
    await proxy.close();

    const usage = emptyUsage();
    const comp = { blocks: 0, before: 0, after: 0, byType: {} };
    for (const r of proxy.records) {
      addUsage(usage, r.usage);
      if (r.compression) {
        comp.blocks += r.compression.blocks; comp.before += r.compression.before; comp.after += r.compression.after;
        for (const [t, v] of Object.entries(r.compression.byType || {})) {
          const b = (comp.byType[t] ||= { blocks: 0, before: 0, after: 0 });
          b.blocks += v.blocks; b.before += v.before; b.after += v.after;
        }
      }
    }
    const pass = await check(task, res.result, cwd, vars);
    const changes = diffSnapshot(cwd, before);
    const first = proxy.records[0];
    const row = {
      task: task.id, variant, run, measured, startedAt, pass, exit: res.code, turns: res.turns,
      model: proxy.records.find((r) => r.model)?.model || null,
      profile: first?.profile || spec.name,
      route: first?.route || null,
      requests: requestLog(proxy.records),
      usage, context: usage.input + usage.cacheWrite + usage.cacheRead, units: units(usage), costUsd: res.costUsd,
      compression: comp, ms: res.ms, result: res.result,
      changes, // files the agent added or changed, for the judge
      stderr: res.code ? res.stderr : undefined,
    };
    const p = !measured ? 'w' : pass === null ? '·' : pass ? '✓' : '✗';
    const routed = first?.route ? `  → ${first.route.profile}${first.route.error ? ' (rules)' : ''}` : '';
    const priced = usdOf(row); // per answering model; res.costUsd is the agent's own figure (launch model)
    const usd = (priced != null ? `  $${priced.toFixed(4)}` : res.costUsd != null ? `  $${res.costUsd.toFixed(4)}` : '') + routed;
    const cut = comp.blocks ? `  cut ${comp.before}→${comp.after} chars` : '';
    console.log(`${p} ${task.id.padEnd(14)} ${variant.padEnd(12)} ${measured ? `run ${run}` : `warmup ${run}`}${usd}  ctx ${fmt(row.context).padStart(8)} (cw ${fmt(usage.cacheWrite).padStart(6)})  out ${String(usage.output).padStart(5)}  reqs ${row.requests.length}${cut}  ${(res.ms / 1000).toFixed(0)}s${res.code ? `  exit ${res.code}` : ''}`);
    if (!proxy.records.length) console.log(`  ! no requests reached the proxy — is "${agent.cmd}" honoring ${agent.baseUrlEnv}? stderr: ${res.stderr.split('\n').slice(-3).join(' ')}`);
    if (!args.keep) fs.rmSync(cwd, { recursive: true, force: true });
    return row;
  }

  const all = []; // measured + warm-up, for runs.json
  const save = () => fs.writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify(all, null, 2));
  for (const task of tasks) {
    // Warm-up runs (not measured) so every measured run starts with the
    // provider's prompt cache in the same state, like a user mid-session.
    for (let w = 1; w <= warmup; w++) for (const variant of variants) { all.push(await once(task, variant, w, false)); save(); }
    for (let run = 1; run <= runs; run++) {
      // Alternate the order each run so drift doesn't favor one side.
      const order = run % 2 ? variants : [...variants].reverse();
      for (const variant of order) {
        const row = await once(task, variant, run, true);
        results.push(row); all.push(row); save();
      }
    }
  }

  let judged = null;
  if (args.judge) judged = await judgeDir(outDir, results, variants, agent, args, tasks);
  const report = buildReport(results, variants, meta, judged);
  fs.writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
  return 0;
}

// Grades runs with an LLM judge (bench/judge.js). Results are cached in
// <dir>/judge.json and reused unless --rejudge is given.
async function judgeDir(dir, results, variants, agent, args, tasks) {
  const file = path.join(dir, 'judge.json');
  const model = args.judge === true ? 'sonnet' : args.judge;
  let previous = null;
  if (!args.rejudge && fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j.model === model) previous = j; }
  const prompts = Object.fromEntries(tasks.map((t) => [t.id, t.prompt]));
  const judged = await judgeRuns(results, variants, { model, agent, prompts, previous, onProgress: (m) => console.log(m) });
  fs.writeFileSync(file, JSON.stringify(judged, null, 2));
  return judged;
}

// Rebuild report.md from existing runs.json files (no agent runs, no cost).
// Several dirs (comma-separated) are merged, e.g. a main run plus a re-run of
// some tasks: a later dir's run replaces an earlier one with the same
// task/variant/run. report.md is written to the first dir.
async function rebuild(dirs, args = {}) {
  const list = String(dirs).split(',');
  let rows = [];
  let meta = { agent: '?', model: '?', runs: '?' };
  const allVariants = [];
  for (const dir of list) {
    rows = rows.concat(JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')));
    try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); meta = { ...meta, ...m }; for (const v of m.variants || []) if (!allVariants.includes(v)) allVariants.push(v); } catch { /* older result dir */ }
  }
  const byKey = new Map();
  for (const r of rows.filter((r) => r.measured !== false)) byKey.set(`${r.task}|${r.variant}|${r.run}`, r);
  let measured = [...byKey.values()];
  if (args.tasks) { const wanted = String(args.tasks).split(','); measured = measured.filter((r) => wanted.includes(r.task)); }
  const variants = allVariants.length ? allVariants : [...new Set(measured.map((r) => r.variant))];
  let judged = null;
  if (args.judge) {
    const config = JSON.parse(fs.readFileSync(args.config || path.join(HERE, 'tasks.json'), 'utf8'));
    judged = await judgeDir(list[0], measured, variants, config.agent, args, config.tasks);
  }
  const report = buildReport(measured, variants, { ...meta, variants, sources: list }, judged);
  fs.writeFileSync(path.join(list[0], 'report.md'), report);
  console.log(report);
  return 0;
}

// ---------------------------------------------------------------- report

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function sd(xs) { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); }
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const range = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.length && lo !== hi ? `${fmt(lo)}–${fmt(hi)}` : fmt(xs[0] ?? 0); };
const delta = (v, base) => (base ? `${v / base - 1 >= 0 ? '+' : ''}${((v / base - 1) * 100).toFixed(1)}%` : '—');
const nReq = (r) => (Array.isArray(r.requests) ? r.requests.length : Number(r.requests) || 0);
const ctxOf = (r) => r.context ?? (r.usage.input + r.usage.cacheWrite + r.usage.cacheRead);
// List-price dollars, priced per request by the model that answered it. Claude
// Code's own total_cost_usd prices every request at the model it was launched
// with, so it is wrong whenever the proxy switched the model.
const usdOf = (r) => {
  if (!Array.isArray(r.requests)) return r.costUsd ?? null;
  let sum = 0;
  for (const q of r.requests) { const v = q.usd ?? usd(q.usage, q.model); if (v == null) return r.costUsd ?? null; sum += v; }
  return sum;
};

const failed = (r) => !nReq(r) && r.exit !== 0;

export function buildReport(allResults, variants, meta, judged = null) {
  const results = allResults.filter((r) => !failed(r));
  const dropped = allResults.length - results.length;
  const base = variants[0];
  const tasks = [...new Set(results.map((r) => r.task))];
  const main = [];
  const cost = [];
  const totals = Object.fromEntries(variants.map((v) => [v, { context: 0, output: 0, units: 0, pass: 0, checked: 0, usd: 0, hasUsd: false, cells: 0 }]));
  const baseUsdByTask = {};

  for (const task of tasks) {
    const cell = (v) => results.filter((r) => r.task === task && r.variant === v);
    const b = cell(base);
    const baseCtx = mean(b.map(ctxOf));
    const baseOut = mean(b.map((r) => r.usage.output));
    const baseUnits = mean(b.map((r) => r.units));
    for (const v of variants) {
      const rs = cell(v);
      if (!rs.length) continue;
      const checked = rs.filter((r) => r.pass !== null);
      const passed = checked.filter((r) => r.pass).length;
      const ctx = rs.map(ctxOf);
      const out = rs.map((r) => r.usage.output);
      const u = rs.map((r) => r.units);
      const cw = rs.map((r) => r.usage.cacheWrite);
      const usds = rs.map(usdOf).filter((x) => x != null);
      const usd = usds.length ? mean(usds) : null;
      const cutB = rs.reduce((a, r) => a + r.compression.before, 0);
      const cutA = rs.reduce((a, r) => a + r.compression.after, 0);
      const t = totals[v];
      t.context += mean(ctx); t.output += mean(out); t.units += mean(u); t.pass += passed; t.checked += checked.length; t.cells++;
      if (usd != null) { t.usd += usd; t.hasUsd = true; }
      const isBase = v === base;
      if (isBase && usd != null) baseUsdByTask[task] = usd;
      main.push([
        task, v, checked.length ? `${passed}/${checked.length}` : 'n/a', mean(rs.map(nReq)).toFixed(1),
        fmt(mean(ctx)), range(ctx), isBase ? 'baseline' : delta(mean(ctx), baseCtx),
        fmt(mean(out)), range(out), isBase ? 'baseline' : delta(mean(out), baseOut),
        cutB ? `${((1 - cutA / cutB) * 100).toFixed(0)}% of ${fmt(cutB / rs.length)}` : '—',
      ]);
      const models = [...new Set(rs.map((r) => (r.model || '?').replace(/^claude-/, '')))].join('/');
      const profiles = [...new Set(rs.map((r) => r.profile).filter(Boolean))].join('/');
      cost.push([
        task, v, models + (profiles && profiles !== v ? ` (${profiles})` : ''), fmt(mean(rs.map((r) => r.usage.input))), fmt(mean(cw)), range(cw), fmt(mean(rs.map((r) => r.usage.cacheRead))),
        usd != null ? `$${usd.toFixed(4)}` : '—', isBase || usd == null || !baseUsdByTask[task] ? (isBase ? 'baseline' : '—') : delta(usd, baseUsdByTask[task]),
        fmt(mean(u)), `±${fmt(sd(u))}`, isBase ? 'baseline' : delta(mean(u), baseUnits),
      ]);
    }
  }

  const totalRows = variants.map((v) => {
    const t = totals[v];
    const isBase = v === base;
    return [
      v, t.checked ? `${t.pass}/${t.checked}` : 'n/a',
      fmt(t.context), isBase ? 'baseline' : delta(t.context, totals[base].context),
      fmt(t.output), isBase ? 'baseline' : delta(t.output, totals[base].output),
      fmt(t.units), isBase ? 'baseline' : delta(t.units, totals[base].units),
      t.hasUsd ? `$${t.usd.toFixed(4)}` : '—', isBase || !t.hasUsd || !totals[base].hasUsd ? (isBase ? 'baseline' : '—') : delta(t.usd, totals[base].usd),
    ];
  });

  return [
    `# tokenladder benchmark`,
    ``,
    `agent: ${meta.agent} · model: ${meta.model} · runs per cell: ${meta.runs} · numbers are means per run (min–max over runs in brackets), as reported by the provider`,
    ...(meta.sources?.length > 1 ? [`merged from: ${meta.sources.join(', ')}`] : []),
    ...(dropped ? [`⚠ ${dropped} run(s) where the agent failed to start (no requests, non-zero exit) were left out; cells with fewer runs than expected show it in "solved".`] : []),
    ``,
    `**context** = input + cache write + cache read: every prompt token the model saw, summed over the run's requests. It does not depend on whether the provider's cache hit, so it is the metric to compare variants on. Lower context means the proxy sent less.`,
    `**output** = tokens generated. **reqs** = API requests per run (more requests = more context, even with no compression).`,
    ``,
    '```',
    table(['task', 'variant', 'solved', 'reqs', 'context', 'ctx min–max', 'Δ context', 'output', 'out min–max', 'Δ output', 'tool output cut'], main),
    '```',
    ``,
    `## Cache and cost (depends on the provider's cache state; noisy between identical runs)`,
    ``,
    `cost = list-price USD per run, each request priced at the model that answered it (Claude Code's own total_cost_usd prices everything at the launch model, so it is wrong when the proxy switches models). On a Pro/Max plan it is notional: usage counts against your limits.`,
    `units = input + 1.25×cache write (2× for the 1h-TTL part) + 0.1×cache read + 5×output: token-weighted, model-blind. Compare models with "cost", compare prompt sizes with "context". ±sd = sample standard deviation over runs${meta.freshOutput ? ' · fresh tool output per run (tool outputs are cache writes, as in a real session)' : ''}`,
    ``,
    '```',
    table(['task', 'variant', 'model (profile)', 'input', 'cache w', 'cache w min–max', 'cache r', 'cost', 'Δ cost', 'units', '±sd', 'Δ units'], cost),
    '```',
    ``,
    `## Totals (sum of per-task means)`,
    '```',
    table(['variant', 'solved', 'context', 'Δ context', 'output', 'Δ output', 'units', 'Δ units', 'cost', 'Δ cost'], totalRows),
    '```',
    ``,
    `A cheaper variant only counts if "solved" didn't drop. Negative Δ = less than ${base}. Δ context = how much less the model read; Δ cost = dollars at list price; Δ units ignores model prices.`,
    ...(judged ? qualitySection(judged, variants, base, results) : []),
  ].join('\n');
}

// ---------------------------------------------------------------- quality (judge)

function qualitySection(judged, variants, base, results) {
  const { perCell, perVariant, anyNoFiles } = qualityRows(judged, variants, base, results);
  return [
    ``,
    `## Quality (judge: ${judged.model}, pairwise vs ${base}, blind order, ${judged.comparisons.length} comparisons · judge cost ${judged.usd != null ? `$${judged.usd.toFixed(4)}` : 'n/a'})`,
    ``,
    `quality = mean score 1–5 given by the judge to the final answer plus the files the agent changed (correctness, completeness, follows the prompt; length is not a criterion). The ${base} score is its mean over the comparisons it took part in. W–T–L = how often the variant beat, tied or lost to the ${base} run of the same number. An LLM judge is noisy: treat gaps under half a point as a tie.`,
    ``,
    '```',
    table(['task', 'variant', 'quality', 'Δ quality', 'W–T–L', 'judge notes'], perCell),
    '```',
    '```',
    table(['variant', 'quality', 'Δ quality', 'W–T–L'], perVariant),
    '```',
    ...(anyNoFiles ? [`† judged from the final message only: this cell comes from a run recorded before the bench kept the files the agent wrote, so the judge could not see its code or pages. Cells without † were judged with the files. Comparing a † cell with a non-† cell on a task that writes files is not apples to apples.`] : []),
  ];
}
