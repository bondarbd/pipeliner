import fs from 'node:fs';
import path from 'node:path';

export default async function releaseReport(ctx) {
  const rel = ctx.run.params.release;
  const rows = ctx.run.items.map((it) => {
    const { branch = {}, build = {} } = it.steps;
    return { project: it.name, status: it.status, branch: `release/0.${rel}`, commit: build.commit || branch.commit || '-', build_url: build.build_url || '-', number: build.number || '-', result: build.result || (it.status === 'active' ? 'not built' : it.status), dist: build.dist || '-' };
  });
  const md = [`# Release 0.${rel}`, '', `Generated: ${new Date().toISOString()}`, '',
    '| Project | Branch | Build | Commit | Distribution | Result |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.project} | \`${r.branch}\` | ${r.build_url !== '-' ? `[#${r.number}](${r.build_url})` : '-'} | \`${r.commit}\` | ${r.dist !== '-' ? `[${r.dist.split('/').pop()}](${r.dist})` : '-'} | ${r.result} |`), ''].join('\n');
  const file = path.join(ctx.out, 'report.md');
  fs.writeFileSync(file, md);
  ctx.log(md);
  return { path: file, rows, failed: rows.filter((r) => r.result !== 'SUCCESS').map((r) => r.project) };
}
