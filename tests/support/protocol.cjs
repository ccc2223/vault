// In-memory GitHub transport; requests still pass through the actual Worker and crypto.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const repositories = new Map();
const Cready = import('../../e2ee.js').then(() => import('../../cloud-sync.js')).then(() => import('../../worker.js'));
const sha = raw => createHash('sha1').update('blob ' + raw.length + '\0').update(raw).digest('hex');
const clone = value => structuredClone(value);
class Git {
  constructor(repo) { this.repo = repo; this.files = new Map(); this.calls = []; this.fail = null; this.afterWrite = null; repositories.set(repo, this); }
  async fetch(url, init = {}) {
    const u = new URL(url), path = decodeURIComponent(u.pathname.split('/contents/')[1] || '');
    this.calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body });
    if (this.fail) { const r = await this.fail(u, init); if (r) return r; }
    if (u.pathname.includes('/git/blobs/')) {
      const file = [...this.files.values()].find(f => f.sha === u.pathname.split('/').pop());
      return file ? Response.json({ content: file.raw.toString('base64') }) : new Response(null, { status: 404 });
    }
    if (!u.pathname.includes('/contents/')) throw new Error('Unexpected storage route: ' + url);
    const old = this.files.get(path);
    if (!init.method || init.method === 'GET') return old ? Response.json({ sha: old.sha, content: old.raw.length > 1024 * 1024 ? '' : old.raw.toString('base64') }) : new Response(null, { status: 404 });
    assert.equal(init.method, 'PUT');
    const body = JSON.parse(init.body);
    assert.equal(body.message, 'Sync encrypted vault'); assert.equal(body.branch, 'main');
    if (old ? body.sha !== old.sha : !!body.sha) return new Response(null, { status: 409 });
    const raw = Buffer.from(body.content, 'base64'), file = { raw, sha: sha(raw), value: JSON.parse(raw) };
    this.files.set(path, file);
    if (this.afterWrite) await this.afterWrite(path, file);
    return Response.json({ content: { sha: file.sha } });
  }
  set(path, value) { const raw = Buffer.from(JSON.stringify(value)); const f = { raw, value: clone(value), sha: sha(raw) }; this.files.set(path, f); return f; }
  head() { return this.files.get('e2ee/head.json'); }
}
// Each mock repository dispatches independently so browser fixture requests can overlap.
const transport = (url, init) => {
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)/.exec(String(url));
  if (!match || !repositories.has(match[1])) throw new Error('Unexpected network request: ' + url);
  return repositories.get(match[1]).fetch(url, init);
};
async function fixture({ initialized = true, password = 'test password with plenty of entropy' } = {}) {
  const { createWorker, LoginLimiter } = await Cready;
  const worker = createWorker(transport);
  const C = globalThis.VaultCrypto, repo = 'tests/' + C.id(), git = new Git(repo), limiters = new Map();
  const env = { GH_TOKEN: 'fake-token', REPO: repo, ALLOWED_ORIGIN: 'https://app.example', SESSION_SECRET: C.encode(C.bytes(32)), SETUP_TOKEN: C.encode(C.bytes(32)),
    LOGIN_LIMITER: { idFromName: name => name, get(name) {
      if (!limiters.has(name)) {
        const values = new Map(); let queue = Promise.resolve();
        const storage = { get: async k => clone(values.get(k)), put: async (k, v) => values.set(k, clone(v)) };
        storage.transaction = fn => { const task = queue.then(() => fn(storage)); queue = task.catch(() => {}); return task; };
        limiters.set(name, new LoginLimiter({ storage }));
      }
      return limiters.get(name);
    } } };
  const f = { C, git, env, worker, limiters, password, token: null, setup: true };
  f.response = async (path, { json, headers = {}, public: pub = false, ...options } = {}) => worker.fetch(new Request('https://sync.example' + path, {
    method: options.method || (json !== undefined ? 'POST' : 'GET'), ...options,
    headers: { Origin: env.ALLOWED_ORIGIN, 'CF-Connecting-IP': '192.0.2.1', ...(!pub ? { Authorization: f.token ? 'Bearer ' + f.token : 'Setup ' + env.SETUP_TOKEN } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {})
  }), env);
  f.request = async (path, options) => {
    const r = await f.response(path, options), data = await r.json();
    if (!r.ok) { const error = new Error(data.message); error.status = r.status; throw error; } return data;
  };
  f.login = async (bundle = f.generated.bundle, ip = '192.0.2.1') => {
    const r = await f.request('/login', { public: true, json: { accessSecret: bundle.accessSecret }, headers: { 'CF-Connecting-IP': ip } }); f.token = r.session; return r;
  };
  f.client = (bundle = f.generated.bundle, checkpoint = null) => new globalThis.CloudVault(f.request, bundle, checkpoint);
  f.generated = await C.create(password);
  if (initialized) {
    f.cloud = f.client(); f.checkpoint = await f.cloud.publish({ head: f.generated.head, sha: null }, [], { setup: true });
    await f.login(); f.setup = false;
  }
  f.put = async (path, data, kind = 'note') => {
    const cloud = f.client(), base = await cloud.load(), old = base.manifest.entries.find(e => e.path === path);
    const ref = await cloud.upload(kind, data, old?.ref.objectId);
    const entry = { path, kind, deleted: false, mtime: Date.now(), ref };
    return cloud.publish(base, [...base.manifest.entries.filter(e => e.path !== path), entry]);
  };
  return f;
}
module.exports = { fixture, sha, clone };
