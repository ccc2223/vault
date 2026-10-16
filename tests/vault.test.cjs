const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let server, browser, base;
const password = 'test password with plenty of entropy';
const url = 'https://sync.example';
const secret = 'Private device-only draft 9a8b7c';

before(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/seed') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Seed</title>'); return; }
    const file = path.join(__dirname, '..', name === '/' ? 'index.html' : name);
    if (!file.startsWith(path.join(__dirname, '..'))) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'text/plain');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function fixture({ legacy = true, serviceWorkers = 'block' } = {}) {
  const context = await browser.newContext({ serviceWorkers });
  const remote = new Map();
  const state = { password, offline: false, calls: [], delay: null, started: false };
  await context.route(url + '/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    if (state.offline) { await route.abort(); return; }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Content-Type': 'application/json' };
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    state.calls.push({ pathname, method: req.method() });
    let body = {}, status = 200;
    if (pathname === '/login') {
      if (req.postDataJSON().password !== state.password) { status = 401; body = { message: 'Wrong password' }; }
      else { const exp = Date.now() + 90 * 86400000; body = { session: exp + '.fake-session', exp }; }
    } else if (pathname.startsWith('/gh/git/trees/')) {
      if (state.delay) { state.started = true; await state.delay; }
      body = { tree: [...remote].map(([name, n]) => ({ path: name, sha: n.sha, type: 'blob' })) };
    } else if (pathname.startsWith('/gh/git/blobs/')) {
      const note = [...remote.values()].find(n => n.sha === pathname.split('/').pop());
      body = { content: Buffer.from(note?.content || '').toString('base64') };
    } else if (pathname.startsWith('/gh/contents/')) {
      const name = decodeURIComponent(pathname.slice('/gh/contents/'.length));
      if (req.method() === 'DELETE') remote.delete(name);
      else { const n = { sha: 'hash-' + Math.random(), content: Buffer.from(req.postDataJSON().content, 'base64').toString() }; remote.set(name, n); body = { content: { sha: n.sha } }; }
    } else { status = 404; }
    await route.fulfill({ status, headers, body: JSON.stringify(body) }).catch(() => {});
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  await page.goto(base + '/seed');
  if (legacy) await page.evaluate(async ({ password, secret, url }) => {
    await new Promise((resolve, reject) => {
      const r = indexedDB.open('vault', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('notes', { keyPath: 'path' });
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction('notes', 'readwrite');
        tx.objectStore('notes').put({ path: 'Secret draft.md', content: secret, dirty: true, sha: null, mtime: Date.now() });
        tx.oncomplete = () => { r.result.close(); resolve(); };
      };
    });
    localStorage.setItem('vault.gh', JSON.stringify({ url, session: 'old-secret-session', token: 'old-secret-token', branch: 'main' }));
    localStorage.setItem('vault.last', 'Secret draft.md');
  }, { password, secret, url });
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
  return { context, page, state, remote, errors };
}
async function unlock(page, value = password) {
  await page.locator('#unlock-url').fill(url);
  await page.locator('#unlock-password').fill(value);
  await page.locator('#unlock-submit').click();
  await page.waitForFunction(() => Auth.active || !!document.getElementById('unlock-error').textContent);
}
async function settled(page) {
  await page.waitForFunction(() => Auth.active && Auth.store.pending === 0 && syncing === null && saveT === null);
}
async function raw(page) {
  return page.evaluate(async () => ({
    sealed: await Auth.store.read(),
    legacy: await Auth.store.legacy(),
    settings: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))
  }));
}
async function locked(page) {
  await page.waitForFunction(() => !Auth.active && !Auth.locking && !Auth.lockFailed);
  assert.equal(await page.locator('#ta').inputValue(), '');
  assert.equal(await page.locator('#list').textContent(), '');
  assert.equal(await page.evaluate(() => Auth.store.key === null && Auth.session === null && notes.size === 0), true);
}

test('migration is authenticated, encrypted, preserves drafts, and reload starts locked', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.page.locator('#lock-screen').isVisible(), true);
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('vault.gh')), null);
    await unlock(f.page, 'wrong password');
    assert.equal((await raw(f.page)).legacy.length, 1);
    assert.equal((await raw(f.page)).sealed, undefined);
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    const stored = await raw(f.page);
    assert.equal(stored.legacy.length, 0);
    const text = JSON.stringify(stored);
    for (const value of [secret, 'Secret draft', password, 'fake-session', 'old-secret']) assert.equal(text.includes(value), false);
    assert.ok(stored.sealed.ciphertext);
    assert.ok(await f.page.evaluate(() => Auth.session.exp <= Date.now() + 8 * 3600000));
    await f.page.reload();
    await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    assert.equal(await f.page.locator('#lock-screen').isVisible(), true);
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('sign out clears UI, keys and credentials; offline unlock still needs the local password', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#cfg').click(); await f.page.locator('#c-clear').click(); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page, 'incorrect');
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    assert.equal(await f.page.evaluate(() => Auth.session), null);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('one-hour idle timeout and suspended-background check lock without erasing edits', async () => {
  const f = await fixture();
  try {
    await f.page.clock.install();
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#ta').fill('Newest unsynced words');
    await f.page.clock.fastForward(59 * 60000);
    assert.equal(await f.page.evaluate(() => Auth.active), true);
    await f.page.clock.fastForward(60000); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), 'Newest unsynced words');
    await f.page.evaluate(() => { Auth.lastActivity = Date.now() - Auth.idleMs; document.dispatchEvent(new Event('visibilitychange')); });
    await locked(f.page);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('only one tab can edit; locking in another tab clears the unlocked editor', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const other = await f.context.newPage(); await other.goto(base);
    await other.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    await unlock(other);
    assert.match(await other.locator('#unlock-error').textContent(), /another tab/);
    await other.evaluate(() => Auth.lock()); await locked(f.page);
    await unlock(other); await settled(other);
    assert.equal(await other.locator('#ta').inputValue(), secret);
    await f.page.evaluate(() => Auth.lock()); await locked(other);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('failed migration keeps plaintext originals intact and can be retried', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { window.realWrite = Auth.store.write; Auth.store.write = async () => { throw new Error('Simulated quota failure'); }; });
    await unlock(f.page);
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    assert.equal((await raw(f.page)).legacy[0].content, secret);
    assert.equal((await raw(f.page)).sealed, undefined);
    await f.page.evaluate(() => { Auth.store.write = window.realWrite; });
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    assert.equal((await raw(f.page)).legacy.length, 0);
  } finally { await f.context.close(); }
});

test('late sync response cannot restore notes after locking', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    let release; f.state.delay = new Promise(resolve => { release = resolve; });
    await f.page.evaluate(() => { void App.sync(); });
    while (!f.state.started) await new Promise(resolve => setTimeout(resolve, 10));
    await f.page.locator('#lock').click(); await locked(f.page);
    release(); f.state.delay = null;
    await f.page.waitForTimeout(100);
    await locked(f.page);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('password rotation preserves notes and rejects the previous local password', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    f.state.password = 'new longer password for test';
    const before = await raw(f.page);
    assert.match(await f.page.evaluate(async next => {
      try { await Auth.changePassword('wrong old password', next); return ''; } catch (e) { return e.message; }
    }, f.state.password), /Password update failed/);
    assert.equal((await raw(f.page)).sealed.salt, before.sealed.salt);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    await f.page.evaluate(async ({ old, next }) => Auth.changePassword(old, next), { old: password, next: f.state.password });
    await f.page.locator('#lock').click(); await locked(f.page);
    await unlock(f.page, password);
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    await unlock(f.page, f.state.password); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('failed lock save hides notes and preserves unsaved text for a successful retry', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#ta').fill('Unsaved recovery text');
    await f.page.evaluate(() => { window.realWrite = Auth.store.write; Auth.store.write = async () => { throw new Error('Disk full'); }; });
    await f.page.locator('#lock').click();
    await f.page.waitForFunction(() => Auth.lockFailed && !Auth.locking);
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    assert.equal(await f.page.locator('#unlock-submit').isDisabled(), true);
    await f.page.evaluate(() => { Auth.store.write = window.realWrite; });
    await f.page.locator('#retry-lock').click(); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), 'Unsaved recovery text');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('new browser cannot obtain notes without a successful password login', async () => {
  const f = await fixture({ legacy: false });
  try {
    f.remote.set('Private.md', { sha: 'private', content: secret });
    await unlock(f.page, 'wrong');
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    assert.equal(f.state.calls.some(c => c.pathname.startsWith('/gh/')), false);
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.evaluate(() => [...notes.values()].find(n => n.path === 'Private.md').content), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('service worker supports offline reload and never caches sync or authentication traffic', async () => {
  const f = await fixture({ serviceWorkers: 'allow' });
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await f.page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await f.page.locator('#lock').click(); await locked(f.page);
    await f.context.setOffline(true);
    await f.page.reload();
    await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    const cached = await f.page.evaluate(async () => {
      const result = [];
      for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) result.push(r.url);
      return result;
    });
    assert.equal(cached.some(value => value.includes('/login') || value.includes('/gh/')), false);
    assert.ok(cached.some(value => value.endsWith('secure-store.js')));
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('locking during first encryption waits for migration, then releases keys and preserves data', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const original = Auth.store.write.bind(Auth.store);
      Auth.store.write = async (...args) => {
        if (!window.pausedMigration) {
          window.pausedMigration = true;
          await new Promise(resolve => { window.resumeMigration = resolve; });
        }
        return original(...args);
      };
    });
    await f.page.locator('#unlock-url').fill(url);
    await f.page.locator('#unlock-password').fill(password);
    await f.page.locator('#unlock-submit').click();
    await f.page.waitForFunction(() => !!window.pausedMigration);
    await f.page.evaluate(() => { void Auth.lock(); });
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    await f.page.evaluate(() => window.resumeMigration());
    await locked(f.page);
    assert.equal((await raw(f.page)).legacy.length, 0);
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('locking during rename preserves both the replacement note and deletion marker', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => {
      window.prompt = () => 'Renamed safely';
      const original = Auth.store.write.bind(Auth.store);
      let count = 0;
      Auth.store.write = async (...args) => {
        count++;
        if (count === 2) { window.renamePaused = true; await new Promise(resolve => { window.resumeRename = resolve; }); }
        return original(...args);
      };
      void renameNote().catch(() => {});
    });
    await f.page.waitForFunction(() => !!window.renamePaused);
    await f.page.evaluate(() => { void Auth.lock(); });
    await f.page.evaluate(() => window.resumeRename()); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.get('Renamed safely.md').content), secret);
    assert.equal(await f.page.evaluate(() => notes.get('Secret draft.md').deleted), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('expired cloud sessions stop sync while local notes remain unlocked', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const requestsBefore = f.state.calls.length;
    await f.page.evaluate(async () => { Auth.session.exp = Date.now() - 1; await App.sync(); });
    assert.equal(f.state.calls.length, requestsBefore);
    assert.equal(await f.page.evaluate(() => Auth.active && Auth.session === null), true);
    assert.match(await f.page.locator('#status').textContent(), /expired/);
    assert.equal(await f.page.locator('#ta').inputValue(), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('tampered ciphertext cannot be unlocked or overwritten', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#lock').click(); await locked(f.page);
    await f.page.evaluate(async () => {
      const record = await Auth.store.read();
      record.ciphertext = (record.ciphertext[0] === 'A' ? 'B' : 'A') + record.ciphertext.slice(1);
      await new Promise((resolve, reject) => {
        const tx = Auth.store.db.transaction('sealed', 'readwrite');
        tx.objectStore('sealed').put(record, 'vault');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    });
    const before = await raw(f.page);
    await unlock(f.page);
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    assert.equal(await f.page.locator('#ta').inputValue(), '');
    assert.equal((await raw(f.page)).sealed.ciphertext, before.sealed.ciphertext);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('renames, backlinks, sanitized Markdown and deletes still work with encrypted storage', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(async () => {
      await createNote('Linker', '[[Secret draft]]\n\n<img src=x onerror="window.badHTML=true">');
      await openNote('Secret draft.md');
    });
    assert.match(await f.page.locator('#bl-body').textContent(), /Linker/);
    await f.page.evaluate(async () => { window.prompt = () => 'New name'; await renameNote(); await App.sync(); });
    await settled(f.page);
    assert.equal(f.remote.has('New name.md'), true);
    assert.equal(f.remote.has('Secret draft.md'), false);
    await f.page.evaluate(async () => openNote('Linker.md'));
    assert.match(await f.page.locator('#ta').inputValue(), /\[\[New name\]\]/);
    assert.equal(await f.page.evaluate(() => window.badHTML), undefined);
    assert.equal(await f.page.locator('#pv [onerror]').count(), 0);
    await f.page.evaluate(async () => { await openNote('New name.md'); window.confirm = () => true; await deleteNote(); await App.sync(); });
    await settled(f.page);
    assert.equal(f.remote.has('New name.md'), false);
    const stored = JSON.stringify(await raw(f.page));
    assert.equal(stored.includes('Linker'), false);
    assert.equal(stored.includes(secret), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});
