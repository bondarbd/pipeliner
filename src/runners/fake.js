export function fakeRunner(plan = {}) {
  const calls = [];
  return {
    calls,
    async run(step, r) {
      const key = `${r.item ? r.item.name : '*'}:${step.name}`;
      calls.push(key);
      const q = plan[key];
      let res;
      if (Array.isArray(q)) res = q.length > 1 ? q.shift() : q[0];
      else res = q;
      if (typeof res === 'function') return res(step, r);
      return res ? structuredClone(res) : { ok: true, output: {} };
    },
  };
}
