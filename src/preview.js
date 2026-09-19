import path from 'node:path';
import { bodyKind } from './template/validate.js';
import { render } from './expr.js';
import { buildCtx } from './engine/context.js';

// Shared, engine-free preview logic used by both `runboard run --dry-run` /
// `runboard render` and the HTTP API's POST /api/templates/:name/preview.
// Never touches run.json or attaches an engine.

export function bodyText(s, ctx, shellSafe = true) {
  const k = bodyKind(s);
  if (k === 'shell') return render(s.shell, ctx, { shell: shellSafe && !s.raw });
  if (k === 'js') return `js: ${s.js}`;
  if (k === 'agent') return `agent: ${render(s.agent.prompt, ctx).split('\n')[0]}`;
  return `human: ${render(s.human.question, ctx)}`;
}

export function previewItems(manager, t, { params = {}, items = [] } = {}) {
  const resolved = manager.resolveItems(t.tpl, items.length ? items : (t.tpl.items?.default || []));
  const fakeRun = {
    id: 'dry', dir: path.join(manager.home, 'runs', 'dry'), templateDir: t.dir, params,
    items: resolved.map((i) => ({ status: 'active', ...i })), cells: {}, once: {}, steps: t.tpl.steps,
  };
  return { items: resolved, fakeRun };
}

export function previewRows(manager, t, { params = {}, items = [] } = {}, masker) {
  const { items: resolvedItems, fakeRun } = previewItems(manager, t, { params, items });
  const mask = (s) => (masker ? masker.mask(s) : s);
  const rows = [];
  for (const s of t.tpl.steps) {
    const targets = s.once ? [null] : resolvedItems;
    for (const it of targets) {
      try {
        const text = bodyText(s, buildCtx({ run: fakeRun, item: it, config: manager.config, env: {} }));
        rows.push({ item: it ? it.name : '*', step: s.name, command: mask(text) });
      } catch (e) {
        rows.push({ item: it ? it.name : '*', step: s.name, command: `ERROR ${e.message}` });
      }
    }
  }
  return rows;
}
