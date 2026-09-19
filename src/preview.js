import path from 'node:path';
import { bodyKind } from './template/validate.js';
import { render } from './expr.js';
import { buildCtx } from './engine/context.js';

// Engine-free rendering of every item × step for `runboard run --dry-run`, `runboard render`
// and POST /api/templates/:name/preview. Never touches run.json.
export function previewRows(manager, t, { params = {}, items = [] } = {}, masker) {
  const resolved = manager.resolveItems(t.tpl, items.length ? items : (t.tpl.items?.default || []));
  const run = { id: 'dry', dir: path.join(manager.home, 'runs', 'dry'), templateDir: t.dir, params, steps: t.tpl.steps,
    items: resolved.map((i) => ({ status: 'active', ...i })), cells: {}, once: {} };
  const rows = [];
  for (const s of t.tpl.steps) {
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
