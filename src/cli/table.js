export function table(rows, header) {
  const all = header ? [header, ...rows] : rows;
  const w = [];
  for (const r of all) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c ?? '').length); });
  return all.map((r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n');
}
export function parseArgs(argv) {
  const args = { _: [], param: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (k === 'param') args.param.push(v); else args[k] = v;
    } else args._.push(a);
  }
  args.params = Object.fromEntries(args.param.map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  return args;
}
