// Start a proxy on a free port and launch an agent pointed at it.

import { spawn } from 'node:child_process';
import { createProxy } from './server.js';
import { summarize, renderSummary } from './stats.js';
import { resolveProfile } from './profiles.js';

export const AGENTS = {
  claude: { cmd: 'claude', env: 'ANTHROPIC_BASE_URL', suffix: '' },
  codex: { cmd: 'codex', env: 'OPENAI_BASE_URL', suffix: '/v1' },
};

// A profile's agentArgs (e.g. --tools for Claude Code) are passed to the
// agent when the profile is known at launch: the agent then also shrinks its
// own environment message and system prompt, which the proxy cannot touch.
// With --route the profile is only known after the first request, so the
// proxy filters tool definitions but the agent's prefix stays as it is.
export function agentArgsFor(cmd, args, profile) {
  if (!profile || cmd !== 'claude') return [];
  const extra = resolveProfile(profile).agentArgs || [];
  if (!extra.length) return [];
  if (args.some((a) => a === extra[0] || a.startsWith(`${extra[0]}=`))) return [];
  return extra;
}

export async function wrap({ cmd, args = [], env, suffix = '', mode, profile, route, label, logFile }) {
  const extra = agentArgsFor(cmd, args, profile);
  if (extra.length) process.stderr.write(`tokenladder: profile ${profile} adds agent args: ${extra.join(' ')}\n`);
  args = [...args, ...extra];
  const proxy = createProxy({
    mode, profile, route, label, logFile,
    onRoute: (d) => process.stderr.write(`tokenladder: route → ${d.profile} via ${d.backend}${d.error ? ` (jev failed: ${d.error})` : ''}${d.suggested ? ` (jev suggested ${d.suggested}, ${d.reason})` : ''}\n`),
  });
  const port = await proxy.listen(0);
  const base = `http://127.0.0.1:${port}${suffix}`;
  if (cmd === 'codex' && !args.some((a) => a.includes('model_provider'))) {
    args = [
      '-c', 'model_provider="proxy"',
      '-c', `model_providers.proxy={name="proxy",base_url="http://127.0.0.1:${port}",requires_openai_auth=true,supports_websockets=false,wire_api="responses"}`,
      ...args,
    ];
  }
  process.stderr.write(`tokenladder: mode=${proxy.mode} session=${proxy.session} ${env}=${base}\n`);

  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, [env]: base } });
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 0));
    child.on('error', (err) => { process.stderr.write(`tokenladder: could not start "${cmd}": ${err.message}\n`); resolve(127); });
  });
  await proxy.close();
  if (proxy.records.length) {
    process.stderr.write(`\ntokenladder session ${proxy.session}\n${renderSummary(summarize(proxy.records))}\n`);
  }
  return code;
}
