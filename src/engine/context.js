import { paths } from './store.js';

const outputs = (cells) => Object.fromEntries(Object.entries(cells || {}).map(([k, c]) => [k, c.output || {}]));
const withSteps = (run, it) => ({ ...it, steps: outputs(run.cells[it.name]) });

// Namespaces visible to ${{ }} expressions and js steps. Every item carries the outputs of
// its each-steps under `steps`, so once-steps (reports) never have to read files.
export function buildCtx({ run, item, config = {}, env = {}, output }) {
  const ctx = {
    run: {
      id: run.id, dir: run.dir, params: run.params, env, items: run.items.map((it) => withSteps(run, it)),
      steps: outputs(run.once), skills: config.skills_root, templateDir: run.templateDir,
      ctxDir: paths(run, null).ctxDir,
    },
  };
  if (item) ctx.item = { ...withSteps(run, item), ctx: paths(run, item.name).ctxDir };
  if (output !== undefined) ctx.output = output;
  return ctx;
}
