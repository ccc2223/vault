const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./support/protocol.cjs');

test('setup requires a single-use capability, valid manifest and atomic head creation', async () => {
  const f = await fixture({ initialized: false });
  assert.deepEqual(await f.request('/vault/bootstrap', { public: true }), { head: null, sha: null });
  assert.equal((await f.response('/vault/setup', { public: true, json: {} })).status, 401);
  const cloud = f.client(), base = { head: f.generated.head, sha: null };
  const prepared = await cloud.prepare(base, []);
  const results = await Promise.allSettled([cloud.publishPrepared(base, prepared, { setup: true }), cloud.publishPrepared(base, prepared, { setup: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await f.response('/vault/setup', { json: { head: prepared.head, expectedHeadSha: null } })).status, 409);
  assert.equal((await f.response('/vault/objects/' + prepared.head.manifest.objectId + '/' + prepared.head.manifest.revisionId)).status, 409);
});
test('only a random cloud secret logs in; no plaintext repository proxy survives', async () => {
  const f = await fixture();
  assert.equal((await f.response('/login', { public: true, json: { password: f.password } })).status, 401);
  assert.equal((await f.response('/login', { public: true, json: { accessSecret: f.C.encode(f.C.bytes(32)) } })).status, 401);
  const r = await f.login(); assert.ok(r.exp <= Date.now() + 8 * 3600000);
  assert.equal((await f.response('/vault/head', { public: true })).status, 401);
  assert.equal((await f.response('/gh/contents/Private.md')).status, 404);
  assert.equal((await f.response('/vault/head?token=x')).status, 400);
  assert.equal((await f.response('/vault/head', { headers: { Authorization: 'Bearer ' + f.token.slice(0, -2) + 'aa' } })).status, 401);
  f.env.SESSION_SECRET = f.C.encode(f.C.bytes(32));
  assert.equal((await f.response('/vault/head')).status, 401);
});
test('origins and configuration fail closed; CORS includes conditional-write methods', async () => {
  const f = await fixture();
  for (const Origin of ['', 'https://evil.example', 'https://app.example.evil']) assert.equal((await f.response('/vault/head', { headers: { Origin } })).status, 403);
  const preflight = await f.response('/vault/commit', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /PUT/);
  delete f.env.SESSION_SECRET; assert.equal((await f.response('/vault/head')).status, 503);
});
test('storage redirects fail closed without following credentials to another endpoint', async () => {
  const f = await fixture({ initialized: false });
  f.git.fail = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/storage' } });
  };
  const response = await f.response('/vault/bootstrap', { public: true });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { message: 'Encrypted storage is unavailable.' });
  assert.equal(f.git.calls.length, 1);
});
test('Durable Object transactions admit exactly ten concurrent requests per IP; bootstrap has its own budget', async () => {
  const f = await fixture();
  const attempt = ip => f.response('/login', { public: true, json: {}, headers: { 'CF-Connecting-IP': ip } });
  const results = await Promise.all(Array.from({ length: 50 }, () => attempt('192.0.2.99')));
  assert.equal(results.filter(r => r.status === 401).length, 10);
  assert.equal(results.filter(r => r.status === 429).length, 40);
  assert.ok(Number(results.find(r => r.status === 429).headers.get('Retry-After')) > 0);
  assert.equal((await attempt('192.0.2.100')).status, 401);
  assert.equal((await f.response('/vault/bootstrap', { public: true, headers: { 'CF-Connecting-IP': '192.0.2.99' } })).status, 200);
  assert.equal((await attempt('')).status, 503);
  f.env.LOGIN_LIMITER.get = () => ({ fetch: async () => { throw new Error('unavailable'); } });
  assert.equal((await attempt('192.0.2.101')).status, 503);
});
test('immutable object writes are idempotent; replacements and malformed oversized requests fail', async () => {
  const f = await fixture(), record = await f.C.encrypt(f.generated.bundle, 'note', 'secret');
  const path = '/vault/objects/' + record.objectId + '/' + record.revisionId;
  const one = await f.request(path, { method: 'PUT', json: record });
  assert.deepEqual(await f.request(path, { method: 'PUT', json: record }), one);
  assert.equal((await f.response(path, { method: 'PUT', json: { ...record, iv: f.C.encode(f.C.bytes(12)) } })).status, 409);
  assert.equal((await f.response(path, { method: 'PUT', json: { ...record, vaultId: f.C.id() } })).status, 400);
  assert.equal((await f.response('/login', { public: true, body: 'x'.repeat(513), method: 'POST' })).status, 413);
  assert.equal((await f.response('/vault/commit', { body: '{', method: 'POST' })).status, 400);
  assert.equal((await f.response('/vault/commit', { body: 'x'.repeat(16385), method: 'POST' })).status, 413);
});
test('head commit requires an uploaded authenticated manifest and compare-and-swap', async () => {
  const f = await fixture(), cloud = f.client(), base = await cloud.load();
  const prepared = await cloud.prepare(base, []);
  assert.equal((await f.response('/vault/commit', { json: { head: { ...prepared.head, manifest: { ...prepared.head.manifest, sha: '0'.repeat(40) } }, expectedHeadSha: base.sha } })).status, 400);
  assert.equal((await f.response('/vault/commit', { json: { head: { ...prepared.head, authDigest: f.C.encode(f.C.bytes(32)) }, expectedHeadSha: base.sha } })).status, 400);
  await cloud.publishPrepared(base, prepared);
  assert.equal((await f.response('/vault/commit', { json: { head: prepared.head, expectedHeadSha: base.sha } })).status, 409);
});
test('large ciphertext uses Git blob fallback without exposing plaintext', async () => {
  const f = await fixture(), bytes = new Uint8Array(1024 * 1024); bytes[0] = 123; bytes[bytes.length - 1] = 255;
  const ref = await f.cloud.upload('file', bytes);
  assert.deepEqual(await f.client().read(ref), bytes);
  assert.ok(f.git.calls.some(c => c.path.includes('/git/blobs/')));
});
