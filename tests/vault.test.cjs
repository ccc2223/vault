const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const gitSha = bytes => require('node:crypto').createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
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
  const state = { password, offline: false, calls: [], delay: null, started: false, head: 'c0', commits: 0, limitBlobs: 0, beforePatch: null };
  // A small Git Data model for imports: blobs, trees (flat path maps), commits and the branch head.
  const git = { blobs: new Map(), trees: new Map(), commits: new Map() };
  const bump = () => { state.head = 'c' + ++state.commits; };
  const treeId = m => 't' + gitSha(Buffer.from(JSON.stringify([...m].map(([p, v]) => [p, v.sha]).sort())));
  await context.route(url + '/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    if (state.offline) { await route.abort(); return; }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After', 'Content-Type': 'application/json' };
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    state.calls.push({ pathname, method: req.method() });
    let body = {}, status = 200;
    if (pathname === '/login') {
      if (req.postDataJSON().password !== state.password) { status = 401; body = { message: 'Wrong password' }; }
      else { const exp = Date.now() + 90 * 86400000; body = { session: exp + '.fake-session', exp }; }
    } else if (pathname.startsWith('/gh/git/trees/')) {
      if (state.delay) { state.started = true; await state.delay; }
      if (new URL(req.url()).searchParams.has('recursive')) body = { tree: [...remote].map(([name, n]) => ({ path: name, sha: n.sha, type: 'blob' })) };
      else {
        // Top level only, with content-addressed folder ids like GitHub's.
        const top = new Map();
        for (const [name, n] of remote) {
          const [first, ...rest] = name.split('/');
          if (!rest.length) top.set(first, { path: first, type: 'blob', sha: n.sha });
          else (top.get(first)?.files || top.set(first, { path: first, type: 'tree', files: new Map() }).get(first).files).set(rest.join('/'), n);
        }
        body = { tree: [...top.values()].map(e => e.files ? { path: e.path, type: 'tree', sha: treeId(e.files) } : e) };
      }
    } else if (pathname.startsWith('/gh/git/blobs/')) {
      const sha = pathname.split('/').pop();
      const note = [...remote.values()].find(n => n.sha === sha);
      if (state.failBlob === sha) { status = 500; body = { message: 'Upstream error' }; }
      else body = { content: (note?.bytes || Buffer.from(note?.content || '')).toString('base64') };
    } else if (pathname.startsWith('/gh/contents/') && req.method() === 'GET') {
      const note = remote.get(decodeURIComponent(pathname.slice('/gh/contents/'.length)));
      if (note) body = { sha: note.sha, content: Buffer.from(note.content).toString('base64') };
      else { status = 404; body = { message: 'Not Found' }; }
    } else if (pathname.startsWith('/gh/contents/')) {
      const name = decodeURIComponent(pathname.slice('/gh/contents/'.length));
      if (req.method() === 'DELETE') remote.delete(name);
      else { const n = { sha: 'hash-' + Math.random(), content: Buffer.from(req.postDataJSON().content, 'base64').toString() }; remote.set(name, n); body = { content: { sha: n.sha } }; }
      bump();
    } else if (pathname.startsWith('/gh/git/ref/heads/')) {
      body = { object: { sha: state.head } };
    } else if (pathname.startsWith('/gh/git/commits/')) {
      body = { sha: state.head, tree: { sha: 'head-tree:' + state.head } };
    } else if (pathname === '/gh/git/blobs' && req.method() === 'POST') {
      if (state.limitBlobs > 0) { state.limitBlobs--; await route.fulfill({ status: 403, headers: { ...headers, 'Retry-After': '1' }, body: '{"message":"secondary rate limit"}' }); return; }
      const bytes = Buffer.from(req.postDataJSON().content, 'base64'), sha = gitSha(bytes);
      git.blobs.set(sha, bytes); body = { sha };
    } else if (pathname === '/gh/git/trees' && req.method() === 'POST') {
      const { base_tree, tree } = req.postDataJSON();
      const out = !base_tree ? new Map() : base_tree.startsWith('head-tree:')
        ? new Map([...remote].map(([p, n]) => [p, { sha: n.sha, bytes: n.bytes || Buffer.from(n.content) }])) : new Map(git.trees.get(base_tree));
      for (const e of tree) {
        if (e.type === 'tree') for (const [p, v] of git.trees.get(e.sha)) out.set(e.path + '/' + p, v);
        else { const bytes = e.content != null ? Buffer.from(e.content, 'utf8') : git.blobs.get(e.sha); out.set(e.path, { sha: gitSha(bytes), bytes }); }
      }
      const sha = treeId(out); git.trees.set(sha, out); body = { sha };
    } else if (pathname === '/gh/git/commits' && req.method() === 'POST') {
      const sha = 'k' + git.commits.size; git.commits.set(sha, req.postDataJSON()); body = { sha };
    } else if (pathname.startsWith('/gh/git/refs/heads/') && req.method() === 'PATCH') {
      await state.beforePatch?.();
      const { sha, force } = req.postDataJSON(), commit = git.commits.get(sha);
      if (force || commit.parents[0] !== state.head) { status = 422; body = { message: 'Update is not a fast forward' }; }
      else {
        remote.clear();
        for (const [p, v] of git.trees.get(commit.tree)) remote.set(p, { sha: v.sha, content: v.bytes.toString('utf8'), bytes: v.bytes });
        state.head = sha; body = { object: { sha } };
        if (state.losePatch) { state.losePatch = false; await route.abort(); return; }
      }
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

test('pulled edits replace the focused, unedited note so the next keystroke cannot revert them', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    f.remote.set('Secret draft.md', { sha: 'phone-edit', content: 'Edit from phone' });
    await f.page.locator('#ta').focus();
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await f.page.locator('#ta').inputValue(), 'Edit from phone');
    await f.page.keyboard.press('End'); await f.page.keyboard.type('!');
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(f.remote.get('Secret draft.md').content, 'Edit from phone!');
    assert.equal([...f.remote.keys()].some(name => name.includes('conflict')), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('a local delete keeps a remote edit made since the last sync instead of discarding it', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => createNote('Other', 'other'));
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    f.remote.set('Secret draft.md', { sha: 'phone-edit', content: 'Important edit from phone' });
    await f.page.evaluate(async () => { await openNote('Secret draft.md'); window.confirm = () => true; await deleteNote(); await App.sync(); });
    await settled(f.page);
    assert.equal(f.remote.get('Secret draft.md').content, 'Important edit from phone');
    assert.equal(await f.page.evaluate(() => !notes.get('Secret draft.md').deleted && notes.get('Secret draft.md').content), 'Important edit from phone');
    assert.match(await f.page.locator('#status').textContent(), /restored 1 deleted note/);
    // With no remote change, deletes still propagate.
    await f.page.evaluate(async () => { await openNote('Other.md'); await deleteNote(); await App.sync(); });
    await settled(f.page);
    assert.equal(f.remote.has('Other.md'), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('first sync persists pulled notes in one encrypted write, and a failed pull keeps what arrived', async () => {
  const f = await fixture({ legacy: false });
  try {
    for (let i = 0; i < 200; i++) f.remote.set(`n/${i}.md`, { sha: 's' + i, content: `Note ${i}` });
    f.state.failBlob = 's150';
    await unlock(f.page);
    await f.page.evaluate(() => {
      const persist = Auth.store.persist.bind(Auth.store);
      window.persists = 0; Auth.store.persist = () => { window.persists++; return persist(); };
    });
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.match(await f.page.locator('#status').textContent(), /Sync failed/);
    assert.equal(await f.page.evaluate(() => notes.has('n/150.md')), false);
    const pulled = await f.page.evaluate(() => live().filter(n => n.path.startsWith('n/')).length);
    assert.ok(pulled > 0);
    await f.page.locator('#lock').click(); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.evaluate(() => live().filter(n => n.path.startsWith('n/')).length), pulled);

    f.state.offline = false; f.state.failBlob = null;
    await f.page.evaluate(args => Auth.connect(args.url, 'main', args.password), { url, password });
    await f.page.evaluate(() => { window.persists = 0; });
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.get('n/150.md').content), 'Note 150');
    assert.ok(await f.page.evaluate(() => window.persists) <= 3, 'sync should not re-encrypt the vault per note');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

const spacesFile = spaces => JSON.stringify({ version: 1, spaces }, null, 2) + '\n';
const listed = page => page.locator('#list .item[data-p]').evaluateAll(items => items.map(i => i.dataset.p));

test('spaces keep notes, links and search separate, store notes in their folder, and reopen where you were', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#space-name').textContent(), 'Main');
    await f.page.locator('#space').click();
    await f.page.locator('#sp-name').fill('Work');
    await f.page.locator('#sp-new button').click();
    await settled(f.page);
    assert.equal(await f.page.locator('#space-name').textContent(), 'Work');
    assert.equal(await f.page.evaluate(() => cur), 'Work/Home.md');
    await f.page.evaluate(() => createNote('Projects/Plan', '[[Home]] and [[Secret draft]]'));
    await f.page.evaluate(() => setMode('view'));
    assert.equal(await f.page.locator('#pv a.wikilink:not(.missing)').textContent(), 'Home');
    assert.equal(await f.page.locator('#pv a.wikilink.missing').textContent(), 'Secret draft');
    assert.deepEqual((await listed(f.page)).sort(), ['Work/Home.md', 'Work/Projects/Plan.md']);
    assert.equal(await f.page.locator('#list .item .f').textContent(), 'Projects');
    await f.page.locator('#q').fill('device-only');
    assert.deepEqual(await listed(f.page), []);
    await f.page.locator('#q').fill('');

    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(f.remote.has('Work/Projects/Plan.md'), true);
    assert.equal(JSON.parse(f.remote.get('.vault/spaces.json').content).spaces.some(s => s.folder === 'Work' && s.name === 'Work'), true);

    await f.page.evaluate(() => switchSpace(''));
    assert.deepEqual(await listed(f.page), ['Secret draft.md']);
    assert.equal(await f.page.evaluate(() => { window.alert = () => {}; return createNote('Work/Sneaky'); }), null);
    assert.equal(await f.page.evaluate(() => notes.has('Work/Sneaky.md')), false);

    await f.page.evaluate(() => switchSpace('Work'));
    assert.equal(await f.page.evaluate(() => cur), 'Work/Projects/Plan.md');
    await f.page.locator('#lock').click(); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.locator('#space-name').textContent(), 'Work');
    assert.equal(await f.page.evaluate(() => cur), 'Work/Projects/Plan.md');
    const stored = JSON.stringify(await raw(f.page));
    assert.equal(stored.includes('Projects/Plan'), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('a new device picks up spaces; a folder becomes a space without moving files; removing a space keeps its notes', async () => {
  const f = await fixture({ legacy: false });
  try {
    f.remote.set('.vault/spaces.json', { sha: 'sp1', content: spacesFile([{ folder: 'Work', name: 'Day job', updated: 1 }]) });
    f.remote.set('Work/w.md', { sha: 'w', content: 'work note' });
    f.remote.set('Projects/a.md', { sha: 'a', content: 'a' });
    f.remote.set('Projects/b.md', { sha: 'b', content: 'b' });
    f.remote.set('Root.md', { sha: 'r', content: 'root' });
    await unlock(f.page); await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.deepEqual(await f.page.evaluate(() => activeSpaces().map(s => s.name)), ['Main', 'Day job']);
    assert.equal(await f.page.evaluate(() => live().some(n => n.path === 'Work/w.md')), false);
    await f.page.evaluate(() => switchSpace('Work'));
    assert.deepEqual(await listed(f.page), ['Work/w.md']);

    await f.page.evaluate(async () => { window.confirm = () => true; await switchSpace(''); await createSpace('projects'); });
    assert.equal(await f.page.evaluate(() => space), 'Projects');
    assert.deepEqual((await listed(f.page)).sort(), ['Projects/a.md', 'Projects/b.md']);
    const before = f.state.calls.length;
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    const writes = f.state.calls.slice(before).filter(c => c.method !== 'GET').map(c => c.pathname);
    assert.deepEqual(writes, ['/gh/contents/.vault/spaces.json']);

    await f.page.evaluate(() => removeSpace('Projects'));
    assert.equal(await f.page.evaluate(() => space), '');
    assert.deepEqual((await listed(f.page)).sort(), ['Projects/a.md', 'Projects/b.md', 'Root.md', 'Welcome.md']);
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(f.remote.has('Projects/a.md'), true);
    assert.equal(JSON.parse(f.remote.get('.vault/spaces.json').content).spaces.find(s => s.folder === 'Projects').removed, true);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('space changes from two devices merge instead of creating conflict copies', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => createSpace('Work')); await settled(f.page);
    // Another device added a space and removed nothing before this device synced.
    f.remote.set('.vault/spaces.json', { sha: 'other', content: spacesFile([{ folder: 'Journal', name: 'Journal', updated: Date.now() }]) });
    f.remote.set('Journal/today.md', { sha: 'j', content: 'dear diary' });
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    const remote = JSON.parse(f.remote.get('.vault/spaces.json').content).spaces.map(s => s.folder).sort();
    assert.deepEqual(remote, ['', 'Journal', 'Work']);
    assert.equal([...f.remote.keys()].some(name => name.includes('conflict')), false);
    assert.equal(await f.page.evaluate(() => space), 'Work');

    // The other device later removes the space this device is in: follow the open note back to Main.
    f.remote.set('.vault/spaces.json', { sha: 'other2', content: spacesFile([{ folder: 'Journal', name: 'Journal', updated: 1 }, { folder: 'Work', name: 'Work', updated: Date.now() + 1000, removed: true }]) });
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await f.page.evaluate(() => space), '');
    assert.equal(await f.page.locator('#space-name').textContent(), 'Main');
    assert.equal(await f.page.evaluate(() => live().some(n => n.path === 'Work/Home.md')), true);
    assert.deepEqual(await f.page.evaluate(() => activeSpaces().map(s => s.folder).sort()), ['', 'Journal']);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('importing a folder makes one commit with exact bytes, skips hidden and oversized files, and needs no re-download', async () => {
  const f = await fixture();
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vault-import-')), root = path.join(dir, 'My Vault');
  const files = {
    'Home.md': Buffer.from('﻿# Home\r\nSee [[Plan]] and ![[pic.png]]\r\n'),
    'Ideas/Plan.md': Buffer.from('# Plan\n[[Home]] café'),
    'Latin.md': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    'attachments/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]),
    'board.canvas': Buffer.from('{"nodes":[]}'),
    '.obsidian/app.json': Buffer.from('{}'), '.DS_Store': Buffer.from([0]), 'Thumbs.db': Buffer.from([0])
  };
  for (const [name, bytes] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes); }
  fs.closeSync(fs.openSync(path.join(root, 'big.bin'), 'w')); fs.truncateSync(path.join(root, 'big.bin'), 25 * 1024 * 1024 + 1);
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#space').click();
    await f.page.locator('#imp-pick').setInputFiles(root);
    assert.equal(await f.page.locator('#dlg-import').isVisible(), true);
    assert.equal(await f.page.locator('#imp-name').inputValue(), 'My Vault');
    assert.match(await f.page.locator('#imp-sum').textContent(), /^3 notes, 2 attachments/);
    assert.equal(await f.page.locator('#imp-skip summary').textContent(), 'Skipped 4 items');
    assert.match(await f.page.locator('#imp-skip-list').textContent(), /\.obsidian \(hidden\).*big\.bin/);

    f.state.limitBlobs = 1;
    const before = f.state.calls.length;
    await f.page.locator('#imp-go').click();
    await f.page.waitForFunction(() => !document.getElementById('dlg-import').open && space === 'My Vault');
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    const after = f.state.calls.slice(before);
    // Two binary blobs (one retried after a rate limit), a folder tree, the top-level tree, a commit and a fast-forward.
    assert.deepEqual(after.filter(c => c.method !== 'GET').map(c => c.method + ' ' + c.pathname),
      ['POST /gh/git/blobs', 'POST /gh/git/blobs', 'POST /gh/git/blobs', 'POST /gh/git/trees', 'POST /gh/git/trees', 'POST /gh/git/commits', 'PATCH /gh/git/refs/heads/main']);
    // Only the note that isn't valid UTF-8 is downloaded again; every other note was seeded with its GitHub sha.
    assert.deepEqual(after.filter(c => c.pathname.startsWith('/gh/git/blobs/')).map(c => c.pathname), ['/gh/git/blobs/' + gitSha(files['Latin.md'])]);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.startsWith('.') || name === 'Thumbs.db') assert.equal(f.remote.has('My Vault/' + name), false);
      else assert.deepEqual(f.remote.get('My Vault/' + name).bytes, bytes, name);
    }
    assert.equal(f.remote.has('My Vault/big.bin'), false);
    assert.deepEqual(JSON.parse(f.remote.get('.vault/spaces.json').content).spaces.map(s => s.name), ['My Vault']);
    assert.equal(f.remote.has('Secret draft.md'), true);
    assert.deepEqual((await listed(f.page)).sort(), ['My Vault/Home.md', 'My Vault/Ideas/Plan.md', 'My Vault/Latin.md']);
    assert.equal(await f.page.evaluate(() => notes.get('My Vault/Home.md').content), files['Home.md'].toString());
    assert.equal(await f.page.evaluate(() => [...notes.values()].some(n => n.dirty)), false);
    await f.page.evaluate(() => openNote('My Vault/Ideas/Plan.md'));
    await f.page.evaluate(() => setMode('view'));
    assert.equal(await f.page.locator('#pv a.wikilink:not(.missing)').textContent(), 'Home');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('imports refuse existing names, retry when another device pushes first, and write nothing locally if locked', async () => {
  const f = await fixture();
  const start = (root, name) => f.page.evaluate(({ root, name }) => {
    openImport([{ path: root + '/a.md', file: new File(['# A from ' + root], 'a.md') }, { path: root + '/img.png', file: new File([new Uint8Array([0, 1])], 'img.png') }]);
    if (name) document.getElementById('imp-name').value = name;
    document.getElementById('imp-go').click();
  }, { root, name });
  const error = () => f.page.waitForFunction(() => document.getElementById('imp-err').textContent).then(h => h.jsonValue());
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => createSpace('Work')); await settled(f.page);
    await start('work');
    assert.match(await error(), /A space or folder named "work" already exists/);
    f.remote.set('Projects/x.md', { sha: 'x', content: 'remote only' });
    await start('Projects');
    assert.match(await error(), /"Projects" already exists in your notes repo/);
    assert.equal(await f.page.locator('#imp-go').textContent(), 'Retry');

    f.state.beforePatch = async () => { f.state.beforePatch = null; f.remote.set('Phone.md', { sha: 'p', content: 'from phone' }); f.state.head = 'phone'; };
    // Retry reuses the uploaded blobs.
    await f.page.locator('#imp-name').fill('Fresh');
    await f.page.locator('#imp-go').click();
    await f.page.waitForFunction(() => space === 'Fresh'); await settled(f.page);
    assert.equal(f.remote.get('Fresh/a.md').content, '# A from Projects');
    assert.equal(f.remote.has('Phone.md'), true);
    assert.equal(f.remote.has('Fresh/img.png'), true);
    assert.equal(f.state.calls.filter(c => c.method === 'PATCH').length, 2);
    assert.equal(f.state.calls.filter(c => c.pathname === '/gh/git/blobs').length, 1);

    // A branch update that lands but loses its response is recognised on retry instead of blocking the name.
    f.state.losePatch = true;
    await start('Lost');
    assert.match(await error(), /Failed to fetch/);
    await f.page.locator('#imp-go').click();
    await f.page.waitForFunction(() => space === 'Lost'); await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.get('Lost/a.md')?.content), '# A from Lost');
    assert.equal(f.state.calls.filter(c => c.method === 'PATCH').length, 3);

    // Locking while the branch update is in flight writes nothing locally; the commit arrives with the next sync.
    f.state.beforePatch = async () => { f.state.beforePatch = null; await f.page.evaluate(() => Auth.lock()); };
    await start('Late');
    await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.evaluate(() => [...notes.keys()].some(p => p.startsWith('Late/'))), false);
    await f.page.locator('#lock').click(); await locked(f.page);
    f.state.offline = false;
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.get('Late/a.md')?.content), '# A from Late');
    assert.equal(await f.page.evaluate(() => activeSpaces().some(s => s.folder === 'Late')), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('dropped folders are read in batches and hidden folders are never walked', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const scanned = await f.page.evaluate(async () => {
      const file = name => ({ isFile: true, name, file: cb => cb(new File([name], name)) });
      let walkedHidden = false;
      const dir = (name, batches) => ({ isFile: false, isDirectory: true, name, createReader() {
        if (name === '.git') walkedHidden = true;
        let i = 0; return { readEntries: cb => cb(batches[i++] || []) };
      } });
      const root = dir('Vault', [[file('a.md'), dir('.git', [[file('HEAD')]])], [dir('Sub', [[file('b.md')], [file('c.png')]])]]);
      const out = []; await readDropped(root, '', out);
      const scan = scanImport(out);
      return { walkedHidden, root: scan.root, files: scan.files.map(x => x.path), hidden: scan.hidden };
    });
    assert.deepEqual(scanned, { walkedHidden: false, root: 'Vault', files: ['a.md', 'Sub/b.md', 'Sub/c.png'], hidden: ['.git'] });
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});
