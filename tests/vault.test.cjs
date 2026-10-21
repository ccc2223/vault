const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, password, secret, url, unlock, settled, locked, raw, editorText, rotate } = require('./support/browser.cjs');
const h = harness(), fixture = h.fixture;

test('new device decrypts remotely; persisted state and requests omit passwords, titles and master keys', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.page.locator('#lock-screen').isVisible(), true);
    await unlock(f.page, 'wrong but sufficiently long password');
    assert.equal(await f.page.evaluate(() => Auth.active), false);
    assert.equal(f.state.calls.some(c => c.pathname === '/login' || c.pathname.startsWith('/vault/objects/')), false);
    await unlock(f.page); await settled(f.page);
    assert.equal(await editorText(f.page), secret);
    const stored = JSON.stringify(await raw(f.page)), wire = JSON.stringify(f.state.calls);
    const master = await f.page.evaluate(() => Auth.bundle.master);
    for (const value of [secret, 'Secret draft', password, master]) { assert.equal(stored.includes(value), false); assert.equal(wire.includes(value), false); }
    assert.ok((await raw(f.page)).sealed.ciphertext);
    assert.ok(f.state.calls.some(c => c.pathname === '/login' && JSON.parse(c.body).accessSecret));
    await f.page.reload(); await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    assert.equal(await editorText(f.page), '');
    await unlock(f.page); await settled(f.page); assert.equal(await editorText(f.page), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});
test('password rotation reencrypts cloud and device state and revokes previous sessions', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    const oldToken = await f.page.evaluate(() => Auth.session.session), oldHead = f.protocol.git.head().value;
    const { key, error } = await rotate(f); assert.equal(error, null);
    assert.equal(f.protocol.git.head().value.epoch, 2);
    assert.equal((await f.protocol.response('/vault/head', { headers: { Authorization: 'Bearer ' + oldToken } })).status, 401);
    await assert.rejects(f.protocol.C.unlock(f.protocol.git.head().value, password));
    assert.notEqual(oldHead.recovery.ciphertext, f.protocol.git.head().value.recovery.ciphertext);
    assert.ok(await f.protocol.C.unlock(f.protocol.git.head().value, key, true));
    await f.page.evaluate(() => Auth.lock()); await locked(f.page);
    await unlock(f.page, password); assert.equal(await f.page.evaluate(() => Auth.active), false);
    await unlock(f.page, f.state.password); await settled(f.page); assert.equal(await editorText(f.page), secret);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});
test('failed atomic local rekey clears new key journal and keeps the old password usable', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page); const before = await raw(f.page);
    await f.page.evaluate(() => {
      const rekey = Auth.store.rekey.bind(Auth.store);
      Auth.store.rekey = async (...args) => {
        const write = Auth.store.write.bind(Auth.store); Auth.store.write = async () => { throw new Error('disk full'); };
        try { return await rekey(...args); } finally { Auth.store.write = write; }
      };
    });
    assert.match((await rotate(f)).error, /disk full/); await locked(f.page);
    assert.equal((await raw(f.page)).sealed.salt, before.sealed.salt);
    assert.equal(f.protocol.git.head().value.epoch, 1);
    await unlock(f.page); await settled(f.page);
    assert.equal(await f.page.evaluate(() => Auth.store.rotation), null);
    assert.equal(await editorText(f.page), secret);
  } finally { await f.context.close(); }
});
test('interrupted rotation survives reload and resumes only under the new local password', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page); f.state.failCommit = true;
    assert.match((await rotate(f)).error, /new password/); await locked(f.page);
    assert.equal(f.protocol.git.head().value.epoch, 1);
    await f.page.reload(); await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    await unlock(f.page, password); assert.equal(await f.page.evaluate(() => Auth.active), false);
    f.state.failCommit = false;
    await unlock(f.page, f.state.password); await settled(f.page);
    assert.equal(f.protocol.git.head().value.epoch, 2); assert.equal(await editorText(f.page), secret);
    assert.equal(await f.page.evaluate(() => Auth.store.rotation), null);
  } finally { await f.context.close(); }
});
test('recovery key on a fresh device rotates all credentials and preserves synced records', async () => {
  const f = await fixture(); let other;
  try {
    await unlock(f.page); await settled(f.page); await f.page.evaluate(() => Auth.lock()); await locked(f.page);
    other = await f.device(); f.state.password = 'new recovery password with entropy';
    await other.page.locator('#unlock-url').fill(url);
    await other.page.locator('#recover-open').click();
    await other.page.locator('#recovery-input').fill(f.protocol.generated.recoveryKey);
    await other.page.locator('#recovery-password').fill(f.state.password);
    await other.page.locator('#recover-submit').click();
    await other.page.locator('#dlg-recovery-key[open]').waitFor();
    const key = await other.page.locator('#recovery-key').inputValue();
    await other.page.locator('#recovery-confirm').fill(key); await other.page.locator('#recovery-confirm-save').click();
    await settled(other.page); assert.equal(await editorText(other.page), secret);
    assert.equal(f.protocol.git.head().value.epoch, 2);
    // A stale device keeps its unsynced edits and explicitly reconnects using the current password.
    await unlock(f.page); await settled(f.page);
    await f.page.evaluate(({ url, password }) => Auth.connect(url, null, password), { url, password: f.state.password });
    await f.page.evaluate(() => App.sync({ strict: true }));
    assert.equal(await editorText(f.page), secret);
  } finally { await other?.context.close(); await f.context.close(); }
});
test('a failed pull applies none of the remote batch and preserves local drafts', async () => {
  const f = await fixture();
  try {
    await unlock(f.page); await settled(f.page);
    for (let i = 0; i < 20; i++) f.remote.set(`n/${i}.md`, { sha: 's' + i, content: 'Note ' + i });
    f.state.failBlob = 's15'; await f.page.evaluate(() => App.sync()); await settled(f.page);
    assert.match(await f.page.locator('#status').textContent(), /Sync failed/);
    assert.equal(await f.page.evaluate(() => [...notes.keys()].some(p => p.startsWith('n/'))), false);
    assert.equal(await editorText(f.page), secret);
    f.state.failBlob = null; await f.page.evaluate(() => App.sync({ strict: true })); await settled(f.page);
    assert.equal(await f.page.evaluate(() => notes.get('n/15.md').content), 'Note 15');
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
    const other = await f.context.newPage(); await other.goto(h.base);
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
    assert.equal(cached.some(value => value.includes('/login') || value.includes('/vault/')), false);
    assert.ok(cached.some(value => value.endsWith('secure-store.js')));
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

test('initialization confirms recovery key before the single-use setup commits', async () => {
  const f = await fixture({ initialized: false, legacy: false });
  try {
    await f.page.goto(f.base + '/#' + new URLSearchParams({ setup: f.protocol.env.SETUP_TOKEN, server: url }));
    await f.page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
    assert.equal(await f.page.evaluate(() => location.hash), '');
    await f.page.locator('#unlock-confirm').fill(password);
    await f.page.evaluate(p => { document.getElementById('unlock-password').value = p; document.getElementById('unlock-form').requestSubmit(); }, password);
    await f.page.locator('#dlg-recovery-key[open]').waitFor();
    assert.equal(f.protocol.git.head(), undefined);
    const key = await f.page.locator('#recovery-key').inputValue();
    await f.page.locator('#recovery-confirm-save').click();
    assert.match(await f.page.locator('#recovery-key-error').textContent(), /Re-enter/);
    await f.page.locator('#recovery-confirm').fill(key); await f.page.locator('#recovery-confirm-save').click();
    await settled(f.page); assert.equal(f.protocol.git.head().value.epoch, 1);
    assert.equal(await f.page.locator('#recovery-key').inputValue(), '');
    assert.equal(JSON.stringify(await raw(f.page)).includes(key), false);
  } finally { await f.context.close(); }
});
