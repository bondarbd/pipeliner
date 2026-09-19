import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasker, secretValues } from '../src/secrets.js';

test('only secret-looking env names are masked', () => {
  const env = { JENKINS_TOKEN: 'tok-123456', CONFLUENCE_PASSWORD: 'pw-123456', DEVELOP_BRANCH: 'develop', JENKINS_URL: 'https://jenkins.corp', API_KEY: 'key-123456' };
  assert.deepEqual(secretValues(env).sort(), ['key-123456', 'pw-123456', 'tok-123456']);
  const m = createMasker(secretValues(env));
  assert.equal(m.mask('checkout develop at https://jenkins.corp with tok-123456'), 'checkout develop at https://jenkins.corp with ***');
});

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

test('masks Authorization value with embedded spaces to end of line', () => {
  const m = createMasker([]);
  assert.equal(m.mask('Authorization: Bearer a b c\nnext'), 'Authorization: Bearer ***\nnext');
});
