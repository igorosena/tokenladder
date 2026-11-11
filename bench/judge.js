// LLM judge for bench runs: scores each run's final answer (plus the files
// the agent changed) and compares it blind with the baseline run of the same
// task and number. Runs through `claude -p` with all tools disabled, so it
// uses the same login as the bench and needs no separate API key.
//
// A judge is noisy and shares the biases of its model: it is evidence about
// quality, not proof. Order is randomized per comparison (seeded, so a
// re-judge of the same runs sees the same order).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usd } from '../src/usage.js';
import { MODEL_IDS } from '../src/profiles.js';

const CAP = 30_000; // chars of answer + changes shown per side

export function renderRun(row) {
  const parts = [`Final message to the user:\n${(row.result || '(empty)').slice(0, CAP)}`];
  if (row.changes === undefined) {
    parts.push('Files added or changed by the agent: NOT RECORDED for this run (older benchmark data). Judge the message on its own terms; do not penalize a described edit for lacking a diff here.');
  } else if (Object.keys(row.changes).length) {
    const files = Object.entries(row.changes).map(([p, c]) => (c === null ? `--- ${p} (deleted)` : `--- ${p}\n${c}`)).join('\n\n');
    parts.push(`Files added or changed by the agent:\n${files.slice(0, CAP)}`);
  } else {
    parts.push('Files added or changed by the agent: none');
  }
  return parts.join('\n\n');
}

export function buildJudgePrompt(taskPrompt, a, b) {
  return [
    'You are grading two attempts by a coding agent at the same task. The agent could read and edit files in a small Node project and run shell commands. You see, for each attempt, its final message to the user and the files it added or changed. You do not see the project itself.',
    '',
    `TASK GIVEN TO THE AGENT:\n${taskPrompt}`,
    '',
    `=== ATTEMPT A ===\n${a}`,
    '',
    `=== ATTEMPT B ===\n${b}`,
    '',
    'Grade each attempt from 1 to 5 on whether it did what the task asked: correct facts and code, complete (nothing the task asked for is missing), nothing invented, instructions followed (e.g. "start your reply with the order id", "do not modify the tests"). Length and tone are NOT criteria: a short correct answer scores as high as a long correct one. If both reach the same conclusion and both would satisfy the person who asked, give them the same score. When the file list says NOT RECORDED, take described edits at face value for both attempts.',
    'Then say which is better overall, or "tie" if the difference would not matter to the person who asked.',
    '',
    'Reply with ONLY this JSON, no prose before or after:',
    '{"a": {"score": <1-5>, "issues": "<one short sentence, or empty>"}, "b": {"score": <1-5>, "issues": "<one short sentence, or empty>"}, "better": "a" | "b" | "tie"}',
  ].join('\n');
}

// Extracts the judge's JSON from its reply (it sometimes wraps it in a fence).
export function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge: no JSON in reply: ${String(text).slice(0, 200)}`);
  const v = JSON.parse(m[0]);
  const score = (x) => { const n = Number(x?.score); if (!(n >= 1 && n <= 5)) throw new Error(`judge: bad score ${JSON.stringify(x)}`); return n; };
  const better = ['a', 'b', 'tie'].includes(v.better) ? v.better : 'tie';
  return { a: { score: score(v.a), issues: String(v.a?.issues || '') }, b: { score: score(v.b), issues: String(v.b?.issues || '') }, better };
}

// What a comparison looked at: the two final messages and file changes.
// A re-run of a task replaces its rows; its old verdicts must not be reused.
export const runFingerprint = (a, b) => crypto.createHash('sha256').update(JSON.stringify([a.result || '', a.changes ?? null, b.result || '', b.changes ?? null])).digest('hex').slice(0, 16);

// Deterministic coin per comparison: which side the baseline sits on.
export function baselineFirst(task, variant, run) {
  return crypto.createHash('sha256').update(`${task}|${variant}|${run}`).digest()[0] % 2 === 0;
}

function callJudge(agent, model, prompt, cwd) {
  const args = ['-p', prompt, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', model];
  return new Promise((resolve, reject) => {
    const child = spawn(agent.cmd, args, { cwd, env: { ...process.env, ...(agent.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        const u = j.usage || {};
        const usage = { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        resolve({ text: j.result, usage, model: j.model || null, code });
      } catch (e) { reject(new Error(`judge: could not read reply (exit ${code}): ${err.trim().split('\n').pop() || e.message}`)); }
    });
  });
}

// rows: measured runs. Compares every non-baseline run with the baseline run
// of the same task and run number (or the first baseline run of that task).
// `previous` (an earlier result for the same model) is reused per
// comparison: only runs it has not graded, graded with an error, or graded
// in an earlier version (different fingerprint) are sent.
// The agent binary can vanish for a few seconds while Claude Code updates
// itself (spawn ENOENT): retry those, like the bench does.
const SPAWN_FAIL = /ENOENT|exit 127|failed to start/;
async function callWithRetry(call, args, { retries = 5, waitMs = 10_000, onProgress = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await call(...args); } catch (e) {
      if (!SPAWN_FAIL.test(e.message) || attempt >= retries) throw e;
      onProgress(`judge: ${e.message.trim()}; retrying in ${waitMs / 1000}s (${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export async function judgeRuns(rows, variants, { model = 'sonnet', agent = { cmd: 'claude' }, prompts = {}, previous = null, onProgress = () => {}, call = callJudge, retryWaitMs = 10_000 } = {}) {
  const base = variants[0];
  const modelId = MODEL_IDS[model] || model;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-judge-'));
  fs.writeFileSync(path.join(cwd, 'README.md'), 'judge scratch dir\n');
  const comparisons = [];
  let cost = previous?.usd || 0;
  let hasCost = previous ? previous.usd != null : true;
  const done = new Map((previous?.comparisons || []).filter((c) => !c.error && c.base === base).map((c) => [`${c.task}|${c.variant}|${c.run}`, c]));
  try {
    for (const row of rows) {
      if (row.variant === base) continue;
      const taskRows = rows.filter((r) => r.task === row.task && r.variant === base);
      const b = taskRows.find((r) => r.run === row.run) || taskRows[0];
      if (!b) continue;
      const fingerprint = runFingerprint(row, b);
      const prev = done.get(`${row.task}|${row.variant}|${row.run}`);
      if (prev && (prev.fingerprint === fingerprint || prev.fingerprint === undefined)) { comparisons.push({ ...prev, fingerprint }); continue; }
      const bf = baselineFirst(row.task, row.variant, row.run);
      const [A, B] = bf ? [b, row] : [row, b];
      const prompt = buildJudgePrompt(prompts[row.task] || row.task, renderRun(A), renderRun(B));
      let verdict;
      let usage = null;
      let error = null;
      try {
        const r = await callWithRetry(call, [agent, modelId, prompt, cwd], { waitMs: retryWaitMs, onProgress });
        verdict = parseVerdict(r.text);
        usage = r.usage;
        const c = usd(usage, r.model || modelId);
        if (c == null) hasCost = false; else cost += c;
      } catch (e) { error = e.message; }
      const sideOf = (isBase) => (bf === isBase ? 'a' : 'b');
      const entry = {
        task: row.task, variant: row.variant, run: row.run, base, baseRun: b.run, baselineFirst: bf, fingerprint,
        variantScore: verdict ? verdict[sideOf(false)].score : null,
        baseScore: verdict ? verdict[sideOf(true)].score : null,
        variantIssues: verdict ? verdict[sideOf(false)].issues : '',
        baseIssues: verdict ? verdict[sideOf(true)].issues : '',
        outcome: !verdict ? null : verdict.better === 'tie' ? 'tie' : verdict.better === sideOf(false) ? 'win' : 'loss',
        usage, error,
      };
      comparisons.push(entry);
      onProgress(`judge ${row.task.padEnd(14)} ${row.variant.padEnd(12)} run ${row.run}: ${error ? `error: ${error}` : `${entry.variantScore} vs ${entry.baseScore} (${base}) → ${entry.outcome}`}`);
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  return { model: model, modelId, base, comparisons, usd: hasCost ? cost : null, judgedAt: new Date().toISOString() };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f1 = (n) => (n == null ? '—' : n.toFixed(2));
const dq = (v, b) => (v == null || b == null ? '—' : `${v - b >= 0 ? '+' : ''}${(v - b).toFixed(2)}`);
const wtl = (cs) => `${cs.filter((c) => c.outcome === 'win').length}–${cs.filter((c) => c.outcome === 'tie').length}–${cs.filter((c) => c.outcome === 'loss').length}`;

// Table rows for the report: per task/variant and per variant.
// `rows` (the measured runs) tells which cells were judged without the files
// the agent wrote (older runs.json): those are marked † in the table.
export function qualityRows(judged, variants, base, rows = []) {
  const ok = judged.comparisons.filter((c) => !c.error);
  const noFiles = (task, v) => rows.some((r) => r.task === task && r.variant === v && r.changes === undefined && r.measured !== false);
  const mark = (score, task, v) => (score === '—' ? score : noFiles(task, v) ? `${score}†` : score);
  const tasks = [...new Set(ok.map((c) => c.task))];
  const perCell = [];
  for (const task of tasks) {
    const tc = ok.filter((c) => c.task === task);
    const baseScore = mean(tc.map((c) => c.baseScore));
    perCell.push([task, base, mark(f1(baseScore), task, base), 'baseline', '—', [...new Set(tc.map((c) => c.baseIssues).filter(Boolean))].join(' | ').slice(0, 90)]);
    for (const v of variants) {
      if (v === base) continue;
      const vc = tc.filter((c) => c.variant === v);
      if (!vc.length) continue;
      const score = mean(vc.map((c) => c.variantScore));
      perCell.push([task, v, mark(f1(score), task, v), dq(score, mean(vc.map((c) => c.baseScore))), wtl(vc), [...new Set(vc.map((c) => c.variantIssues).filter(Boolean))].join(' | ').slice(0, 90)]);
    }
  }
  const perVariant = [[base, f1(mean(ok.map((c) => c.baseScore))), 'baseline', '—']];
  for (const v of variants) {
    if (v === base) continue;
    const vc = ok.filter((c) => c.variant === v);
    if (!vc.length) continue;
    perVariant.push([v, f1(mean(vc.map((c) => c.variantScore))), dq(mean(vc.map((c) => c.variantScore)), mean(vc.map((c) => c.baseScore))), wtl(vc)]);
  }
  const anyNoFiles = perCell.some((r) => String(r[2]).endsWith('†'));
  return { perCell, perVariant, anyNoFiles };
}
