import fs from 'node:fs';
import path from 'node:path';

export default async function summary(ctx) {
  const rows = ctx.run.items.map((it) => `| ${it.name} | ${it.status} | ${it.steps.flaky?.build || '-'} |`);
  const md = ['# Hello summary', '', '| item | status | build |', '|---|---|---|', ...rows, ''].join('\n');
  const file = path.join(ctx.out, 'summary.md');
  fs.writeFileSync(file, md);
  ctx.log(md);
  return { path: file, count: ctx.run.items.length };
}
