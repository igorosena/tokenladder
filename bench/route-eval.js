// Router eval: classify labeled prompts with each backend and report agreement.
// No agent runs; a Jev call costs a fraction of a cent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../src/router.js';
import { table } from '../src/stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function routeEval(argv) {
  const file = argv.find((a, i) => argv[i - 1] === '--prompts') || path.join(HERE, 'prompts.json');
  const backends = (argv.find((a, i) => argv[i - 1] === '--backends') || 'jev,rules').split(',');
  const minConfidence = Number(argv.find((a, i) => argv[i - 1] === '--min-confidence') || 0.75);
  const { prompts } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const labels = ['lookup', 'edit', 'build', 'open'];
  const rows = [];
  const summary = {};
  for (const b of backends) {
    const res = [];
    for (const p of prompts) res.push(await route(p.text, { backend: b, minConfidence }));
    const ok = res.filter((r, i) => r.profile === prompts[i].label).length;
    const raw = res.filter((r, i) => (r.suggested || r.profile) === prompts[i].label).length; // before the confidence gate
    const fell = res.filter((r) => r.error).length;
    const gated = res.filter((r) => r.suggested).length;
    const ms = res.reduce((a, r) => a + r.ms, 0) / res.length;
    // confusion: label -> chosen
    const conf = Object.fromEntries(labels.map((l) => [l, Object.fromEntries(labels.map((m) => [m, 0]))]));
    res.forEach((r, i) => { conf[prompts[i].label][r.profile]++; });
    summary[b] = { ok, raw, fell, gated, ms, conf, n: prompts.length };
    res.forEach((r, i) => rows.push([b, prompts[i].label, r.profile, r.profile === prompts[i].label ? '' : '✗', r.confidence != null ? r.confidence.toFixed(2) : '—', r.suggested ? `gated (${r.suggested})` : r.error ? 'fallback' : '', prompts[i].text.slice(0, 70)]));
  }
  const out = [`router eval: ${prompts.length} prompts from ${path.relative(process.cwd(), file)} · min confidence ${minConfidence}`, ''];
  out.push(table(['backend', 'agree', 'before gate', 'gated↑', 'fallbacks', 'avg ms'], backends.map((b) => {
    const s = summary[b]; return [b, `${s.ok}/${s.n} (${Math.round(100 * s.ok / s.n)}%)`, `${s.raw}/${s.n}`, s.gated, s.fell, Math.round(s.ms)];
  })));
  for (const b of backends) {
    out.push('', `confusion (${b}): rows = label, cols = chosen`);
    out.push(table(['label', ...labels], labels.map((l) => [l, ...labels.map((m) => summary[b].conf[l][m])])));
  }
  out.push('', 'disagreements:');
  out.push(table(['backend', 'label', 'chosen', '', 'conf', 'note', 'prompt'], rows.filter((r) => r[3] === '✗')));
  console.log(out.join('\n'));
  return 0;
}
