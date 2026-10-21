const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const playwright = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fixture: protocol } = require('./protocol.cjs');
const password = 'test password with plenty of entropy', url = 'https://sync.example', secret = 'Private device-only draft 9a8b7c';
const browserName = process.env.VAULT_BROWSER || 'chromium';
const launch = () => playwright[browserName].launch(browserName === 'chromium' ? {
  executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : playwright.chromium.executablePath()), headless: true, args: ['--no-sandbox']
} : { headless: true });
function harness() {
  let server, browser, base;
  before(async () => {
    const root = path.resolve(__dirname, '../..');
    server = http.createServer((req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname;
      if (name === '/seed') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Seed</title>'); return; }
      const file = path.join(root, name === '/' ? 'index.html' : name);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      try {
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'text/plain');
        const body = fs.readFileSync(file);
        res.end(name === '/' || name === '/index.html' ? body.toString().replace('https://vault-sync-01.chriscleven.workers.dev;', url + ';') : body);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port; browser = await launch();
  });
  after(async () => { await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve)); });
  async function fixture({ legacy = true, serviceWorkers = 'block', initialized = true, ...options } = {}) {
    if (browserName === 'firefox') delete options.isMobile;
    const context = await browser.newContext({ serviceWorkers, ...options });
    const f = await protocol({ initialized }), state = { password, offline: false, calls: [], delay: null, started: false, aliases: new Map() };
    let syncingRemote = null;
    class Remote extends Map {
      dirty = new Set();
      set(k, v) { super.set(k, v); this.dirty.add(k); return this; }
      delete(k) { this.dirty.add(k); return super.delete(k); }
    }
    const remote = new Remote();
    if (legacy) remote.set('Secret draft.md', { content: secret });
    async function syncRemote() {
      if (!remote.dirty.size || !initialized) return;
      if (syncingRemote) return syncingRemote;
      syncingRemote = (async () => {
        const cloud = f.client(), base = await cloud.load(), entries = new Map(base.manifest.entries.map(e => [e.path, e]));
        for (const p of [...remote.dirty]) {
          const value = remote.get(p), old = entries.get(p);
          if (!value) { if (old) entries.set(p, { ...old, deleted: true, mtime: Date.now() }); continue; }
          const kind = value.b64 !== undefined ? 'file' : 'note', data = kind === 'note' ? value.content : Buffer.from(value.b64, 'base64');
          const ref = await cloud.upload(kind, data, old?.ref.objectId);
          if (value.sha) state.aliases.set(ref.revisionId, value.sha);
          entries.set(p, { path: p, kind, deleted: false, mtime: Date.now(), ref });
        }
        await cloud.publish(base, [...entries.values()]); remote.dirty.clear();
      })();
      try { await syncingRemote; } finally { syncingRemote = null; }
    }
    async function readRemote() {
      const h = f.git.head().value;
      if (h.authDigest !== await f.C.digest(f.C.decode(f.generated.bundle.accessSecret))) {
        f.generated = { ...f.generated, bundle: await f.C.unlock(h, state.password), head: h };
        await f.login(f.generated.bundle, '198.51.100.2');
      }
      const read = async ref => f.C.decrypt(f.generated.bundle, f.git.files.get('e2ee/objects/' + ref.objectId + '/' + ref.revisionId + '.enc').value, ref);
      const manifest = f.C.parse(await read(h.manifest));
      Map.prototype.clear.call(remote);
      for (const e of manifest.entries) if (!e.deleted) {
        const data = await read(e.ref);
        Map.prototype.set.call(remote, e.path, e.kind === 'note' ? { sha: e.ref.revisionId, content: new TextDecoder().decode(data) } : { sha: e.ref.revisionId, b64: Buffer.from(data).toString('base64') });
      }
      remote.dirty.clear();
    }
    const routeHandler = async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      if (state.offline) { await route.abort(); return; }
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Content-Type': 'application/json' };
      if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
      state.calls.push({ pathname, method: req.method(), body: req.postData(), authorization: req.headers().authorization });
      if (pathname === '/vault/head' && state.delay) { state.started = true; await state.delay; }
      if (['/vault/head', '/vault/bootstrap'].includes(pathname)) await syncRemote();
      if (state.failBlob && state.aliases.get(pathname.split('/').pop()) === state.failBlob) {
        await route.fulfill({ status: 502, headers, body: JSON.stringify({ message: 'Encrypted storage is unavailable.' }) }).catch(() => {}); return;
      }
      if (state.failCommit && pathname === '/vault/commit') {
        await route.fulfill({ status: 503, headers, body: JSON.stringify({ message: 'Unavailable' }) }).catch(() => {}); return;
      }
      const response = await f.response(pathname, { method: req.method(), ...(req.postData() !== null ? { body: req.postData() } : {}), public: true,
        headers: { ...req.headers(), Origin: f.env.ALLOWED_ORIGIN, 'CF-Connecting-IP': '203.0.113.1' } });
      if (response.ok && ['/vault/commit', '/vault/setup'].includes(pathname)) { await readRemote(); }
      await route.fulfill({ status: response.status, headers, body: await response.text() }).catch(() => {});
    };
    await context.route(url + '/**', routeHandler);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    await page.goto(base); await page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    return { context, page, state, remote, errors, protocol: f, syncRemote, base, async device() {
      const other = await browser.newContext({ serviceWorkers: 'block' });
      await other.route(url + '/**', routeHandler); const next = await other.newPage();
      await next.goto(base); await next.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
      return { context: other, page: next };
    } };
  }
  return { fixture, get base() { return base; }, get browser() { return browser; } };
}
async function unlock(page, value = password) {
  await page.locator('#unlock-url').fill(url); await page.locator('#unlock-password').fill(value);
  await page.locator('#unlock-submit').click();
  await page.waitForFunction(() => Auth.active || !!document.getElementById('unlock-error').textContent);
}
const editorText = page => page.evaluate(() => editor.text);
async function settled(page) {
  await page.waitForFunction(() => {
    if (!Auth.active && !Auth.preparing && document.getElementById('unlock-error').textContent) throw new Error(document.getElementById('unlock-error').textContent);
    return Auth.active && !Auth.preparing && Auth.store.pending === 0 && syncing === null && saveT === null;
  });
}
const raw = page => page.evaluate(async () => ({ sealed: Auth.store.db ? await Auth.store.read() : undefined, settings: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])) }));
async function locked(page) {
  await page.waitForFunction(() => !Auth.active && !Auth.locking && !Auth.lockFailed);
  assert.equal(await editorText(page), ''); assert.equal(await page.locator('#list').textContent(), '');
  assert.equal(await page.evaluate(() => Auth.store.key === null && Auth.session === null && notes.size === 0), true);
}
async function rotate(f, next = 'new longer password for test') {
  f.state.password = next;
  await f.page.evaluate(({ old, next }) => { window.rotation = Auth.changePassword(old, next).then(() => null, e => e.message); }, { old: password, next });
  await f.page.locator('#dlg-recovery-key[open]').waitFor();
  const key = await f.page.locator('#recovery-key').inputValue();
  await f.page.locator('#recovery-confirm').fill(key); await f.page.locator('#recovery-confirm-save').click();
  const error = await f.page.evaluate(() => window.rotation);
  return { key, error };
}
module.exports = { harness, launch, browserName, password, secret, url, unlock, settled, locked, raw, editorText, rotate };
