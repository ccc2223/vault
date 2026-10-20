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

test('Worker limits wrong passwords per IP and overall when the LIMITS KV binding is present', async () => {
  const w = await worker();
  const kv = new Map(), LIMITS = { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } };
  const config = { ...env, LIMITS };
  const attempt = (password, ip = '203.0.113.7') => w.fetch(req('/login', 'POST', {
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ password })
  }), config);
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => originalTimeout(fn, 0);
  try {
    for (let i = 0; i < 10; i++) assert.equal((await attempt('wrong')).status, 401);
    const blocked = await attempt(env.PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '900');
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
    assert.equal((await attempt(env.PASSWORD, '198.51.100.2')).status, 200, 'other IPs still sign in');
    for (let i = 0; i < 90; i++) await attempt('wrong', '198.51.100.' + (10 + i % 9));
    assert.equal((await attempt(env.PASSWORD, '192.0.2.1')).status, 429, 'overall cap reached');
    // A failing KV store never blocks sign-in.
    const broken = { get: async () => { throw new Error('KV down'); }, put: async () => { throw new Error('KV down'); } };
    const ok = await w.fetch(req('/login', 'POST', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.PASSWORD }) }), { ...env, LIMITS: broken });
    assert.equal(ok.status, 200);
  } finally { globalThis.setTimeout = originalTimeout; }
});

test('Changing SESSION_SECRET signs every device out; leaving it unset keeps existing sessions', async () => {
  const w = await worker();
  const check = (session, config) => w.fetch(req('/gh/git/trees/main', 'GET', { headers: { Authorization: 'Bearer ' + session } }), config)
    .then(r => r.status);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  try {
    const plain = (await login()).data.session;
    assert.equal(await check(plain, env), 200);
    assert.equal(await check(plain, { ...env, SESSION_SECRET: 'one' }), 401);
    const withSecret = (await login({ ...env, SESSION_SECRET: 'one' })).data.session;
    assert.equal(await check(withSecret, { ...env, SESSION_SECRET: 'one' }), 200);
    assert.equal(await check(withSecret, { ...env, SESSION_SECRET: 'two' }), 401);
  } finally { globalThis.fetch = originalFetch; }
});
