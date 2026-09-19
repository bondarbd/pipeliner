import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, render, references, UnsafeSubstitution, ExprError } from '../src/expr.js';

const ctx = { run: { params: { release: '247' }, items: [{ name: 'a' }, { name: 'b' }] }, item: { name: 'a', steps: { branch: { commit: 'abc' } } } };

test('whole-scalar expression keeps type', () => {
  assert.equal(render('${{ run.items.length }}', ctx), 2);
  assert.deepEqual(render('${{ run.items.map(i => i.name) }}', ctx), ['a', 'b']);
  assert.equal(render('${{ 1 > 2 }}', ctx), false);
});

test('embedded expressions stringify', () => {
  assert.equal(render('release/0.${{ run.params.release }} by ${{ item.name }}', ctx), 'release/0.247 by a');
  assert.equal(render('x${{ item.missing }}y', ctx), 'xy');
});

test('deep render of objects and arrays', () => {
  assert.deepEqual(render({ a: ['${{ item.name }}', 1], b: { c: '${{ item.steps.branch.commit }}' } }, ctx), { a: ['a', 1], b: { c: 'abc' } });
});

test('shell mode rejects metacharacters', () => {
  const bad = { item: { name: 'x; rm -rf /' } };
  assert.throws(() => render('echo ${{ item.name }}', bad, { shell: true }), UnsafeSubstitution);
  assert.equal(render('echo ${{ item.name }}', { item: { name: 'ok_1.2/3@x:y=z+w,v' } }, { shell: true }), 'echo ok_1.2/3@x:y=z+w,v');
  assert.equal(render('echo ${{ item.name }}', { item: { name: 'Привет мир' } }, { shell: true }), 'echo Привет мир');
});

test('sandbox: no require/process, timeout, error message names the expression', () => {
  assert.throws(() => evaluate('require("fs")', ctx), ExprError);
  assert.throws(() => evaluate('process.exit()', ctx), ExprError);
  assert.throws(() => evaluate('while(true){}', ctx), ExprError);
  assert.throws(() => render('${{ nope.x }}', ctx), /nope is not defined in \$\{\{ nope.x \}\}/);
});

test('references finds step refs in nested values', () => {
  const refs = references({ shell: 'x ${{ item.steps.branch.commit }}', agent: { prompt: '${{ run.steps.report.path }}' } });
  assert.deepEqual(refs, [{ root: 'item', step: 'branch' }, { root: 'run', step: 'report' }]);
});
