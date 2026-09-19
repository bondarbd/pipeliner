import { render } from '../expr.js';

export async function run(step, r) {
  const h = step.human;
  return { ok: false, waiting: { question: render(h.question, r.exprCtx), options: h.options || ['Да', 'Нет'], fields: h.fields || [] } };
}
