const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_KEY = /token|password|passwd|secret|credential|api_?key|private/i;

// values of env entries whose NAME looks like a secret — masking every env value would
// also hide plain words like DEVELOP_BRANCH=develop in every log line
export const secretValues = (env = {}) => Object.entries(env).filter(([k]) => SECRET_KEY.test(k)).map(([, v]) => v);

export function createMasker(values = []) {
  const forms = new Set();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < 6) continue;
    forms.add(v);
    forms.add(Buffer.from(v).toString('base64'));
    const enc = encodeURIComponent(v);
    if (enc !== v) forms.add(enc);
  }
  const exact = [...forms].sort((a, b) => b.length - a.length).map(escapeRe);
  const exactRe = exact.length ? new RegExp(exact.join('|'), 'g') : null;
  return {
    mask(s) {
      let out = String(s);
      if (exactRe) out = out.replace(exactRe, '***');
      out = out.replace(/(Authorization:\s*)((?:Basic|Bearer|Token)\s+)?[^\r\n]+/gi, (_, p, scheme) => `${p}${scheme || ''}***`);
      out = out.replace(/((?:token|password|passwd|secret)=)[^\s&"']+/gi, '$1***');
      out = out.replace(/\/\/([^\/\s:@]+):([^@\s\/]+)@/g, '//$1:***@');
      return out;
    },
  };
}
