const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const env = { GH_TOKEN: 'test-only-not-a-real-token', PASSWORD: 'test-only-password', REPO: 'example/private', ALLOWED_ORIGIN: 'https://example.github.io' };
const origin = { Origin: env.ALLOWED_ORIGIN };
async function worker() { return (await import('../worker.js')).default; }
function req(path, method = 'GET', extra = {}) {
  return new Request('https://worker.example' + path, { method, ...extra, headers: { ...origin, ...extra.headers } });
}
async function login(config = env) {
  const before = Date.now();
  const response = await (await worker()).fetch(req('/login', 'POST', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.PASSWORD }) }), config);
  return { before, response, data: await response.json() };
}

test('Worker issues eight-hour sessions and rejects no, expired, or tampered credentials', async () => {
  const w = await worker();
  const { before, response, data } = await login({ ...env, SESSION_DAYS: '90' });
  assert.equal(response.status, 200);
  assert.ok(data.exp >= before + 8 * 3600000 && data.exp <= Date.now() + 8 * 3600000);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  for (const session of ['', '1.signature', data.session + 'tampered']) {
    const result = await w.fetch(req('/gh/git/trees/main', 'GET', { headers: { Authorization: 'Bearer ' + session } }), env);
    assert.equal(result.status, 401);
  }
  assert.equal((await w.fetch(req('/gh/git/trees/main', 'GET', { headers: { Authorization: 'Bearer ' + data.session } }), { ...env, PASSWORD: 'changed' })).status, 401);
  assert.equal((await w.fetch(req('/gh/git/trees/main', 'GET', { headers: { Authorization: 'Bearer ' + data.session } }), { ...env, REPO: 'example/different' })).status, 401);
});

test('Worker rejects previous session signatures and enforces the configured ceiling', async () => {
  const w = await worker();
  const exp = Date.now() + 3600000;
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(env.GH_TOKEN + '\n' + env.PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp)))).toString('base64url');
  const response = await w.fetch(req('/gh/git/trees/main', 'GET', { headers: { Authorization: 'Bearer ' + exp + '.' + signature } }), env);
  assert.equal(response.status, 401);
  const session = await login({ ...env, SESSION_HOURS: '1000' });
  assert.ok(session.data.exp <= Date.now() + 8 * 3600000);
  const shorter = await login({ ...env, SESSION_HOURS: '1' });
  assert.ok(shorter.data.exp <= Date.now() + 3600000);
});

test('Worker checks origins, validates passwords, and restricts authenticated proxy routes', async () => {
  const w = await worker();
  assert.equal((await w.fetch(new Request('https://worker.example/gh/git/trees/main'), env)).status, 403);
  const wrong = await w.fetch(req('/login', 'POST', { body: JSON.stringify({ password: 'wrong' }) }), env);
  assert.equal(wrong.status, 401);
  const { data } = await login();
  const response = await w.fetch(req('/gh/actions/runs', 'GET', { headers: { Authorization: 'Bearer ' + data.session } }), env);
  assert.equal(response.status, 403);
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (input, options) => {
    forwarded = { input, options }; return new Response(JSON.stringify({ tree: [] }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await w.fetch(req('/gh/git/trees/main?recursive=1', 'GET', { headers: { Authorization: 'Bearer ' + data.session } }), env);
    assert.equal(response.status, 200);
    assert.equal(forwarded.input, 'https://api.github.com/repos/example/private/git/trees/main?recursive=1');
    assert.equal(forwarded.options.headers.Authorization, 'Bearer ' + env.GH_TOKEN);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  } finally { globalThis.fetch = originalFetch; }
});

test('Worker allows import routes, only fast-forward ref updates, and forwards rate-limit headers', async () => {
  const w = await worker();
  const { data } = await login();
  const auth = { Authorization: 'Bearer ' + data.session, 'Content-Type': 'application/json' };
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = async (input, options) => {
    forwarded.push({ input, options });
    return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json', 'Retry-After': '30', 'X-RateLimit-Remaining': '0', 'X-Other': 'hidden' } });
  };
  try {
    for (const [path, method, body] of [
      ['/gh/git/ref/heads/main', 'GET'], ['/gh/git/commits/abc', 'GET'],
      ['/gh/git/blobs', 'POST', '{"content":"","encoding":"base64"}'], ['/gh/git/trees', 'POST', '{"tree":[]}'],
      ['/gh/git/commits', 'POST', '{"tree":"t","parents":["p"]}'], ['/gh/git/refs/heads/main', 'PATCH', '{"sha":"abc"}'],
      ['/gh/git/refs/heads/main', 'PATCH', '{"sha":"abc","force":false}']
    ]) {
      const response = await w.fetch(req(path, method, { headers: auth, body }), env);
      assert.equal(response.status, 403, path);
      assert.equal(response.headers.get('Retry-After'), '30');
      assert.equal(response.headers.get('X-RateLimit-Remaining'), '0');
      assert.equal(response.headers.get('X-Other'), null);
      assert.match(response.headers.get('Access-Control-Expose-Headers'), /Retry-After/);
    }
    assert.equal(forwarded.length, 7);
    assert.equal(forwarded[2].options.body, '{"content":"","encoding":"base64"}');
    assert.equal(forwarded[5].input, 'https://api.github.com/repos/example/private/git/refs/heads/main');
    forwarded.length = 0;
    for (const [path, method, body] of [
      ['/gh/git/refs/heads/main', 'PATCH', '{"sha":"abc","force":true}'], ['/gh/git/refs/heads/main', 'PATCH', '{"force":"yes"}'],
      ['/gh/git/refs', 'POST', '{"ref":"refs/heads/x","sha":"abc"}'], ['/gh/git/refs/tags/v1', 'PATCH', '{"sha":"abc"}'],
      ['/gh/git/refs/heads/main', 'DELETE'], ['/gh/git/blobs/abc', 'PUT', '{}'], ['/gh/git/trees/main', 'POST', '{}'],
      ['/gh/git/tags', 'POST', '{}'], ['/gh/contents/a.md', 'POST', '{}'], ['/gh/git/ref/heads/../../x', 'GET']
    ]) {
      const response = await w.fetch(req(path, method, { headers: auth, body }), env);
      assert.ok([400, 403].includes(response.status), method + ' ' + path);
    }
    assert.equal(forwarded.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
