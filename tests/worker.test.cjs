const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const env = { GH_TOKEN: 'test-only-not-a-real-token', PASSWORD: 'test-only-password', REPO: 'example/private', ALLOWED_ORIGIN: 'https://example.github.io' };
const origin = { Origin: env.ALLOWED_ORIGIN };
// Persistent storage per object ID, with serialized transactions and a fresh class instance per request.
function limiterNamespace() {
  const objects = new Map();
  return {
    idFromName: name => name,
    get(id) {
      if (!objects.has(id)) {
        const records = new Map(); let queue = Promise.resolve();
        objects.set(id, { transaction(fn) {
          const task = queue.then(() => fn({
            get: async key => structuredClone(records.get(key)),
            put: async (key, value) => records.set(key, structuredClone(value))
          }));
          queue = task.catch(() => {}); return task;
        } });
      }
      return { async fetch() {
        const { LoginLimiter } = await import('../worker.js');
        return new LoginLimiter({ storage: objects.get(id) }).fetch();
      } };
    }
  };
}
beforeEach(() => { env.LOGIN_LIMITER = limiterNamespace(); });
async function worker() { return (await import('../worker.js')).default; }
function req(path, method = 'GET', extra = {}) {
  return new Request('https://worker.example' + path, { method, ...extra, headers: { ...origin, 'CF-Connecting-IP': '203.0.113.7', ...extra.headers } });
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

test('Worker atomically admits only ten concurrent attempts from one IP', async () => {
  const w = await worker();
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => originalTimeout(fn, 0);
  try {
    const attempts = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      w.fetch(req('/login', 'POST', { headers: { 'X-Forwarded-For': '192.0.2.' + i }, body: JSON.stringify({ password: 'wrong' }) }), env)));
    assert.equal(attempts.filter(r => r.status === 401).length, 10);
    assert.equal(attempts.filter(r => r.status === 429).length, 40);
    const blocked = await w.fetch(req('/login', 'POST', { body: '{invalid-json' }), env);
    assert.equal(blocked.status, 429, 'admission happens before body parsing');
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
    assert.equal(blocked.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.setTimeout = originalTimeout; }
});

test('failures from many IPs never exhaust another IP budget', async () => {
  const w = await worker(), originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = fn => originalTimeout(fn, 0);
  try {
    for (let ip = 1; ip <= 10; ip++) for (let i = 0; i < 10; i++) {
      const r = await w.fetch(req('/login', 'POST', { headers: { 'CF-Connecting-IP': '198.51.100.' + ip }, body: JSON.stringify({ password: 'wrong' }) }), env);
      assert.equal(r.status, 401);
    }
    assert.equal((await login()).response.status, 200, 'correct password from a fresh IP still works after 100 failures');
  } finally { globalThis.setTimeout = originalTimeout; }
});

test('successful and malformed attempts consume reservations; retry time and expiry are accurate', async () => {
  const w = await worker(), originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    assert.equal((await w.fetch(req('/login', 'POST', { body: '{invalid-json' }), env)).status, 400);
    for (let i = 0; i < 9; i++) assert.equal((await login()).response.status, 200);
    now += 4500;
    let r = (await login()).response;
    assert.equal(r.status, 429); assert.equal(r.headers.get('Retry-After'), '896');
    now += 15 * 60000 - 4500;
    assert.equal((await login()).response.status, 200);
  } finally { Date.now = originalNow; }
});

test('missing, broken or malformed protection fails closed, without breaking existing sessions', async () => {
  const w = await worker();
  const { data } = await login();
  const stub = fetch => ({ idFromName: name => name, get: () => ({ fetch }) });
  for (const binding of [undefined,
    stub(async () => { throw new Error('Unavailable'); }),
    stub(async () => new Response('Unavailable', { status: 503 })),
    stub(async () => Response.json({})),
    stub(async () => Response.json({ allowed: false, retryAfter: 0 }))]) {
    const r = (await login({ ...env, LOGIN_LIMITER: binding })).response;
    assert.equal(r.status, 503); assert.equal(r.headers.get('Retry-After'), '60');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
  const noIP = req('/login', 'POST', { body: JSON.stringify({ password: env.PASSWORD }) });
  noIP.headers.delete('CF-Connecting-IP');
  assert.equal((await w.fetch(noIP, env)).status, 503);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ tree: [] });
  try {
    assert.equal((await w.fetch(req('/gh/git/trees/main', 'GET', { headers: { Authorization: 'Bearer ' + data.session } }), { ...env, LOGIN_LIMITER: undefined })).status, 200);
  } finally { globalThis.fetch = originalFetch; }
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

