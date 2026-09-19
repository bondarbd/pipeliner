import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../engine/proc.js';
import { stepEnv } from './shell.js';
import * as queue from '../queue.js';

export async function run(step, r) {
  const file = path.resolve(r.templateDir, step.js);
  const log = (m) => fs.appendFileSync(r.logPath, `${m}\n`);
  const home = r.config.home;
  const ctx = {
    run: r.exprCtx.run, item: r.exprCtx.item, out: r.outDir, log,
    queue: { done: (q, id) => queue.done(home, q, id), snooze: (q, id, when) => queue.snooze(home, q, id, when), drop: (q, id, note) => queue.drop(home, q, id, note) },
    sh: (argv, opts = {}) => runProcess({ argv, cwd: opts.cwd || r.cwd, env: stepEnv(r), timeout: opts.timeout || r.timeout, logPath: r.logPath, masker: r.masker, onSpawn: r.onSpawn }),
  };
  try {
    if (!file.startsWith(path.resolve(r.templateDir) + path.sep)) throw new Error(`${step.js} is outside the template directory`);
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const fn = mod.default || mod.run;
    if (typeof fn !== 'function') throw new Error(`${step.js} must export default async (ctx) => object`);
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${r.timeout}s`)), r.timeout * 1000); });
    const output = await Promise.race([fn(ctx), timeout]).finally(() => clearTimeout(timer));
    return { ok: true, output: output ?? {} };
  } catch (e) {
    log(String(e.stack || e));
    return { ok: false, error: e.message };
  }
}
