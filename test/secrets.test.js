import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasker } from '../src/secrets.js';

test('masks exact, base64 and urlencoded forms', () => {
  const m = createMasker(['s3cr3t-token', 'ab', '']);
  assert.equal(m.mask('x s3cr3t-token y'), 'x *** y');
  assert.equal(m.mask('h ' + Buffer.from('s3cr3t-token').toString('base64')), 'h ***');
  assert.equal(m.mask('u=' + encodeURIComponent('s3cr3t-token')), 'u=***');
  assert.equal(m.mask('ab is short'), 'ab is short');
});

test('masks generic patterns even for unknown secrets', () => {
  const m = createMasker([]);
  assert.equal(m.mask('Authorization: Basic QWxhZGRpbg=='), 'Authorization: Basic ***');
  assert.equal(m.mask('Authorization: xyz'), 'Authorization: ***');
  assert.equal(m.mask('?token=abc&x=1 password=zzz'), '?token=***&x=1 password=***');
  assert.equal(m.mask('https://bob:pa55@jenkins/x'), 'https://bob:***@jenkins/x');
});
