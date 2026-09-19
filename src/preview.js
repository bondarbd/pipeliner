import path from 'node:path';
import { bodyKind } from './template/validate.js';
import { render } from './expr.js';
import { buildCtx } from './engine/context.js';

// Engine-free rendering of every item × step for `runboard run --dry-run`, `runboard render`
// and POST /api/templates/:name/preview. Never touches run.json. Outputs of steps that have
// not run yet are shown as placeholders: item.steps.branch.commit -> @branch.commit
const placeholder = (step) => new Proxy({}, { get: (_, k) => (typeof k === 'string' ? `@${step}.${k}` : undefined) });

export function previewRows(manager, t, { params = {}, items = [] } = {}, masker) {
  const steps = t.tpl.steps;
  const cells = (filter) => Object.fromEntries(steps.filter(filter).map((s) => [s.name, { output: placeholder(s.name) }]));
  params = manager.withDefaults(t.tpl, params);
  const perr = manager.checkParams(t.tpl, params);   // a dry run must fail the same way a real one would
  if (perr.length) throw new Error(`invalid params: ${perr.map((e) => `${e.path} ${e.message}`).join(', ')}`);
  const resolved = manager.resolveItems(t.tpl, items).map((i) => ({ status: 'active', ...i }));
  const run = { id: 'dry', dir: path.join(manager.home, 'runs', 'dry'), templateDir: t.dir, params, steps,
    items: resolved, cells: Object.fromEntries(resolved.map((i) => [i.name, cells((s) => s.each)])), once: cells((s) => s.once) };
  const rows = [];
  for (const s of steps) {
    for (const it of s.once ? [null] : run.items) {
      let command;
      try { command = String(bodyText(s, buildCtx({ run, item: it, config: manager.config }))); }
      catch (e) { command = `ERROR ${e.message}`; }
      rows.push({ item: it ? it.name : '*', step: s.name, command: masker ? masker.mask(command) : command });
    }
  }
  return rows;
}

function bodyText(s, ctx) {
  const k = bodyKind(s);
  if (k === 'shell') return render(s.shell, ctx, { shell: !s.raw });
  if (k === 'js') return `js: ${s.js}`;
  if (k === 'agent') return `agent: ${render(s.agent.prompt, ctx).split('\n')[0]}`;
  return `human: ${render(s.human.question, ctx)}`;
}
