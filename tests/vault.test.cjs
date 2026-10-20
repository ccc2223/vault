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

async function fixture({ legacy = true, serviceWorkers = 'block', ...options } = {}) {
  const context = await browser.newContext({ serviceWorkers, ...options });
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
      const sha = pathname.split('/').pop();
      const note = [...remote.values()].find(n => n.sha === sha);
      if (state.failBlob === sha) { status = 500; body = { message: 'Upstream error' }; }
      else body = { content: note?.b64 ?? Buffer.from(note?.content || '').toString('base64') };
    } else if (pathname.startsWith('/gh/contents/')) {
      const name = decodeURIComponent(pathname.slice('/gh/contents/'.length));
      if (req.method() === 'DELETE') remote.delete(name);
      else {
        const b64 = req.postDataJSON().content;
        const n = { sha: 'hash-' + Math.random(), content: Buffer.from(b64, 'base64').toString(), b64 };
        remote.set(name, n); body = { content: { sha: n.sha } };
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
const editorText = page => page.evaluate(() => editor.text);
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
  assert.equal(await editorText(page), '');
  assert.equal(await page.locator('#list').textContent(), '');
  assert.equal(await page.evaluate(() => Auth.store.key === null && Auth.session === null && notes.size === 0), true);
}

test('migration is authenticated, encrypted, preserves drafts, and reload starts locked', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.page.locator('#lock-screen').isVisible(), true);
    assert.equal(await editorText(f.page), '');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('vault.gh')), null);
    await unlock(f.page, 'wrong password');
    assert.equal((await raw(f.page)).legacy.length, 1);
    assert.equal((await raw(f.page)).sealed, undefined);
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
    const stored = await raw(f.page);
    assert.equal(stored.legacy.length, 0);
    const text = JSON.stringify(stored);
    for (const value of [secret, 'Secret draft', password, 'fake-session', 'old-secret']) assert.equal(text.includes(value), false);
    assert.ok(stored.sealed.ciphertext);
    assert.ok(await f.page.evaluate(() => Auth.session.exp <= Date.now() + 8 * 3600000));
    await f.page.reload();
    await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    assert.equal(await f.page.locator('#lock-screen').isVisible(), true);
    assert.equal(await editorText(f.page), '');
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('sign out clears UI, keys and credentials; offline unlock still needs the local password', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#gear').click(); await f.page.locator('#cfg').click(); await f.page.locator('#c-clear').click(); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page, 'incorrect');
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    assert.equal(await editorText(f.page), '');
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
    assert.equal(await f.page.evaluate(() => Auth.session), null);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('one-hour idle timeout and suspended-background check lock without erasing edits', async () => {
  const f = await fixture();
  try {
    await f.page.clock.install();
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#ed .cm-content').fill('Newest unsynced words');
    await f.page.clock.fastForward(59 * 60000);
    assert.equal(await f.page.evaluate(() => Auth.active), true);
    await f.page.clock.fastForward(60000); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), 'Newest unsynced words');
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
    assert.equal(await editorText(other), secret);
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
    assert.equal(await editorText(f.page), secret);
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
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
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
    assert.equal(await editorText(f.page), secret);
    await f.page.evaluate(async ({ old, next }) => Auth.changePassword(old, next), { old: password, next: f.state.password });
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
    await unlock(f.page, password);
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    await unlock(f.page, f.state.password); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('failed lock save hides notes and preserves unsaved text for a successful retry', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#ed .cm-content').fill('Unsaved recovery text');
    await f.page.evaluate(() => { window.realWrite = Auth.store.write; Auth.store.write = async () => { throw new Error('Disk full'); }; });
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click();
    await f.page.waitForFunction(() => Auth.lockFailed && !Auth.locking);
    assert.equal(await editorText(f.page), '');
    assert.equal(await f.page.locator('#unlock-submit').isDisabled(), true);
    await f.page.evaluate(() => { Auth.store.write = window.realWrite; });
    await f.page.locator('#retry-lock').click(); await locked(f.page);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), 'Unsaved recovery text');
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
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
    await f.context.setOffline(true);
    await f.page.reload();
    await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    assert.equal(await editorText(f.page), '');
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
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
    assert.equal(await editorText(f.page), '');
    await f.page.evaluate(() => window.resumeMigration());
    await locked(f.page);
    assert.equal((await raw(f.page)).legacy.length, 0);
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
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
    assert.equal(await editorText(f.page), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('tampered ciphertext cannot be unlocked or overwritten', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
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
    assert.equal(await editorText(f.page), '');
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
    assert.match(await editorText(f.page), /\[\[New name\]\]/);
    assert.equal(await f.page.evaluate(() => window.badHTML), undefined);
    assert.equal(await f.page.locator('#ed [onerror]').count(), 0);
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
    await f.page.locator('#ed .cm-content').focus();
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await editorText(f.page), 'Edit from phone');
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
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
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

test('live preview hides Markdown away from the cursor; links, tasks, autocomplete and Ctrl/Cmd+E source work', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => createNote('Live', '# Live\n\nSome **bold** and [[Secret draft|the draft]].\n\n- [ ] task\n'));
    const shownText = () => f.page.locator('#ed .cm-content').textContent();
    await f.page.evaluate(() => editor.view.contentDOM.blur());
    assert.equal(await f.page.locator('#ed .cm-h1').textContent(), 'Live');
    assert.equal(await shownText(), 'LiveSome bold and the draft.task');
    assert.equal(await f.page.locator('#ed .cm-md-strong').textContent(), 'bold');

    // By default the element under the cursor stays rendered; the revealSyntax flag brings its Markdown back.
    await f.page.evaluate(() => { editor.view.focus(); editor.view.dispatch({ selection: { anchor: editor.text.indexOf('bold') + 1 } }); });
    assert.equal(await shownText(), 'LiveSome bold and the draft.task');
    await f.page.evaluate(() => editor.setRevealSyntax(true));
    assert.equal(await shownText(), 'LiveSome **bold** and the draft.task');
    await f.page.evaluate(() => editor.setRevealSyntax(false));
    assert.equal(await shownText(), 'LiveSome bold and the draft.task');
    await f.page.evaluate(() => editor.setRevealSyntax(true));

    // Ctrl/Cmd+E shows the whole source, and the choice is remembered.
    await f.page.keyboard.press('ControlOrMeta+e');
    assert.equal(await f.page.locator('#ed .cm-source').count(), 1);
    assert.match(await shownText(), /^# Live.*\[\[Secret draft\|the draft\]\].*- \[ \] task/);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('vault.mode')), 'source');
    await f.page.keyboard.press('ControlOrMeta+e');
    assert.equal(await f.page.locator('#ed .cm-source').count(), 0);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('vault.mode')), 'live');

    // Typing: [[ autocompletes note names and Enter continues a list.
    await f.page.evaluate(() => editor.focus(true));
    await f.page.keyboard.type('- one');
    await f.page.keyboard.press('Enter');
    await f.page.keyboard.type('see [[Secr');
    await f.page.locator('#sug div.sel').waitFor();
    assert.equal(await f.page.locator('#sug div.sel').textContent(), 'Secret draft');
    await f.page.keyboard.press('Enter');
    assert.equal(await editorText(f.page), '# Live\n\nSome **bold** and [[Secret draft|the draft]].\n\n- [ ] task\n- one\n- see [[Secret draft]]');

    // Task boxes toggle the Markdown, and a rendered link opens its note.
    await f.page.locator('#ed .cm-task').click();
    assert.match(await editorText(f.page), /- \[x\] task/);
    await f.page.locator('#ed .wikilink', { hasText: 'the draft' }).click();
    await f.page.waitForFunction(() => cur === 'Secret draft.md');
    await settled(f.page);
    assert.match(await f.page.evaluate(() => notes.get('Live.md').content), /- \[x\] task\n- one\n- see \[\[Secret draft\]\]$/);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

const spacesFile = spaces => JSON.stringify({ version: 1, spaces }, null, 2) + '\n';
const listed = page => page.locator('#list .item[data-p]').evaluateAll(items => items.map(i => i.dataset.p));

test('the sidebar shows notes in a collapsible folder tree, folders first and numbers in order', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(async () => {
      for (const name of ['Review/10 Later', 'Review/2 Sooner', 'Review/Deep/Inner', 'Archive/Old', 'Zebra']) await createNote(name, 'x');
      await openNote('Zebra.md');
    });
    const rows = () => f.page.locator('#list > *, #list .kids > *').evaluateAll(els =>
      els.filter(e => e.matches('.dir, .item')).map(e => e.dataset.d ? e.dataset.d + '/' : e.dataset.p));
    // Creating a note opened its folders; collapse them all and the tree shows only top-level rows.
    for (const d of ['Review/Deep', 'Review', 'Archive']) await f.page.locator(`#list .dir[data-d="${d}"]`).click();
    assert.deepEqual(await rows(), ['Archive/', 'Review/', 'Secret draft.md', 'Zebra.md']);
    await f.page.locator('#list .dir[data-d="Review"]').click();
    assert.equal(await f.page.locator('#list .dir[data-d="Review"]').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await f.page.locator('#list .dir[data-d="Review"] + .kids > *').evaluateAll(els => els.map(e => e.dataset.d || e.dataset.p)),
      ['Review/Deep', 'Review/2 Sooner.md', 'Review/10 Later.md']);
    await f.page.locator('#list .dir[data-d="Review"]').press('ArrowLeft');
    assert.equal(await f.page.locator('#list .item[data-p="Review/2 Sooner.md"]').count(), 0);
    // Opening a note elsewhere reveals its folders; searching lists matches flat with their folder.
    await f.page.evaluate(() => openNote('Review/Deep/Inner.md'));
    assert.equal(await f.page.locator('#list .item.cur').getAttribute('data-p'), 'Review/Deep/Inner.md');
    await f.page.locator('#q').fill('inner');
    assert.equal(await f.page.locator('#list .dir').count(), 0);
    assert.equal(await f.page.locator('#list .item .f').textContent(), 'Review/Deep');
    await f.page.locator('#q').fill('');
    // Which folders are open is kept with the encrypted vault.
    assert.deepEqual((await f.page.evaluate(() => Auth.store.last.folders)).sort(), ['Review', 'Review/Deep']);
    // A folder's menu adds a note inside it.
    await f.page.locator('#list .dir[data-d="Archive"]').click({ button: 'right' });
    await f.page.locator('#ctx button', { hasText: 'New note in this folder' }).click();
    await f.page.waitForFunction(() => /^Archive\/.+ note 1\.md$/.test(cur));
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

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
    // Links show as links once the cursor leaves them.
    await f.page.evaluate(() => editor.view.contentDOM.blur());
    assert.equal(await f.page.locator('#ed .wikilink:not(.missing)').textContent(), 'Home');
    assert.equal(await f.page.locator('#ed .wikilink.missing').textContent(), 'Secret draft');
    assert.deepEqual((await listed(f.page)).sort(), ['Work/Home.md', 'Work/Projects/Plan.md']);
    assert.equal(await f.page.locator('#list .dir[data-d="Work/Projects"] .t').textContent(), 'Projects');
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
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
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
    // Its notes show in Main under the (closed) folder.
    assert.deepEqual((await listed(f.page)).sort(), ['Root.md', 'Welcome.md']);
    await f.page.locator('#list .dir[data-d="Projects"]').click();
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

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const isImageBytes = b => b.subarray(0, 4).toString('latin1') === 'RIFF' || b.subarray(1, 4).toString('latin1') === 'PNG';
const shown = (page, n) => page.waitForFunction(n => {
  const imgs = [...document.querySelectorAll('#ed img.att')];
  return imgs.length === n && imgs.every(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0);
}, n);

test('pasted images shrink, stay encrypted on the device, sync to attachments/ and still show offline', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 3000; c.height = 1500;
      const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 3000, 1500); g.fillStyle = '#3c3'; g.fillRect(0, 0, 1500, 750);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      editor.focus(true);
      editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await f.page.waitForFunction(() => /Added 1 image/.test(document.getElementById('status').textContent));
    await settled(f.page);
    const name = await f.page.evaluate(() => [...files.keys()][0]);
    assert.match(name, /^attachments\/Pasted image \d{14}\.(webp|png)$/);
    assert.equal(await editorText(f.page), secret + `![[${name.slice('attachments/'.length)}]]`);
    await shown(f.page, 1);
    assert.equal(await f.page.evaluate(() => document.querySelector('#ed img.att').naturalWidth), 2000);

    // Bytes on the device are ciphertext, and the name only lives inside the sealed vault.
    const head = await f.page.evaluate(() => new Promise(resolve => {
      const q = Auth.store.db.transaction('files').objectStore('files').getAll();
      q.onsuccess = () => resolve(q.result.map(r => [...new Uint8Array(r.data).subarray(0, 8)]));
    }));
    assert.equal(head.length, 1);
    assert.equal(isImageBytes(Buffer.from(head[0])), false);
    assert.equal(JSON.stringify(await raw(f.page)).includes('Pasted image'), false);

    f.state.calls.length = 0;
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.ok(isImageBytes(Buffer.from(f.remote.get(name).b64, 'base64')));
    const puts = f.state.calls.filter(c => c.method === 'PUT').map(c => decodeURIComponent(c.pathname));
    assert.deepEqual(puts, ['/gh/contents/' + name, '/gh/contents/Secret draft.md'], 'images upload before the note that embeds them');

    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
    assert.equal(await f.page.evaluate(() => urls.size + files.size), 0);
    f.state.offline = true;
    await unlock(f.page); await settled(f.page);
    await shown(f.page, 1);

    // Changing the password re-encrypts images along with the notes.
    f.state.offline = false; f.state.password = 'new longer password for test';
    await f.page.evaluate(async ({ old, next }) => Auth.changePassword(old, next), { old: password, next: f.state.password });
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
    await unlock(f.page, f.state.password); await settled(f.page);
    await shown(f.page, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('images from GitHub download and embed with Obsidian and Markdown syntax; conflicts keep both copies', async () => {
  const f = await fixture();
  try {
    f.remote.set('photos/attachments/beach.png', { sha: 'beach-1', b64: PNG_1PX });
    f.remote.set('photos/Trip.md', { sha: 'trip-1', content: '![[beach.png|50]]\n![Beach](attachments/beach.png)\n![](gone.png)\n[[beach.png]]' });
    f.remote.set('.obsidian/icon.png', { sha: 'ignored', b64: PNG_1PX });
    await unlock(f.page); await settled(f.page);
    assert.deepEqual(await f.page.evaluate(() => [...files.keys()]), ['photos/attachments/beach.png']);
    await f.page.evaluate(() => openNote('photos/Trip.md'));
    await shown(f.page, 2);
    assert.equal(await f.page.locator('#ed img.att').first().getAttribute('width'), '50');
    assert.equal(await f.page.locator('#ed .att.missing').textContent(), 'gone.png');
    assert.equal(await f.page.locator('#ed .wikilink[data-att]').count(), 1);

    // A new image here and a different one on GitHub under the same name: both are kept.
    await f.page.evaluate(async () => {
      const id = await Auth.store.putFile(Uint8Array.from(atob('R0lGODlhAQABAAAAACw='), c => c.charCodeAt(0)));
      files.set('attachments/dup.gif', { path: 'attachments/dup.gif', id, size: 14, mtime: Date.now(), sha: null, dirty: true });
      await DB.replace();
    });
    f.remote.set('attachments/dup.gif', { sha: 'dup-remote', b64: 'R0lGODlhAgACAAAAACw=' });
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    const conflict = [...f.remote.keys()].find(k => k.startsWith('attachments/dup (conflict '));
    assert.match(conflict, /^attachments\/dup \(conflict \d{4}-\d\d-\d\d\)\.gif$/);
    assert.equal(f.remote.get(conflict).b64, 'R0lGODlhAgACAAAAACw=');
    assert.equal(f.remote.get('attachments/dup.gif').b64, 'R0lGODlhAQABAAAAACw=');

    // Deleting an image on GitHub removes it here too.
    f.remote.delete('photos/attachments/beach.png');
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await f.page.evaluate(() => files.has('photos/attachments/beach.png')), false);
    assert.equal(await f.page.locator('#ed .att.missing').count(), 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('clicking an image picks it; handles resize it freely into widthxheight; Del and Backspace remove it but keep the file', async () => {
  const f = await fixture();
  try {
    f.remote.set('attachments/beach.png', { sha: 'beach-1', b64: PNG_1PX });
    f.remote.set('Pics.md', { sha: 'pics-1', content: 'Top\n![[beach.png|50]]\nSee ![Beach](attachments/beach.png) here\nEnd' });
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => openNote('Pics.md'));
    await shown(f.page, 2);
    const imgs = f.page.locator('#ed img.att');

    // A click picks the image: outlined, three handles, and its Markdown selected but still rendered.
    await imgs.first().click();
    assert.equal(await f.page.locator('#ed .cm-picked').count(), 1);
    assert.equal(await f.page.locator('#ed .cm-picked .cm-handle').count(), 3);
    assert.equal(await f.page.evaluate(() => { const r = editor.view.state.selection.main; return editor.text.slice(r.from, r.to); }), '![[beach.png|50]]');
    assert.doesNotMatch(await f.page.locator('#ed .cm-content').textContent(), /!\[\[/);

    // Dragging the corner changes width and height independently.
    const drag = async (sel, dx, dy) => {
      const b = await f.page.locator(sel).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
      await f.page.mouse.move(x, y); await f.page.mouse.down();
      await f.page.mouse.move(x + dx / 2, y + dy / 2); await f.page.mouse.move(x + dx, y + dy); await f.page.mouse.up();
    };
    await drag('#ed .cm-picked .cm-handle-se', 70, 10);
    assert.equal((await editorText(f.page)).split('\n')[1], '![[beach.png|120x60]]');
    assert.deepEqual(await imgs.first().evaluate(i => [i.getBoundingClientRect().width, i.getBoundingClientRect().height]), [120, 60]);
    assert.equal(await f.page.locator('#ed .cm-picked .cm-handle').count(), 3, 'still picked after resizing');
    await drag('#ed .cm-picked .cm-handle-s', 0, 20);
    assert.equal((await editorText(f.page)).split('\n')[1], '![[beach.png|120x80]]');

    // Markdown images keep their alt text and get the size after it.
    await imgs.nth(1).click();
    await drag('#ed .cm-picked .cm-handle-e', 30, 0);
    assert.match(await editorText(f.page), /See !\[Beach\|\d+x\d+\]\(attachments\/beach\.png\) here/);

    // Backspace removes an inline image; Delete removes an image alone on its line with the line.
    await f.page.keyboard.press('Backspace');
    assert.equal(await editorText(f.page), 'Top\n![[beach.png|120x80]]\nSee  here\nEnd');
    await imgs.first().click();
    await f.page.keyboard.press('Delete');
    assert.equal(await editorText(f.page), 'Top\nSee  here\nEnd');
    assert.equal(await f.page.evaluate(() => files.has('attachments/beach.png')), true, 'the image file stays in attachments/');

    // Undo brings it back, and a double click shows its Markdown to edit.
    await f.page.keyboard.press('ControlOrMeta+z');
    assert.equal(await editorText(f.page), 'Top\n![[beach.png|120x80]]\nSee  here\nEnd');
    await f.page.evaluate(() => editor.setRevealSyntax(true));
    await imgs.first().dblclick();
    assert.match(await f.page.locator('#ed .cm-content').textContent(), /!\[\[beach\.png\|120x80\]\]/);
    assert.equal(await f.page.locator('#ed .cm-picked').count(), 0);
    await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.get('Pics.md').content), 'Top\n![[beach.png|120x80]]\nSee  here\nEnd');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('tables edit cell by cell with rows and columns added; code blocks highlight by language and copy their code', async () => {
  const f = await fixture();
  try {
    await f.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await unlock(f.page); await settled(f.page);
    const note = 'Intro\n\n| Name | Link |\n| --- | :-: |\n| **a** | [[Secret draft\\|draft]] |\n\n```js\nconst x = 1; // one\n```\nEnd';
    await f.page.evaluate(text => createNote('Grid', text), note);
    await f.page.evaluate(() => editor.view.contentDOM.blur());
    const cells = f.page.locator('#ed .cm-table th, #ed .cm-table td');

    // The table renders its cells; the escaped pipe stays inside the link.
    assert.deepEqual(await cells.allTextContents(), ['Name', 'Link', 'a', 'draft']);
    assert.equal(await f.page.locator('#ed .cm-table td strong').textContent(), 'a');
    assert.equal(await cells.nth(3).evaluate(c => c.style.textAlign), 'center');

    // Clicking a cell shows its Markdown there; typing rewrites the table's source.
    await cells.nth(2).click();
    assert.equal(await cells.nth(2).textContent(), '**a**');
    await f.page.keyboard.press('End');
    await f.page.keyboard.type(' b|c');
    assert.match(await editorText(f.page), /\| \*\*a\*\* b\\\|c \| \[\[Secret draft\\\|draft\]\] \|/);
    assert.equal(await f.page.evaluate(() => document.activeElement.dataset.r + document.activeElement.dataset.c), '10', 'the caret stays in the cell');

    // Tab moves on, and Tab in the last cell adds a row; Enter in the last row adds another.
    await f.page.keyboard.press('Tab');
    await f.page.keyboard.press('Tab');
    await f.page.keyboard.type('new');
    await f.page.keyboard.press('Enter');
    await f.page.keyboard.type('more');
    let rows = (await editorText(f.page)).split('\n').slice(2, 7);
    assert.match(rows[3], /^\| new +\| +\|$/);
    assert.match(rows[4], /^\| more +\| +\|$/);
    assert.match(rows[1], /^\| -+ \| :-+: \|$/, 'alignment is kept');

    // The + button adds a column; the cell menu deletes a row.
    await f.page.locator('#ed .cm-table').hover();
    await f.page.locator('#ed .cm-table-add-col').click();
    assert.equal(await f.page.evaluate(() => document.activeElement.dataset.r + document.activeElement.dataset.c), '02');
    await f.page.keyboard.type('Extra');
    assert.match((await editorText(f.page)).split('\n')[2], /^\| Name +\| Link +\| Extra \|$/);
    await cells.nth(9).click({ button: 'right' });
    await f.page.locator('.cm-table-menu button', { hasText: 'Delete row' }).click();
    assert.equal((await editorText(f.page)).match(/more/), null);

    // A link in a rendered cell opens its note.
    await f.page.keyboard.press('Escape');
    await f.page.locator('#ed .cm-table .wikilink', { hasText: 'draft' }).click();
    await f.page.waitForFunction(() => cur === 'Secret draft.md');
    await f.page.evaluate(() => openNote('Grid.md'));

    // Code blocks: fences hidden, the language shown as a label, the code highlighted, and a copy button.
    const head = f.page.locator('#ed .cm-code-head');
    assert.equal(await head.locator('.cm-code-info').textContent(), 'js');
    assert.doesNotMatch(await f.page.locator('#ed .cm-content').textContent(), /```/);
    assert.equal(await f.page.locator('#ed .cm-codeblock .hl-keyword').first().textContent(), 'const');
    assert.equal(await f.page.locator('#ed .cm-codeblock .hl-comment').first().textContent(), '// one');
    await f.page.locator('#ed .cm-code-copy').click();
    assert.equal(await f.page.evaluate(() => navigator.clipboard.readText()), 'const x = 1; // one');
    assert.equal(await f.page.locator('#ed .cm-code-copy').textContent(), 'Copied');

    // The code stays editable in place.
    await f.page.locator('#ed .cm-codeblock .hl-comment').click();
    await f.page.keyboard.press('End');
    await f.page.keyboard.type(' two');
    assert.match(await editorText(f.page), /const x = 1; \/\/ one two\n```\nEnd$/);
    await settled(f.page);
    assert.match(await f.page.evaluate(() => notes.get('Grid.md').content), /\| Name +\| Link +\| Extra \|/);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('the Code button, the editor menu and the command insert a fenced code block, wrapping selected text', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(() => createNote('Snips', 'Intro'));
    // Nothing selected: a new block below the current line, the cursor after the opening fence to type a language.
    await f.page.evaluate(() => editor.focus(true));
    await f.page.locator('#code').click();
    assert.equal(await f.page.locator('#ed .cm-code-hint').textContent(), 'language');
    await f.page.keyboard.type('js');
    assert.equal(await f.page.locator('#ed .cm-code-hint').count(), 0);
    await f.page.keyboard.press('Enter');
    await f.page.keyboard.type('let a = 1');
    assert.equal(await editorText(f.page), 'Intro\n```js\nlet a = 1\n```\n');
    assert.equal(await f.page.locator('#ed .cm-codeblock .hl-keyword').first().textContent(), 'let');

    // Selected text is wrapped; text sharing its lines moves onto lines of its own; fences inside get a longer fence.
    await f.page.evaluate(() => { editor.load('see ```x``` here'); editor.view.dispatch({ selection: { anchor: 4, head: 11 } }); });
    await f.page.locator('#code').click();
    assert.equal(await editorText(f.page), 'see \n````\n```x```\n````\n here');

    // The right-click menu inserts below the line it was opened on.
    await f.page.evaluate(() => editor.load('One\n\nTwo'));
    const two = f.page.locator('#ed .cm-line', { hasText: 'Two' });
    await two.click({ button: 'right' });
    await f.page.locator('#ctx button', { hasText: 'Insert code block' }).click();
    assert.equal(await editorText(f.page), 'One\n\nTwo\n```\n```\n');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('Escape, arrow down, or a click or tap below a table leave it, and typing there starts a paragraph instead of a row', async () => {
  const mid = 'Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nEnd', last = 'Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |';
  const tail = /\| 1x +\| 2 +\|\n\nAfter(\nEnd)?$/;
  async function check(f, name, note, exit, tap = false) {
    await f.page.evaluate(([n, t]) => createNote(n, t), [name, note]);
    if (note) await f.page.locator('#ed .cm-table td').first()[tap ? 'tap' : 'click']();
    else await f.page.evaluate(() => { editor.focus(true); editor.insertTable(2, 2); });
    await f.page.keyboard.type('x');
    await exit();
    assert.equal(await f.page.evaluate(() => editor.view.hasFocus), true, name + ': the caret is back in the note');
    await f.page.keyboard.type('After');
    const text = await editorText(f.page);
    if (note) assert.match(text, tail, name);
    else assert.match(text, /\| x +\| +\|\n\| -+ \| -+ \|\n\| +\| +\|\n\nAfter$/, name);
    assert.equal(await f.page.locator('#ed .cm-table td').count(), 2, name + ': no row was added');
  }
  const below = page => async () => {
    const b = await page.locator('#ed .cm-table').boundingBox();
    return { x: b.x + 20, y: b.y + b.height + 40 };
  };
  let f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await check(f, 'Escape', mid, () => f.page.keyboard.press('Escape'));
    await check(f, 'Down', mid, () => f.page.keyboard.press('ArrowDown'));
    await check(f, 'Picker', '', async () => { const p = await below(f.page)(); await f.page.mouse.click(p.x, p.y); });
    await check(f, 'Last', last, async () => { const p = await below(f.page)(); await f.page.mouse.click(p.x, p.y); });
    // Typing on the line right after a table, however the caret got there, starts a paragraph too.
    await f.page.evaluate(() => createNote('Arrowed', '| a | b |\n| - | - |\n| 1 | 2 |\n\nEnd'));
    await f.page.evaluate(() => { editor.view.focus(); editor.view.dispatch({ selection: { anchor: editor.text.indexOf('\n\nEnd') + 1 } }); });
    await f.page.keyboard.type('After');
    assert.match(await editorText(f.page), /\| 2 \|\n\nAfter\nEnd$/);
    // Source mode keeps plain Markdown typing.
    await f.page.keyboard.press('Control+e');
    await f.page.evaluate(() => editor.view.dispatch({ selection: { anchor: editor.text.indexOf('| 2 |') + 5 } }));
    await f.page.keyboard.press('Enter');
    await f.page.keyboard.type('| 3 | 4 |');
    assert.match(await editorText(f.page), /\| 2 \|\n\| 3 \| 4 \|\n\nAfter/);
    await f.page.keyboard.press('Control+e');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
  // On a phone there is no Escape key: a tap below the table leaves it.
  f = await fixture({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 760 } });
  try {
    await unlock(f.page); await settled(f.page);
    await check(f, 'Tap', last, async () => { const p = await below(f.page)(); await f.page.touchscreen.tap(p.x, p.y); }, true);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('deleted notes go to the trash and earlier versions come back, encrypted on the device', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const versions = () => f.page.evaluate(() => Auth.store.history.filter(v => !v.trashed).sort((a, b) => a.time - b.time).map(v => v.why));
    // Editing keeps the text it replaces, and so does a change pulled from another device.
    await f.page.locator('#ed .cm-content').fill('Second draft');
    await settled(f.page);
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    f.remote.set('Secret draft.md', { sha: 'phone', content: 'From phone' });
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await editorText(f.page), 'From phone');
    assert.deepEqual(await versions(), ['edit', 'sync']);

    // Pick the oldest version in the history and restore it; the replaced text is kept as a version too.
    await f.page.locator('#gear').click(); await f.page.locator('#hist').click();
    assert.equal(await f.page.locator('#h-list div[data-i]').count(), 2);
    await f.page.locator('#h-list div[data-i="1"]').click();
    await f.page.waitForFunction(s => document.getElementById('h-view').textContent === s, secret);
    await f.page.locator('#h-restore').click();
    await f.page.waitForFunction(s => editor.text === s, secret);
    await settled(f.page);
    assert.deepEqual(await versions(), ['edit', 'sync', 'restore']);

    // Deleting moves the note to the trash, where it can be restored.
    await f.page.evaluate(() => { window.confirm = () => true; });
    await f.page.locator('#gear').click(); await f.page.locator('#del').click();
    await f.page.waitForFunction(() => cur !== 'Secret draft.md'); await settled(f.page);
    assert.equal(await f.page.locator('#trash-n').textContent(), '1');
    await f.page.locator('#trash').click();
    assert.match(await f.page.locator('#h-list').textContent(), /Secret draft.*Deleted/s);
    await f.page.waitForFunction(s => document.getElementById('h-view').textContent === s, secret);
    await f.page.locator('#h-restore').click();
    await f.page.waitForFunction(() => cur === 'Secret draft.md'); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
    assert.equal(await f.page.locator('#trash-n').isHidden(), true);
    assert.equal((await versions()).length, 3, 'the restored note keeps its history');
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(f.remote.get('Secret draft.md').content, secret);

    // A note deleted on another device lands in this device's trash.
    f.remote.delete('Secret draft.md');
    await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.has('Secret draft.md')), false);
    await f.page.locator('#trash').click();
    assert.match(await f.page.locator('#h-list').textContent(), /Deleted on another device/);
    await f.page.locator('#h-close').click();

    // Versions are ciphertext on the device, survive locking and are re-encrypted with a new password.
    const stored = await f.page.evaluate(() => new Promise(resolve => {
      const q = Auth.store.db.transaction('versions').objectStore('versions').getAll();
      q.onsuccess = () => resolve(q.result.map(r => new TextDecoder().decode(r.data)));
    }));
    assert.ok(stored.length >= 4);
    for (const text of stored) assert.equal(text.includes('Second draft') || text.includes(secret), false);
    assert.equal(JSON.stringify(await raw(f.page)).includes(secret), false);
    const texts = () => f.page.evaluate(() => Promise.all(Auth.store.history.sort((a, b) => a.time - b.time).map(v => Auth.store.getVersion(v.id))));
    const before = await texts();
    assert.deepEqual(before.slice(0, 3), [secret, 'Second draft', 'From phone']);
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
    f.state.password = 'new longer password for test';
    await unlock(f.page); await settled(f.page);
    assert.deepEqual(await texts(), before);
    await f.page.evaluate(async ({ old, next }) => Auth.changePassword(old, next), { old: password, next: f.state.password });
    await f.page.locator('#gear').click(); await f.page.locator('#lock').click(); await locked(f.page);
    await unlock(f.page, f.state.password); await settled(f.page);
    assert.deepEqual(await texts(), before);

    // Delete forever empties the trash.
    await f.page.locator('#trash').click();
    await f.page.locator('#h-forget').click();
    await f.page.locator('#h-list .none', { hasText: 'The trash is empty.' }).waitFor();
    assert.equal(await f.page.evaluate(() => Auth.store.history.some(v => v.trashed)), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('the command palette lists every action, filters as you type, runs one and puts it first next time', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.keyboard.press('ControlOrMeta+p');
    await f.page.locator('#dlg-cmd[open]').waitFor();
    const names = () => f.page.locator('#cmd-list div[data-i]').evaluateAll(rows => rows.map(r => r.firstChild.textContent));
    assert.ok((await names()).includes('Open trash'));
    await f.page.keyboard.type('chkbox');
    assert.deepEqual(await names(), ['Insert checkbox']);
    await f.page.keyboard.press('Enter');
    assert.equal(await f.page.locator('#dlg-cmd[open]').count(), 0);
    await f.page.waitForFunction(s => editor.text === '- [ ] ' + s, secret);
    await f.page.keyboard.type(' buy milk');
    assert.equal(await editorText(f.page), '- [ ] ' + secret + ' buy milk');

    // The toolbar button opens it too, with the last command first; Escape closes it.
    await f.page.locator('#gear').click(); await f.page.locator('#cmd').click();
    assert.equal((await names())[0], 'Insert checkbox');
    await f.page.keyboard.type('sync settings');
    await f.page.locator('#cmd-list div[data-i]', { hasText: 'Sync settings' }).click();
    await f.page.locator('#dlg-cfg[open]').waitFor();
    await f.page.locator('#c-cancel').click();
    await f.page.keyboard.press('ControlOrMeta+p');
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.locator('#dlg-cmd[open]').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('#tags highlight in the editor, list with counts in the sidebar, search exactly and autocomplete', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(async () => {
      await createNote('Plan', 'Trip #travel and #work/q4 here.\n\n`#notatag` and [[Secret draft#heading]] and a#b\n\n```\n#incode\n```\n');
      await createNote('Log', '#travel notes #travelling');
    });
    const tags = () => f.page.locator('#tag-list button').allTextContents();
    await f.page.evaluate(() => { document.getElementById('tags').open = true; });
    assert.deepEqual(await tags(), ['#travel 2', '#travelling 1', '#work/q4 1']);
    assert.deepEqual(await f.page.locator('#ed .cm-tag').allTextContents(), ['#travel', '#travelling']);

    // A tag search matches that tag (and nested ones), not tags that merely start with the same letters.
    await f.page.locator('#tag-list button', { hasText: '#travelling' }).click();
    assert.equal(await f.page.locator('#q').inputValue(), '#travelling');
    assert.deepEqual(await listed(f.page), ['Log.md']);
    await f.page.locator('#tag-list button', { hasText: '#travel 2' }).click();
    assert.deepEqual((await listed(f.page)).sort(), ['Log.md', 'Plan.md']);
    await f.page.locator('#q').fill('#work');
    assert.deepEqual(await listed(f.page), ['Plan.md']);
    // Clicking a tag in a note searches for it.
    await f.page.locator('#q').fill('');
    await f.page.locator('#ed .cm-tag', { hasText: '#travelling' }).click();
    assert.equal(await f.page.locator('#q').inputValue(), '#travelling');

    // Typing # suggests tags already in use.
    await f.page.evaluate(() => editor.focus(true));
    await f.page.keyboard.type(' #wo');
    await f.page.locator('#sug div.sel').waitFor();
    assert.equal(await f.page.locator('#sug div.sel').textContent(), '#work/q4');
    await f.page.keyboard.press('Enter');
    assert.equal(await editorText(f.page), '#travel notes #travelling #work/q4 ');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test("today's note opens or is created from the Daily template; templates fill in new notes and the cursor", async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const day = await f.page.evaluate(() => formatDate(new Date(), 'YYYY-MM-DD'));
    await f.page.locator('#today').click();
    await f.page.waitForFunction(d => cur === 'Daily/' + d + '.md', day);
    assert.equal(await editorText(f.page), `# ${day}\n\n`);
    await f.page.evaluate(() => openNote('Secret draft.md'));
    await f.page.keyboard.press('Alt+d');
    await f.page.waitForFunction(d => cur === 'Daily/' + d + '.md', day);
    assert.equal(await f.page.evaluate(() => live().filter(n => n.path.startsWith('Daily/')).length), 1, 'opens the same note again');

    // With Templates/Daily, a new day's note uses it.
    await f.page.evaluate(async () => {
      await createNote('Templates/Daily', '# {{title}}\n{{date:dddd}} at {{time}}\n\n## Tasks\n');
      await createNote('Templates/Meeting', '# {{title}}\nDate: {{date}}\n');
      window.confirm = () => true; await openNote('Daily/' + formatDate(new Date(), 'YYYY-MM-DD') + '.md'); await deleteNote();
    });
    await f.page.locator('#today').click();
    await f.page.waitForFunction(d => cur === 'Daily/' + d + '.md', day);
    const weekday = await f.page.evaluate(() => formatDate(new Date(), 'dddd'));
    assert.match(await editorText(f.page), new RegExp(`^# ${day}\\n${weekday} at \\d\\d:\\d\\d\\n\\n## Tasks\\n$`));

    // New note from template, and insert template at the cursor, from the command palette.
    await f.page.keyboard.press('ControlOrMeta+p');
    await f.page.keyboard.type('new note from template');
    await f.page.keyboard.press('Enter');
    assert.deepEqual(await f.page.locator('#cmd-list div[data-i]').allTextContents(), ['Daily', 'Meeting']);
    await f.page.keyboard.type('meet');
    await f.page.keyboard.press('Enter');
    await f.page.waitForFunction(() => / note \d+\.md$/.test(cur));
    const title = await f.page.evaluate(() => baseName(cur));
    assert.equal(await editorText(f.page), `# ${title}\nDate: ${day}\n`);
    await f.page.keyboard.press('Escape');
    await f.page.evaluate(() => editor.focus(true));
    await f.page.keyboard.press('ControlOrMeta+p');
    await f.page.keyboard.type('insert template');
    await f.page.keyboard.press('Enter');
    await f.page.locator('#cmd-list div[data-i]', { hasText: 'Meeting' }).click();
    await f.page.waitForFunction(t => editor.text.endsWith(`Date: ${t}\n`) && editor.text.split('Date:').length === 3, day);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('[[Note#Heading]] opens a note at its heading, headings autocomplete, and the outline jumps around', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const filler = Array.from({ length: 80 }, (_, i) => 'line ' + i).join('\n');
    await f.page.evaluate(async filler => {
      await createNote('Long', `# Long\n\n## Intro\n${filler}\n\n\`\`\`\n# not a heading\n\`\`\`\n### Deep Part ##\n${filler}\n## End\n`);
      await createNote('Links', 'See [[Long#Deep part]] and [[Long#End|the end]], and [[#Top]].\n\n# Top\n');
    }, filler);
    // Links show the heading too, and open the note with that heading at the top.
    assert.deepEqual(await f.page.locator('#ed .wikilink').allTextContents(), ['Long#Deep part', 'the end', '#Top']);
    await f.page.locator('#ed .wikilink', { hasText: 'Long#Deep part' }).click();
    await f.page.waitForFunction(() => cur === 'Long.md');
    await f.page.waitForFunction(() => editor.view.state.doc.lineAt(editor.pos).text === '### Deep Part ##');
    const top = await f.page.evaluate(() => editor.view.coordsAtPos(editor.pos).top - editor.view.scrollDOM.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 80, 'heading scrolled to the top, was ' + top);

    // The outline lists headings outside code, indented by level, and jumps to them.
    await f.page.locator('#ol-btn').click();
    const outline = () => f.page.locator('#ol-list div[data-i]').evaluateAll(rows => rows.map(r => r.textContent + ':' + r.style.paddingLeft + (r.classList.contains('cur') ? '*' : '')));
    assert.deepEqual(await outline(), ['Long:8px', 'Intro:20px', 'Deep Part:32px*', 'End:20px']);
    await f.page.locator('#ol-list div[data-i]', { hasText: 'End' }).click();
    await f.page.waitForFunction(() => editor.view.state.doc.lineAt(editor.pos).text === '## End');
    await f.page.waitForFunction(() => document.querySelector('#ol-list .cur')?.textContent === 'End');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('vault.outline')), 'open');

    // [[#Heading]] jumps within the open note; typing [[Note# suggests that note's headings.
    await f.page.evaluate(() => openNote('Links.md'));
    await f.page.locator('#ed .wikilink', { hasText: '#Top' }).click();
    await f.page.waitForFunction(() => editor.view.state.doc.lineAt(editor.pos).text === '# Top');
    await f.page.evaluate(() => editor.focus(true));
    await f.page.keyboard.type('[[Long#in');
    await f.page.locator('#sug div.sel').waitFor();
    assert.deepEqual(await f.page.locator('#sug div').allTextContents(), ['Long#Intro']);
    await f.page.keyboard.press('Enter');
    assert.match(await editorText(f.page), /# Top\n\[\[Long#Intro\]\]$/);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('the Tasks view collects open tasks across notes, ticks them in place and jumps to them', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(async () => {
      await createNote('Shop', '# Shop\n- [ ] milk\n- [x] bread\n  1. [ ] nested eggs\n```\n- [ ] not a task\n```\n');
      await createNote('Work', '# Work\n- [ ] send report\n');
    });
    await settled(f.page);
    assert.equal(await f.page.locator('#tasks-n').textContent(), '3');
    await f.page.locator('#tasks').click();
    const rows = () => f.page.locator('#tk-list').evaluate(l => [...l.children].map(c => c.className === 'g' ? '> ' + c.textContent : (c.querySelector('input').checked ? '[x] ' : '[ ] ') + c.textContent));
    assert.deepEqual(await rows(), ['> Work', '[ ] send report', '> Shop', '[ ] milk', '[ ] nested eggs']);
    await f.page.locator('#tk-done').check();
    assert.deepEqual(await rows(), ['> Work', '[ ] send report', '> Shop', '[ ] milk', '[x] bread', '[ ] nested eggs']);
    await f.page.locator('#tk-done').uncheck();

    // Ticking works in the open note (as an editor change) and in other notes.
    await f.page.locator('#tk-list label', { hasText: 'send report' }).locator('input').click();
    await f.page.locator('#tk-list label', { hasText: 'nested eggs' }).locator('input').click();
    assert.deepEqual(await rows(), ['> Shop', '[ ] milk']);
    await settled(f.page);
    assert.equal(await editorText(f.page), '# Work\n- [x] send report\n');
    assert.match(await f.page.evaluate(() => notes.get('Shop.md').content), /  1\. \[x\] nested eggs/);
    assert.equal(await f.page.locator('#tasks-n').textContent(), '1');

    // Clicking a task's text opens its note at that line.
    await f.page.locator('#tk-list label', { hasText: 'milk' }).locator('span').click();
    await f.page.waitForFunction(() => cur === 'Shop.md' && editor.view.state.doc.lineAt(editor.pos).text === '- [ ] milk');
    assert.equal(await f.page.locator('#dlg-tasks[open]').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});
