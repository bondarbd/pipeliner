import { paths } from './store.js';

const outputs = (cells) => Object.fromEntries(Object.entries(cells || {}).map(([k, c]) => [k, c.output || {}]));

export function buildCtx({ run, item, config = {}, env = {}, output }) {
  const ctx = {
    run: {
      id: run.id, dir: run.dir, params: run.params, env, items: run.items,
      steps: outputs(run.once), skills: config.skills_root, templateDir: run.templateDir,
      ctxDir: paths(run, null).ctxDir,
    },
  };
  if (item) ctx.item = { ...item, steps: outputs(run.cells[item.name]), ctx: paths(run, item.name).ctxDir };
  if (output !== undefined) ctx.output = output;
  return ctx;
}
