import { render } from '../expr.js';
import { runProcess } from '../engine/proc.js';
import { parseOutput } from '../output.js';

export class GitGuardError extends Error {}

export function baseEnv() {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'TMPDIR', 'SHELL', 'TERM', 'JAVA_HOME', 'MAVEN_OPTS'];
  const out = {};
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

const globToRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

export function guardGit(cmd, allowed = []) {
  for (const part of cmd.split(/&&|\|\||;|\n/)) {
    const m = part.match(/\bgit\b(.*)\bpush\b(.*)/);
    if (!m) continue;
    const args = m[2].trim().split(/\s+/).filter(Boolean);
    if (/(^|\s)(--force|-f|--force-with-lease)(=|\s|$)/.test(m[2]) || args.some((a) => a.startsWith('+'))) throw new GitGuardError(`git guard: force push is not allowed: ${part.trim()}`);
    const positional = args.filter((a) => !a.startsWith('-'));
    const ref = positional[1];
    if (ref) {
      const branch = ref.includes(':') ? ref.split(':').pop() : ref;
      if (!allowed.some((g) => globToRe(g).test(branch))) throw new GitGuardError(`git guard: push to '${branch}' is not allowed (allowed: ${allowed.join(', ')})`);
    }
  }
}

export function stepEnv(r) {
  return { ...baseEnv(), ...r.env, OUT: r.outDir, CTX_RUN: r.runCtxDir, CTX_ITEM: r.itemCtxDir || '', RUNBOARD_RUN: r.run.id, RUNBOARD_ITEM: r.item ? r.item.name : '' };
}

export async function run(step, r) {
  let cmd;
  try {
    cmd = render(step.shell, r.exprCtx, { shell: !step.raw });
    guardGit(cmd, r.config.git?.allowed_push_branches || []);
  } catch (e) { return { ok: false, error: e.message }; }
  const res = await runProcess({ shellCmd: cmd, cwd: r.cwd, env: stepEnv(r), timeout: r.timeout, logPath: r.logPath, masker: r.masker,
    maxBytes: r.config.logs?.max_step_log_bytes, onSpawn: r.onSpawn });
  const base = { command: cmd, code: res.code, timedOut: res.timedOut };
  if (res.timedOut) return { ok: false, error: `timeout after ${r.timeout}s`, ...base };
  if (res.code !== 0) {
    const last = res.tail.trim().split('\n').filter((l) => l.trim()).pop() || '';
    return { ok: false, error: `exit ${res.code}${last ? `: ${last.trim().slice(-200)}` : ''}`, ...base };
  }
  try { return { ok: true, output: parseOutput(step.output || 'keys', { tail: res.tail, outDir: r.outDir }), ...base }; }
  catch (e) { return { ok: false, error: e.message, formatError: true, ...base }; }
}
