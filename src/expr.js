import vm from 'node:vm';

const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;
const WHOLE_RE = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/;
export const SAFE_RE = /^[\p{L}\p{N}._\/@:=+, -]*$/u;

export class ExprError extends Error {}
export class UnsafeSubstitution extends Error {
  constructor(value) { super(`unsafe substitution: ${JSON.stringify(value)}`); this.value = value; }
}

export function evaluate(expr, ctx) {
  const sandbox = Object.create(null);
  for (const [k, v] of Object.entries(ctx || {})) sandbox[k] = v;
  try {
    return vm.runInNewContext(`(${expr})`, sandbox, { timeout: 100 });
  } catch (e) {
    throw new ExprError(`${e.message} in \${{ ${String(expr).trim()} }}`);
  }
}

function check(v) {
  const s = v == null ? '' : String(v);
  if (!SAFE_RE.test(s)) throw new UnsafeSubstitution(s);
}

function renderString(s, ctx, shell) {
  const whole = s.match(WHOLE_RE);
  if (whole) {
    const v = evaluate(whole[1], ctx);
    if (shell) check(v);
    return v;
  }
  return s.replace(EXPR_RE, (_, e) => {
    const v = evaluate(e, ctx);
    if (shell) check(v);
    return v == null ? '' : String(v);
  });
}

export function render(value, ctx, { shell = false } = {}) {
  if (typeof value === 'string') return renderString(value, ctx, shell);
  if (Array.isArray(value)) return value.map((v) => render(v, ctx, { shell }));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = render(v, ctx, { shell });
    return o;
  }
  return value;
}

export function references(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(EXPR_RE)) {
        for (const r of m[1].matchAll(/\b(item|run)\.steps\.([A-Za-z_][\w-]*)/g)) out.push({ root: r[1], step: r[2] });
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}
