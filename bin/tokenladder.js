#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from the current directory, then from the package directory.
// Values already in the environment win. No dependency needed.
for (const dir of [process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')]) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
import { createProxy } from '../src/server.js';
import { wrap, AGENTS } from '../src/wrap.js';
import { readLog, defaultLogFile } from '../src/usage.js';
import { summarize, renderSummary } from '../src/stats.js';
import { compress } from '../src/compress.js';
import { MODES } from '../src/transform.js';
import { PROFILES, PROFILE_NAMES, resolveProfile } from '../src/profiles.js';
import { route } from '../src/router.js';

const HELP = `tokenladder — measure and cut LLM token spend for coding agents

  tokenladder start [--port 8787] [--mode full | --profile lookup | --route jev] [--label A]
      Run the proxy. Point your agent at it:
        Claude Code:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
        OpenAI SDKs:  OPENAI_BASE_URL=http://127.0.0.1:8787/v1

  tokenladder claude [--mode full] [--label A] [claude args...]
  tokenladder codex  [--mode full] [--label A] [codex args...]
      Start a private proxy and launch the agent through it. Prints a summary on exit.

  tokenladder run --env VAR [--suffix /v1] [--mode full] -- <cmd> [args...]
      Same, for any agent that reads a base-URL env var.

  tokenladder stats [--log file] [--since 2026-10-15] [--by mode|label|session]
      Totals from the usage log.

  tokenladder compress <file>
      Show what the compressor does to a saved tool output.

  tokenladder route "<prompt>" [--backend jev|rules]
      Show which profile the router would pick for a prompt (jev needs TYPESAFE_API_KEY).
  tokenladder route-eval [--backends jev,rules] [--prompts bench/prompts.json]
      Classify labeled prompts with each backend and report agreement (no agent runs).

  tokenladder bench [--runs 3] [--variants passthrough,direct,route] [--tasks id,...] [--model name] [--dump] [--judge [model]]
      A/B benchmark: same tasks, same prompts, through the proxy in each variant.
      Variants: a mode, a profile, a spec, route[:jev|rules] (proxy picks the rung and applies it),
      direct[:jev|rules] (same rung, model switch only: the user picking the cheap model by hand).
      --judge grades every run blind against the baseline run with an LLM (default sonnet), via claude -p.
      --dump saves every request body (no auth headers) under <results>/dump/.
  tokenladder bench --report bench-results/<dir>[,<dir2>] [--judge [model]] [--tasks id,...] [--rejudge]
      Rebuild report.md from existing runs.json files (no agent runs); --judge grades them (judge calls only).

Modes: ${MODES.join(' | ')}
  passthrough  measure only, forward bytes untouched (the baseline)
  compress     shrink large tool outputs (logs, json, csv, diffs, grep results)
  terse        ask the model for short answers
  full         compress + terse

Profiles (--profile): ${PROFILE_NAMES.join(' | ')}, or a spec like model=haiku+effort=low+compress+terse+ttl=5m+tools=basic
  A profile also sets model, effort, cache TTL and the tool list. --route jev|rules picks one per session
  from the first prompt (lookup / edit / open).

Log: ${defaultLogFile()} (override with --log or TOKENLADDER_LOG)`;

function parse(argv, known) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (name && known.includes(name)) flags[name] = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

const [cmd, ...argv] = process.argv.slice(2);

// --mode / --profile / --route → createProxy options. --profile and --route win over --mode.
function selection(flags) {
  if (flags.route) return { route: { backend: flags.route === true ? 'jev' : flags.route } };
  if (flags.profile) return { profile: flags.profile };
  return { mode: flags.mode || 'full' };
}

switch (cmd) {
  case 'start': {
    const { flags } = parse(argv, ['port', 'mode', 'profile', 'route', 'label', 'log']);
    const proxy = createProxy({
      ...selection(flags),
      label: flags.label,
      logFile: flags.log,
      onRoute: (d) => console.log(`route: session ${d.key} → ${d.profile}${d.suggested ? ` (jev suggested ${d.suggested}, ${d.reason})` : ''} via ${d.backend}${d.error ? ` (jev failed: ${d.error})` : ''} in ${d.ms}ms · "${d.prompt.slice(0, 80)}"`),
      onRecord: (r) => {
        const c = r.compression?.blocks ? ` · compressed ${r.compression.blocks} block(s) ${r.compression.before}→${r.compression.after} chars` : '';
        const u = r.usage ? `in ${r.usage.input} · cache w/r ${r.usage.cacheWrite}/${r.usage.cacheRead} · out ${r.usage.output}` : 'no usage';
        console.log(`${r.ts.slice(11, 19)} ${r.model || r.path} ${r.status} ${u}${c}${r.profile && r.profile !== r.mode ? ` · profile ${r.profile}` : ''}`);
      },
    });
    const port = await proxy.listen(Number(flags.port || 8787));
    console.log(`tokenladder listening on http://127.0.0.1:${port}  mode=${proxy.mode}  session=${proxy.session}`);
    console.log(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
    console.log(`  export OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
    const stop = async () => { await proxy.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    break;
  }

  case 'claude':
  case 'codex': {
    const { flags, rest } = parse(argv, ['mode', 'profile', 'route', 'label', 'log']);
    const a = AGENTS[cmd];
    process.exitCode = await wrap({ cmd: a.cmd, args: rest, env: a.env, suffix: a.suffix, ...selection(flags), label: flags.label, logFile: flags.log });
    break;
  }

  case 'run': {
    const { flags, rest } = parse(argv, ['env', 'suffix', 'mode', 'profile', 'route', 'label', 'log']);
    if (!flags.env || !rest.length) { console.error('usage: tokenladder run --env VAR [--suffix /v1] -- <cmd> [args]'); process.exit(2); }
    process.exitCode = await wrap({ cmd: rest[0], args: rest.slice(1), env: flags.env, suffix: flags.suffix || '', ...selection(flags), label: flags.label, logFile: flags.log });
    break;
  }

  case 'route': {
    const { flags, rest } = parse(argv, ['backend', 'min-confidence']);
    const prompt = rest.join(' ');
    if (!prompt) { console.error('usage: tokenladder route "<prompt>" [--backend jev|rules]'); process.exit(2); }
    const d = await route(prompt, { backend: flags.backend || (process.env.TYPESAFE_API_KEY ? 'jev' : 'rules'), minConfidence: flags['min-confidence'] ? Number(flags['min-confidence']) : undefined });
    const prof = resolveProfile(d.profile);
    console.log(`profile: ${d.profile}  (backend ${d.backend}${d.requested !== d.backend ? `, requested ${d.requested}` : ''}, ${d.ms}ms)`);
    if (d.confidence != null) console.log(`confidence: ${d.confidence}  probabilities: ${JSON.stringify(d.probabilities)}`);
    if (d.suggested) console.log(`jev suggested "${d.suggested}" but ${d.reason}; using the safe profile`);
    if (d.error) console.log(`jev error: ${d.error}`);
    if (d.usage) console.log(`jev usage: ${JSON.stringify(d.usage)} model ${d.model}`);
    console.log(`applies: ${JSON.stringify({ model: prof.model || '(agent default)', effort: prof.effort || '(agent default)', compress: !!prof.compress, terse: !!prof.terse, cacheTtl: prof.cacheTtl || '(agent default)', tools: prof.tools || '(all)' })}`);
    break;
  }

  case 'stats': {
    const { flags } = parse(argv, ['log', 'since', 'by']);
    let records = readLog(flags.log || defaultLogFile());
    if (flags.since) records = records.filter((r) => r.ts >= flags.since);
    if (!records.length) { console.log('No usage logged yet.'); break; }
    const by = flags.by;
    const groupBy = by === 'session' ? (r) => `${r.mode}/${r.session}` : by === 'label' ? (r) => r.label || '(none)' : undefined;
    console.log(renderSummary(summarize(records, groupBy ? { groupBy } : {})));
    break;
  }

  case 'compress': {
    const file = argv[0];
    if (!file) { console.error('usage: tokenladder compress <file>'); process.exit(2); }
    const r = compress(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${r.text}\n`);
    console.error(`\n[${r.type}] ${r.before} → ${r.after} chars${r.changed ? ` (${((1 - r.after / r.before) * 100).toFixed(1)}% smaller)` : ' (unchanged)'}`);
    break;
  }

  case 'route-eval': {
    const { routeEval } = await import('../bench/route-eval.js');
    process.exitCode = await routeEval(argv);
    break;
  }

  case 'bench': {
    const { main } = await import('../bench/run.js');
    process.exitCode = await main(argv);
    break;
  }

  default:
    console.log(HELP);
    if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
}
