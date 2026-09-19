import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../engine/proc.js';
import { stepEnv } from './shell.js';

export async function run(step, r) {
  const file = path.resolve(r.templateDir, step.js);
  const log = (m) => fs.appendFileSync(r.logPath, `${m}\n`);
  const ctx = {
    run: r.exprCtx.run, item: r.exprCtx.item, out: r.outDir, log,
    sh: (argv, opts = {}) => runProcess({ argv, cwd: opts.cwd || r.cwd, env: stepEnv(r), timeout: opts.timeout || r.timeout, logPath: r.logPath, masker: r.masker, onSpawn: r.onSpawn }),
  };
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const fn = mod.default || mod.run;
    if (typeof fn !== 'function') throw new Error(`${step.js} must export default async (ctx) => object`);
    const output = await fn(ctx);
    return { ok: true, output: output ?? {} };
  } catch (e) {
    log(String(e.stack || e));
    return { ok: false, error: e.message };
  }
}
