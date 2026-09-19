import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { loadConfig, loadEnvFile, DEFAULTS } from '../config.js';
import { readTemplate, loadTemplates } from '../template/load.js';
import { validateTemplate, bodyKind } from '../template/validate.js';
import { Manager, NeedsTrust } from '../engine/manager.js';
import { defaultRunners } from '../runners/index.js';
import { render } from '../expr.js';
import { buildCtx } from '../engine/context.js';
import * as store from '../engine/store.js';
import { isAlive } from '../engine/proc.js';
import { table } from './table.js';

export const PKG_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
export const templateDirs = (home) => [path.join(PKG_ROOT, 'templates'), path.join(home, 'templates')];

async function manager(io) {
  const m = new Manager({ home: io.home, config: io.config, runners: await defaultRunners(), envValues: loadEnvFile(io.config.env_file), templateDirs: templateDirs(io.home) });
  await m.init();
  return m;
}
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

function previewRun(m, t, args) {
  const items = m.resolveItems(t.tpl, args.items ? args.items.split(',') : (t.tpl.items?.default || []));
  const fakeRun = { id: 'dry', dir: path.join(m.home, 'runs', 'dry'), templateDir: t.dir, params: args.params, items: items.map((i) => ({ status: 'active', ...i })), cells: {}, once: {}, steps: t.tpl.steps };
  return { items, fakeRun };
}
const bodyText = (s, ctx, shellSafe = true) => {
  const k = bodyKind(s);
  if (k === 'shell') return render(s.shell, ctx, { shell: shellSafe && !s.raw });
  if (k === 'js') return `js: ${s.js}`;
  if (k === 'agent') return `agent: ${render(s.agent.prompt, ctx).split('\n')[0]}`;
  return `human: ${render(s.human.question, ctx)}`;
};

export async function renderCmd(args, io) {
  const m = await manager(io);
  const t = m.templates.get(args._[0]); if (!t) { io.err(`template not found: ${args._[0]}`); return 1; }
  const step = t.tpl.steps.find((s) => s.name === args.step); if (!step) { io.err(`step not found: ${args.step}`); return 1; }
  const { items, fakeRun } = previewRun(m, t, args);
  const item = step.each ? items.find((i) => i.name === args.item) || items[0] : null;
  try { io.out(bodyText(step, buildCtx({ run: fakeRun, item, config: m.config, env: {} }))); return 0; }
  catch (e) { io.err(e.message); return 1; }
}

function printRun(run, io) {
  const rows = [];
  for (const s of run.steps) {
    if (s.once) { const c = run.once[s.name]; rows.push(['*', s.name, c.status, c.error || (c.waiting ? `? ${c.waiting.question}` : '')]); continue; }
    for (const it of run.items) { const c = run.cells[it.name]?.[s.name]; if (c) rows.push([it.name, s.name, c.status, c.error || (c.waiting ? `? ${c.waiting.question}` : '')]); }
  }
  io.out(`run ${run.id} [${run.templateName}] status=${run.status}${run.note ? ` note=${run.note}` : ''}${run.pilot ? ` pilot=${run.pilot.item}:${run.pilot.status}` : ''}`);
  io.out(table(rows, ['item', 'step', 'status', 'info']));
}
const exitFor = (run) => (run.status === 'done' ? 0 : 2);

async function ask(io, question, options) {
  if (io.answer !== undefined) return io.answer;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question(`${question} ${options.length ? `[${options.join('/')}] ` : ''}`, res));
  rl.close();
  return a.trim();
}

async function followEngine(e, io) {
  for (;;) {
    await e.idle();
    const run = e.run;
    if (run.pilot?.status === 'waiting') { e.answer('__pilot__', null, { answer: await ask(io, `Пилот ${run.pilot.item} прошёл. Продолжать на остальных?`, ['Да', 'Нет']) }); continue; }
    const waiting = [...e.allCells()].find(([, , c]) => c.status === 'waiting');
    if (waiting) { const [item, step, c] = waiting; e.answer(item, step.name, { answer: await ask(io, `${item ?? '*'}/${step.name}: ${c.waiting.question}`, c.waiting.options) }); continue; }
    return run;
  }
}

export async function run(args, io) {
  const name = args._[0];
  if (liveServer(io.home) && !args['dry-run']) {
    try {
      const { id } = await api(io, 'POST', '/runs', { template: name, params: args.params, items: args.items ? args.items.split(',') : [], mode: args.mode || 'all' });
      io.out(`started ${id} (server)`); return 0;
    } catch (e) {
      if (e.payload?.needsTrust) { if (!args.yes) { io.out(`template ${name} is not trusted. Commands:\n  ${e.payload.commands.join('\n  ')}\nre-run with --yes to trust`); return 3; } await api(io, 'POST', `/templates/${name}/trust`, { hash: e.payload.hash }); return run(args, io); }
      io.err(e.message); return 1;
    }
  }
  const m = await manager(io);
  const t = m.templates.get(name); if (!t) { io.err(`template not found: ${name}`); return 1; }
  if (args['dry-run']) {
    const { items, fakeRun } = previewRun(m, t, args); const rows = [];
    for (const s of t.tpl.steps) {
      const targets = s.once ? [null] : items;
      for (const it of targets) { try { rows.push([it ? it.name : '*', s.name, bodyText(s, buildCtx({ run: fakeRun, item: it, config: m.config, env: {} }))]); } catch (e) { rows.push([it ? it.name : '*', s.name, `ERROR ${e.message}`]); } }
    }
    io.out(table(rows, ['item', 'step', 'command'])); return rows.some((r) => r[2].startsWith('ERROR')) ? 1 : 0;
  }
  let created;
  try { created = await m.create({ templateName: name, params: args.params, items: args.items ? args.items.split(',') : [], mode: args.mode || 'all', initiator: { via: 'cli', user: os.userInfo().username } }); }
  catch (e) {
    if (e instanceof NeedsTrust) { if (!args.yes) { io.out(`template ${name} is not trusted. Commands:\n  ${e.commands.join('\n  ')}\nre-run with --yes to trust`); return 3; } m.trust(name, e.hash); return run(args, io); }
    io.err(e.message); return 1;
  }
  io.out(`started ${created.id}`);
  const final = await followEngine(m.engine(created.id), io);
  printRun(final, io);
  return exitFor(final);
}

export async function list(args, io) {
  const runs = liveServer(io.home) ? await api(io, 'GET', '/runs') : store.listRuns(io.home);
  io.out(table(runs.map((r) => [r.id, r.templateName, r.status, r.mode, r.items, r.createdAt]), ['id', 'template', 'status', 'mode', 'items', 'created']));
  return 0;
}
export async function show(args, io) {
  const r = liveServer(io.home) ? await api(io, 'GET', `/runs/${args._[0]}`) : store.loadRun(io.home, args._[0]);
  printRun(r, io); return exitFor(r);
}
export async function retry(args, io) {
  const [id, item, step] = args._;
  if (liveServer(io.home)) { await api(io, 'POST', `/runs/${id}/cells/${item}/${step}/retry`); io.out('retry requested (server)'); return 0; }
  const m = await manager(io); const e = m.engine(id); if (!e) { io.err('run is finished or unknown'); return 1; }
  e.retry(item === '_' ? null : item, step);
  const final = await followEngine(e, io); printRun(final, io); return exitFor(final);
}
export async function answer(args, io) {
  const [id, item, step, ...rest] = args._; const a = rest.join(' ');
  if (liveServer(io.home)) { await api(io, 'POST', `/runs/${id}/answer`, { item, step: step === '-' ? null : step, answer: a }); io.out('answer sent (server)'); return 0; }
  const m = await manager(io); const e = m.engine(id); if (!e) { io.err('run is finished or unknown'); return 1; }
  e.answer(item === '_' ? null : item, step === '-' ? null : step, { answer: a });
  const final = await followEngine(e, io); printRun(final, io); return exitFor(final);
}
export async function clean(args, io) {
  const m = await manager(io); io.out(`removed ${m.clean(args.days ? Number(args.days) : undefined)} runs`); return 0;
}
export async function serve(args, io) {
  const { startServer } = await import('../server.js');
  const { instanceLock } = await import('../engine/locks.js');
  const lock = instanceLock(io.home);
  const m = await manager(io);
  const s = await startServer({ home: io.home, config: io.config, manager: m, port: args.port ? Number(args.port) : undefined });
  io.out(`runboard listening on ${s.url}/#t=${s.token}`);
  const stop = () => { s.server.close(); lock.release(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return new Promise(() => {});
}
