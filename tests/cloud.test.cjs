const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./support/protocol.cjs');

test('two devices exchange encrypted notes, attachments and metadata; wire contains no user plaintext', async () => {
  const f = await fixture(), content = 'Secret payroll and tax information', path = 'Private folder/My secret title.md';
  await f.put(path, content);
  await f.put('Private folder/secret.png', Uint8Array.of(1, 2, 3), 'file');
  const otherBundle = await f.C.unlock(f.git.head().value, f.password), other = f.client(otherBundle), base = await other.load();
  assert.equal(base.manifest.entries.length, 2);
  const note = base.manifest.entries.find(e => e.kind === 'note');
  assert.equal(new TextDecoder().decode(await other.read(note.ref)), content);
  const wire = JSON.stringify([...f.git.files]);
  for (const text of [content, path, 'Private folder/secret.png', f.password, f.generated.bundle.master, f.generated.bundle.accessSecret]) assert.equal(wire.includes(text), false, text);
  assert.ok([...f.git.files.keys()].every(p => /^e2ee\/(head.json|objects\/[0-9a-f-]+\/[0-9a-f-]+\.enc)$/.test(p)));
});
test('lost upload and head responses resolve idempotently without duplicate published revisions', async () => {
  const f = await fixture(); let objectLost = false, headLost = false;
  f.git.afterWrite = async path => {
    if (!objectLost && path.includes('/objects/')) { objectLost = true; throw new Error('lost object response'); }
    if (!headLost && path === 'e2ee/head.json') { headLost = true; throw new Error('lost head response'); }
  };
  await f.put('Lost.md', 'kept');
  assert.ok(objectLost && headLost);
  assert.equal((await f.client().load()).manifest.entries[0].path, 'Lost.md');
  assert.equal(f.git.files.size, 4); // initial manifest, note, next manifest, head
});
test('closing a cloud client drops cached plaintext and rejects a decryption finishing after close', async () => {
  const f = await fixture(); await f.put('Private.md', 'private cache contents');
  const client = f.client(), base = await client.load();
  assert.ok(client.cache.size > 0);
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let release, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  crypto.subtle.decrypt = async (...args) => { const data = await decrypt(...args); ready(); await gate; return data; };
  try {
    const read = client.read(base.manifest.entries[0].ref);
    await started;
    client.close();
    assert.equal(client.bundle, null); assert.equal(client.checkpoint, null); assert.equal(client.cache.size, 0);
    release();
    await assert.rejects(read, /locked/);
    assert.equal(client.cache.size, 0, 'late decryption cannot refill the cache');
    await assert.rejects(client.read(base.manifest.entries[0].ref), /locked/);
  } finally { release(); crypto.subtle.decrypt = decrypt; }
});
test('missing, substituted, tampered or omitted objects fail before caller applies a checkpoint', async () => {
  const f = await fixture(); await f.put('Keep.md', 'unsynced local draft stays safe');
  const base = await f.client().load(), entry = base.manifest.entries[0], p = 'e2ee/objects/' + entry.ref.objectId + '/' + entry.ref.revisionId + '.enc';
  const saved = f.git.files.get(p); f.git.files.delete(p);
  await assert.rejects(f.client().read(entry.ref), /missing/);
  f.git.set(p, { ...saved.value, ciphertext: f.C.encode(new Uint8Array(f.C.decode(saved.value.ciphertext).length)) });
  await assert.rejects(f.client().read(entry.ref), /hash/);
  f.git.files.set(p, saved);
  const watcher = f.client(f.generated.bundle, base), writer = f.client();
  await writer.publish(base, []);
  await assert.rejects(watcher.load(), /omitted/);
});
test('known checkpoints detect rollback and conflicting same-generation heads', async () => {
  const f = await fixture(), first = f.git.head();
  await f.put('Latest.md', 'new'); const latest = await f.client().load(), reader = f.client(f.generated.bundle, latest);
  f.git.files.set('e2ee/head.json', first);
  await assert.rejects(reader.load(), /rollback/);
  f.git.set('e2ee/head.json', { ...latest.head, manifest: first.value.manifest });
  await assert.rejects(reader.load(), /checkpoint/);
});
test('concurrent devices receive CAS conflicts and can retry after pulling', async () => {
  const f = await fixture(), a = f.client(), b = f.client(), base = await a.load();
  const pa = await a.prepare(base, []), pb = await b.prepare(base, []);
  await a.publishPrepared(base, pa);
  await assert.rejects(b.publishPrepared(base, pb), { status: 409 });
  await b.publish(await b.load(), []);
  assert.equal(f.git.head().value.generation, 3);
});
test('rotation reencrypts every live record, changes recovery, and immediately revokes old sessions', async () => {
  const f = await fixture(), nextPassword = 'another long vault password';
  await f.put('Private.md', 'private'); await f.put('image.png', Uint8Array.of(8, 9), 'file');
  const cloud = f.client(), base = await cloud.load(), oldToken = f.token;
  const generated = await f.C.create(nextPassword, { vaultId: base.head.vaultId, epoch: 2 });
  const prepared = await cloud.prepareRotation(base, generated);
  assert.equal(f.git.head().value.epoch, 1); // staging does not commit
  await cloud.publishPrepared(base, prepared);
  assert.equal((await f.response('/vault/head', { headers: { Authorization: 'Bearer ' + oldToken } })).status, 401);
  await assert.rejects(f.C.unlock(f.git.head().value, f.password));
  await assert.rejects(f.C.unlock(f.git.head().value, f.generated.recoveryKey, true));
  assert.deepEqual(await f.C.unlock(f.git.head().value, generated.recoveryKey, true), generated.bundle);
  assert.equal((await f.response('/login', { public: true, json: { accessSecret: f.generated.bundle.accessSecret } })).status, 401);
  await f.login(generated.bundle);
  const next = f.client(generated.bundle), cp = await next.load();
  assert.equal(new TextDecoder().decode(await next.read(cp.manifest.entries[0].ref)), 'private');
  const ref = cp.manifest.entries[0].ref, record = f.git.files.get('e2ee/objects/' + ref.objectId + '/' + ref.revisionId + '.enc').value;
  await assert.rejects(f.C.decrypt({ ...generated.bundle, master: f.generated.bundle.master }, record));
});
