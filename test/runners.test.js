import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as shell from '../src/runners/shell.js';
import * as js from '../src/runners/js.js';
import * as human from '../src/runners/human.js';
import { fakeRunner } from '../src/runners/fake.js';
import { createMasker } from '../src/secrets.js';

function rctx(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-run-'));
  const outDir = path.join(dir, 'out'); fs.mkdirSync(outDir);
  return { run: { id: 'r1' }, item: { name: 'p1', dir }, config: { git: { allowed_push_branches: ['release/*'] } },
    exprCtx: { item: { name: 'p1', dir }, run: { params: { n: '7' } } }, env: { TOKEN: 'sekret' }, cwd: dir, outDir,
    logPath: path.join(dir, 'x.log'), timeout: 10, masker: createMasker(['sekret']), templateDir: dir, itemCtxDir: dir, runCtxDir: dir,
    onSpawn() {}, countAgentCall() {}, ...over };
}

test('shell: renders, passes whitelisted env + OUT, parses keys, masks', async () => {
  const r = rctx();
  const res = await shell.run({ name: 's', shell: 'echo n=${{ run.params.n }}; echo tok=$TOKEN; echo "extra=1" > $OUT/result; test -z "$HOME" && exit 9; exit 0' }, r);
  assert.equal(res.ok, true);
  assert.deepEqual(res.output, { n: '7', tok: '***', extra: '1' });
  assert.equal(res.command, 'echo n=7; echo tok=$TOKEN; echo "extra=1" > $OUT/result; test -z "$HOME" && exit 9; exit 0');
});

test('shell: non-zero exit, timeout, unsafe substitution, git guard', async () => {
  const r = rctx();
  assert.equal((await shell.run({ name: 's', shell: 'exit 4' }, r)).error, 'exit 4');
  assert.equal((await shell.run({ name: 's', shell: 'echo step one; echo pom.xml broken >&2; exit 5' }, r)).error, 'exit 5: pom.xml broken');
  const t = await shell.run({ name: 's', shell: 'sleep 5' }, { ...r, timeout: 1 });
  assert.equal(t.timedOut, true); assert.match(t.error, /timeout/);
  const u = await shell.run({ name: 's', shell: 'echo ${{ item.name }}' }, { ...r, exprCtx: { item: { name: 'a;b' } } });
  assert.match(u.error, /unsafe substitution/);
  assert.throws(() => shell.guardGit('git push --force origin release/0.1', ['release/*']), shell.GitGuardError);
  assert.throws(() => shell.guardGit('git push --force-with-lease=refs/heads/x:abc origin release/0.1', ['release/*']), shell.GitGuardError);
  assert.throws(() => shell.guardGit('git push --force-with-lease origin release/0.1', ['release/*']), shell.GitGuardError);
  assert.throws(() => shell.guardGit('git push origin develop', ['release/*']), shell.GitGuardError);
  shell.guardGit('git push -u origin release/0.247', ['release/*']);
  shell.guardGit('git push', ['release/*']);
  const g = await shell.run({ name: 's', shell: 'git push -f origin x' }, r);
  assert.match(g.error, /git guard/);
});

test('js: module gets ctx and returns output; errors are captured', async () => {
  const r = rctx();
  fs.writeFileSync(path.join(r.templateDir, 'ok.js'), 'export default async (ctx) => { ctx.log("hi"); return { n: ctx.run.params.n, item: ctx.item.name }; };');
  fs.writeFileSync(path.join(r.templateDir, 'boom.js'), 'export default async () => { throw new Error("boom"); };');
  const ok = await js.run({ name: 'j', js: './ok.js' }, r);
  assert.deepEqual(ok, { ok: true, output: { n: '7', item: 'p1' } });
  assert.match(fs.readFileSync(r.logPath, 'utf8'), /hi/);
  const bad = await js.run({ name: 'j', js: './boom.js' }, r);
  assert.equal(bad.ok, false); assert.equal(bad.error, 'boom');
});

test('human returns waiting with rendered question', async () => {
  const res = await human.run({ name: 'h', human: { question: 'Deploy ${{ item.name }}?', fields: ['reason'] } }, rctx());
  assert.deepEqual(res, { ok: false, waiting: { question: 'Deploy p1?', options: ['Да', 'Нет'], fields: ['reason'] } });
});

test('fake runner consumes plans', async () => {
  const f = fakeRunner({ 'p1:a': [{ ok: false, error: 'x' }, { ok: true, output: { v: 1 } }], '*:r': (step) => ({ ok: true, output: { s: step.name } }) });
  const r = rctx();
  assert.equal((await f.run({ name: 'a' }, r)).ok, false);
  assert.equal((await f.run({ name: 'a' }, r)).ok, true);
  assert.equal((await f.run({ name: 'a' }, r)).ok, true);
  assert.deepEqual((await f.run({ name: 'r' }, { ...r, item: null })).output, { s: 'r' });
  assert.deepEqual((await f.run({ name: 'zzz' }, r)), { ok: true, output: {} });
  assert.deepEqual(f.calls, ['p1:a', 'p1:a', 'p1:a', '*:r', 'p1:zzz']);
});
