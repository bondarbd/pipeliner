import fs from 'node:fs';
import path from 'node:path';
import { safe } from '../../src/engine/store.js';

export default async function summary(ctx) {
  const rows = ctx.run.items.map((it) => {
    const f = path.join(ctx.run.dir, 'items', safe(it.name), 'context', 'steps', 'flaky.json');
    const build = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).build : '-';
    return `| ${it.name} | ${it.status} | ${build} |`;
  });
  const md = ['# Hello summary', '', '| item | status | build |', '|---|---|---|', ...rows, ''].join('\n');
  const file = path.join(ctx.out, 'summary.md');
  fs.writeFileSync(file, md);
  ctx.log(md);
  return { path: file, count: ctx.run.items.length };
}
