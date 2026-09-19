import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadEnvFile, DEFAULTS } from '../config.js';
import { readTemplate, loadTemplates } from '../template/load.js';
import { validateTemplate } from '../template/validate.js';
import { Manager, NeedsTrust } from '../engine/manager.js';
import { defaultRunners } from '../runners/index.js';
import * as store from '../engine/store.js';
import { isAlive } from '../engine/proc.js';
import { instanceLock, LockBusy } from '../engine/locks.js';
import { createMasker, secretValues } from '../secrets.js';
import { previewRows } from '../preview.js';
import { table } from './table.js';

export const PKG_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const templateDirs = (home) => [path.join(PKG_ROOT, 'templates'), path.join(home, 'templates')];

// recover=false: only templates are loaded, run.json files on disk are never touched (render, --dry-run)
async function manager(io, recover = true) {
  const m = new Manager({ home: io.home, config: io.config, runners: await defaultRunners(), envValues: loadEnvFile(io.config.env_file), templateDirs: templateDirs(io.home) });
  return m.init({ recover });
}
const maskerFor = (io) => createMasker(secretValues(loadEnvFile(io.config.env_file)));
const splitItems = (args) => (args.items ? args.items.split(',') : []);
const nullable = (s) => (s === '_' || s === '-' ? null : s);

function liveServer(home) {
  try { const s = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')); return isAlive(s.pid) ? s : null; } catch { return null; }
}
async function api(io, method, p, body) {
  const s = liveServer(io.home);
  const token = fs.readFileSync(path.join(io.home, 'token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${s.port}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-runboard-token': token }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { payload: j });
  return j;
}
// an in-process command that mutates run state takes the instance lock so it never races a live `runboard serve`
async function withInstanceLock(io, fn) {
  let lock;
  try { lock = instanceLock(io.home); }
  catch (e) {
    if (e instanceof LockBusy) { io.out(`runboard serve is running (${e.owner}) — use the server`); return 1; }
    throw e;
  }
  try { return await fn(); }
  finally { lock.release(); }
}
// runs `create`; on a not-yet-trusted template either trusts it (--yes) and retries, or explains and returns null
async function createTrusting(io, args, name, create, trust) {
  for (;;) {
    try { return await create(); }
    catch (e) {
      const nt = e instanceof NeedsTrust ? e : e.payload?.needsTrust ? e.payload : null;
      if (!nt) throw e;
      if (!args.yes) { io.out(`template ${name} is not trusted. Commands:\n  ${nt.commands.join('\n  ')}\nre-run with --yes to trust`); return null; }
      await trust(nt.hash);
    }
  }
}

export async function init(args, io) {
  fs.mkdirSync(io.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(io.home, 'templates'), { recursive: true });
  const f = path.join(io.home, 'config.yaml');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, `# runboard config — see README\nprojects_root: ${DEFAULTS.projects_root}\nskills_root: ${DEFAULTS.skills_root}\nenv_file: ${DEFAULTS.env_file}\nagent:\n  command: ["gigacode", "-p", "{prompt}", "--approval-mode", "auto-edit"]\n  readonly_command: ["gigacode", "-p", "{prompt}", "--approval-mode", "plan"]\n  max_parallel: 2\n  timeout: 1800\nlimits:\n  parallel: 4\n  max_attempts: 3\n  max_agent_calls: 30\nlogs:\n  retention_days: 14\n`, { mode: 0o600 });
    io.out(`created ${f}`);
  } else io.out(`exists ${f}`);
  io.out(`templates dir: ${path.join(io.home, 'templates')}`);
  return 0;
}

export async function doctor(args, io) {
  const cfg = io.config; const rows = []; let bad = 0;
  const check = (name, ok, hint, optional = false) => { rows.push([name, ok ? '✓' : optional ? '–' : '✗', ok ? '' : hint]); if (!ok && !optional) bad++; };
  const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
  check(`node ${process.version}`, Number(process.versions.node.split('.')[0]) >= 18, 'install Node >= 18');
  check('git', has('git'), 'install git');
  check('python3', has('python3'), 'needed by work-skills scripts', true);
  check(`agent command (${cfg.agent.command[0]})`, has(cfg.agent.command[0]), `set agent.command in ${path.join(io.home, 'config.yaml')} (gigacode on corp PC, claude locally)`, true);
  check(`projects_root ${cfg.projects_root}`, fs.existsSync(cfg.projects_root), 'set projects_root in config.yaml');
  check(`skills_root ${cfg.skills_root}`, fs.existsSync(cfg.skills_root), 'set skills_root (dir with release/, mpr/ skills)', true);
  const envOk = fs.existsSync(cfg.env_file);
  check(`env_file ${cfg.env_file}`, envOk, 'create it from work-skills/release/config.example.env', true);
  if (envOk) check('env_file mode 0600', (fs.statSync(cfg.env_file).mode & 0o077) === 0, `chmod 600 ${cfg.env_file}`);
  const env = loadEnvFile(cfg.env_file);
  if (env.JENKINS_URL) {
    let ok = false, hint = '';
    try { const r = await fetch(`${env.JENKINS_URL.replace(/\/$/, '')}/api/json?tree=mode`, { headers: { authorization: `Basic ${Buffer.from(`${env.JENKINS_USER}:${env.JENKINS_TOKEN}`).toString('base64')}` }, signal: AbortSignal.timeout(5000) }); ok = r.ok; hint = `HTTP ${r.status}`; } catch (e) { hint = e.message; }
    check(`jenkins ${env.JENKINS_URL}`, ok, `check JENKINS_URL/USER/TOKEN (${hint})`, true);
  }
  const { errors } = loadTemplates(templateDirs(io.home));
  check(`templates (${templateDirs(io.home).join(', ')})`, errors.length === 0, errors.map((e) => `${e.file}: ${e.errors[0].message}`).join('; '));
  io.out(table(rows));
  return bad ? 1 : 0;
}

export async function validate(args, io) {
  const target = args._[0];
  const file = target.endsWith('.yaml') || target.endsWith('.yml') ? path.resolve(target) : templateDirs(io.home).map((d) => path.join(d, `${target}.yaml`)).find((f) => fs.existsSync(f));
  if (!file) { io.err(`template not found: ${target}`); return 1; }
  const { tpl, hash } = readTemplate(file);
  const errs = validateTemplate(tpl);
  if (errs.length) { io.out(errs.map((e) => `${file}: ${e.path}: ${e.message}`).join('\n')); return 1; }
  io.out(`OK ${tpl.name} ${hash.slice(0, 12)} (${tpl.steps.length} steps)`);
  return 0;
}

async function preview(args, io, name) {
  const m = await manager(io, false);
  const t = m.templates.get(name);
  if (!t) { io.err(`template not found: ${name}`); return null; }
  const items = args.items ? splitItems(args) : args.item ? [args.item] : [];
  return previewRows(m, t, { params: args.params, items }, maskerFor(io));
}
export async function renderCmd(args, io) {
  const rows = await preview(args, io, args._[0]); if (!rows) return 1;
  const row = rows.find((r) => r.step === args.step && (r.item === '*' || !args.item || r.item === args.item));
  if (!row) { io.err(`step or item not found: ${args.step} ${args.item || ''}`); return 1; }
  io.out(row.command);
  return row.command.startsWith('ERROR') ? 1 : 0;
}

function printRun(run, io) {
  const info = (c) => c.error || (c.waiting ? `? ${c.waiting.question}` : c.via === 'check' ? 'via check' : '');
  const rows = [];
  for (const s of run.steps) {
    if (s.once) rows.push(['*', s.name, run.once[s.name].status, info(run.once[s.name])]);
    else for (const it of run.items) { const c = run.cells[it.name]?.[s.name]; if (c) rows.push([it.name, s.name, c.status, info(c)]); }
  }
  io.out(`run ${run.id} [${run.templateName}] status=${run.status}${run.note ? ` note=${run.note}` : ''}${run.pilot ? ` pilot=${run.pilot.item}:${run.pilot.status}` : ''}`);
  io.out(table(rows, ['item', 'step', 'status', 'info']));
  return run.status === 'done' ? 0 : 2;
}

// --answer covers human steps and the pilot gate, never an agent's free-text NEED_INPUT question;
// without a terminal there is nobody to ask, so null is returned and the run is left waiting
async function ask(io, question, options, { canned = true } = {}) {
  if (canned && io.answer !== undefined) return io.answer;
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question(`${question} ${options.length ? `[${options.join('/')}] ` : ''}`, res));
  rl.close();
  return a.trim();
}
// drives an in-process engine to a stop, answering human steps and the pilot gate from the terminal
async function followEngine(e, io) {
  for (;;) {
    await e.idle();
    const run = e.run;
    let item = '__pilot__', step = null, question, options, canned = true;
    if (run.pilot?.status === 'waiting') { question = `Пилот ${run.pilot.item} прошёл. Продолжать на остальных?`; options = ['Да', 'Нет']; }
    else {
      const waiting = [...e.allCells()].find(([, , c]) => c.status === 'waiting');
      if (!waiting) return run;
      const c = waiting[2];
      item = waiting[0]; step = waiting[1].name; question = `${item ?? '*'}/${step}: ${c.waiting.question}`; options = c.waiting.options; canned = !c.needInput;
    }
    const a = await ask(io, question, options, { canned });
    if (a === null) {
      io.out(`waiting for input — ${question}\n  answer with: runboard answer ${run.id} ${item ?? '_'} ${step ?? '-'} TEXT`);
      return run;
    }
    e.answer(item, step, { answer: a });
  }
}
async function serverFollow(io, id, waitSeconds = 0) {
  let r = await api(io, 'GET', `/runs/${id}`);
  const until = Date.now() + Math.max(0, waitSeconds) * 1000;
  while ((r.status === 'running' || r.status === 'waiting_for_human') && Date.now() < until) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await api(io, 'GET', `/runs/${id}`);
  }
  return r;
}

export async function run(args, io) {
  const name = args._[0];
  const req = { template: name, params: args.params, items: splitItems(args), mode: args.mode || 'all' };
  if (args['dry-run']) {
    const rows = await preview(args, io, name); if (!rows) return 1;
    io.out(table(rows.map((r) => [r.item, r.step, r.command]), ['item', 'step', 'command']));
    return rows.some((r) => r.command.startsWith('ERROR')) ? 1 : 0;
  }
  if (liveServer(io.home)) {
    const created = await createTrusting(io, args, name, () => api(io, 'POST', '/runs', req), (hash) => api(io, 'POST', `/templates/${name}/trust`, { hash }));
    if (!created) return 3;
    io.out(`started ${created.id} (server)`);
    return 0;
  }
  return withInstanceLock(io, async () => {
    const m = await manager(io);
    if (!m.templates.has(name)) { io.err(`template not found: ${name}`); return 1; }
    const created = await createTrusting(io, args, name,
      () => m.create({ templateName: name, ...req, initiator: { via: 'cli', user: os.userInfo().username } }), (hash) => m.trust(name, hash));
    if (!created) return 3;
    io.out(`started ${created.id}`);
    return printRun(await followEngine(m.engine(created.id), io), io);
  });
}

export async function list(args, io) {
  const runs = liveServer(io.home) ? await api(io, 'GET', '/runs') : store.listRuns(io.home);
  io.out(table(runs.map((r) => [r.id, r.templateName, r.status, r.mode, r.items, r.createdAt]), ['id', 'template', 'status', 'mode', 'items', 'created']));
  return 0;
}
export async function show(args, io) {
  printRun(liveServer(io.home) ? await api(io, 'GET', `/runs/${args._[0]}`) : store.loadRun(io.home, args._[0]), io);
  return 0;
}
export async function log(args, io) {
  const [id, item, step] = args._;
  const run = store.loadRun(io.home, id);
  const c = store.itemCell(run, nullable(item), step);
  if (!c.seq) { io.err(`${item}/${step} has not run yet`); return 1; }
  const kind = args.kind || 'log';
  if (!store.LOG_KINDS.includes(kind)) { io.err(`--kind must be ${store.LOG_KINDS.join('|')}`); return 1; }
  const file = store.logFile(run, nullable(item), step, c.seq, kind);
  if (!fs.existsSync(file)) { io.err(`no ${kind} for ${item}/${step} (attempt ${c.seq}): ${file}`); return 1; }
  io.out(`# ${file}`);
  io.out(store.tailFile(file, Number(args.bytes) || 4096).trimEnd());
  return 0;
}
// a user action on a live run: through the server when it is up, otherwise in-process under the instance lock
async function engineAction(args, io, id, viaServer, local) {
  if (liveServer(io.home)) { await viaServer(); return printRun(await serverFollow(io, id, Number(args.wait) || 0), io); }
  return withInstanceLock(io, async () => {
    const m = await manager(io); const e = m.engine(id);
    if (!e) {
      const r = m.get(id);
      io.err(r ? `run ${id} is ${r.status} — nothing to do` : `unknown run ${id}`);
      return 1;
    }
    await local(e);
    return printRun(await followEngine(e, io), io);
  });
}
export function retry(args, io) {
  const [id, item, step] = args._;
  return engineAction(args, io, id, () => api(io, 'POST', `/runs/${id}/cells/${item}/${step}/retry`), (e) => e.retry(nullable(item), step));
}
export function skip(args, io) {
  const [id, item, step] = args._;
  return engineAction(args, io, id, () => api(io, 'POST', `/runs/${id}/cells/${item}/${step}/skip`), (e) => e.skipCell(nullable(item), step));
}
export function abort(args, io) {
  const [id, item] = args._;
  if (item) return engineAction(args, io, id, () => api(io, 'POST', `/runs/${id}/items/${item}/abort`), (e) => e.abortItem(item));
  return engineAction(args, io, id, () => api(io, 'POST', `/runs/${id}/abort`), (e) => e.abort('aborted by user'));
}
export function answer(args, io) {
  const [id, item, step, ...rest] = args._; const a = rest.join(' ');
  return engineAction(args, io, id, () => api(io, 'POST', `/runs/${id}/answer`, { item, step: nullable(step), answer: a }), (e) => e.answer(nullable(item), nullable(step), { answer: a }));
}
export async function clean(args, io) {
  return withInstanceLock(io, async () => {
    const m = await manager(io); io.out(`removed ${m.clean(args.days ? Number(args.days) : undefined)} runs`); return 0;
  });
}
export async function serve(args, io) {
  const { startServer } = await import('../server.js');
  const lock = instanceLock(io.home);
  const m = await manager(io);
  const s = await startServer({ home: io.home, config: io.config, manager: m, port: args.port ? Number(args.port) : undefined });
  io.out(`runboard listening on ${s.url}/#t=${s.token}`);
  const stop = () => {
    s.server.close(() => { lock.release(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return new Promise(() => {});
}
