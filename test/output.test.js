import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOutput, OutputError } from '../src/output.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-out-'));

test('keys from stdout and $OUT/result, later wins', () => {
  const outDir = dir();
  fs.writeFileSync(path.join(outDir, 'result'), 'dist=http://x/y.zip\ncommit=fff\n');
  const o = parseOutput('keys', { tail: 'noise\ncommit=abc \nOK done\n', outDir });
  assert.deepEqual(o, { commit: 'fff', dist: 'http://x/y.zip' });
});

test('json prefers result.json, falls back to last JSON line', () => {
  const outDir = dir();
  assert.deepEqual(parseOutput('json', { tail: 'log\n{"a":1}\n{"a":2}\ntrailer', outDir }), { a: 2 });
  fs.writeFileSync(path.join(outDir, 'result.json'), '[{"name":"p1"}]');
  assert.deepEqual(parseOutput('json', { tail: '', outDir }), [{ name: 'p1' }]);
});

test('json without result throws OutputError; text returns trimmed tail', () => {
  const outDir = dir();
  assert.throws(() => parseOutput('json', { tail: 'nothing here', outDir }), OutputError);
  assert.deepEqual(parseOutput('text', { tail: ' hi \n', outDir }), { text: 'hi' });
});
