const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pbkdf2Sync, createDecipheriv, createHash } = require('node:crypto');
const ready = import('../e2ee.js').then(() => globalThis.VaultCrypto);
const password = 'a long exact password 🦉 with spaces  ';
test('password wrapper matches independent PBKDF2/AES-GCM implementation; recovery is independent', async () => {
  const C = await ready, generated = await C.create(password), h = generated.head, u = h.unlock;
  const key = pbkdf2Sync(password, C.decode(u.salt), 600000, 32, 'sha256'), ct = C.decode(u.ciphertext);
  const dec = createDecipheriv('aes-256-gcm', key, C.decode(u.iv));
  dec.setAAD(Buffer.from(C.json(['vault/key/v1', h.vaultId, h.epoch, h.authDigest, 'password', u.kdf, u.iterations, u.salt])));
  dec.setAuthTag(ct.slice(-16));
  const bundle = JSON.parse(Buffer.concat([dec.update(ct.slice(0, -16)), dec.final()]));
  assert.deepEqual(bundle, generated.bundle);
  assert.deepEqual(await C.unlock(h, password), bundle);
  assert.deepEqual(await C.unlock(h, generated.recoveryKey, true), bundle);
  await assert.rejects(C.unlock(h, password.trim()));
  await assert.rejects(C.unlock(h, generated.recoveryKey.replace(/.$/, generated.recoveryKey.endsWith('A') ? 'B' : 'A'), true));
  assert.notEqual(bundle.master, bundle.accessSecret);
  assert.equal(await C.digest(C.decode(bundle.accessSecret)), h.authDigest);
  assert.throws(() => C.password('short'));
  assert.throws(() => C.password('😀'.repeat(257)));
});
test('object keys and authentication bind vault, epoch, kind, object and revision', async () => {
  const C = await ready, { bundle } = await C.create(password), e = await C.encrypt(bundle, 'note', 'private title / contents');
  assert.equal(new TextDecoder().decode(await C.decrypt(bundle, e)), 'private title / contents');
  const again = await C.encrypt(bundle, 'note', 'private title / contents', e.objectId);
  assert.notEqual(e.revisionId, again.revisionId); assert.notEqual(e.iv, again.iv); assert.notEqual(e.ciphertext, again.ciphertext);
  for (const patch of [{ vaultId: C.id() }, { epoch: 2 }, { kind: 'file' }, { objectId: C.id() }, { revisionId: C.id() }, { ciphertext: C.encode(new Uint8Array(C.decode(e.ciphertext).length)) }]) {
    await assert.rejects(C.decrypt(bundle, { ...e, ...patch }));
  }
  await assert.rejects(C.decrypt({ ...bundle, master: C.encode(C.bytes(32)) }, e));
  await assert.rejects(C.decrypt(bundle, e, { ...e, revisionId: C.id() }));
  assert.equal(await C.gitSha(e), createHash('sha1').update('blob ' + C.json(e).length + '\0').update(C.json(e)).digest('hex'));
});
test('strict size, base64, derivation and manifest validation', async () => {
  const C = await ready, { bundle, head } = await C.create(password);
  for (const s of ['YQ==', 'YR', 'a', '*', 'YQ\n']) assert.throws(() => C.decode(s));
  assert.equal(C.decode('YQ')[0], 97);
  await assert.rejects(C.unlock({ ...head, unlock: { ...head.unlock, iterations: 1 } }, password), /parameters/);
  const ref = { kind: 'note', objectId: C.id(), revisionId: C.id(), sha: '0'.repeat(40) };
  const entry = { path: 'Private/title.md', kind: 'note', deleted: false, mtime: 1, ref };
  const m = { version: 1, vaultId: head.vaultId, epoch: 1, generation: 1, entries: [entry] }, h = { ...head, generation: 1 };
  assert.equal(C.manifest(m, h), m);
  for (const path of ['../note', 'x//y', 'x/./y', '/root', 'x\\y', 'x\0y']) assert.throws(() => C.manifest({ ...m, entries: [{ ...entry, path }] }, h));
  assert.throws(() => C.manifest({ ...m, entries: [entry, entry] }, h));
  await assert.rejects(C.encrypt(bundle, 'note', new Uint8Array(C.LIMITS.note + 1)), /limit/);
});
test('maximum 20 MiB attachment round trips without truncation', async () => {
  const C = await ready, { bundle } = await C.create(password), bytes = new Uint8Array(C.LIMITS.file);
  bytes[0] = 1; bytes[bytes.length - 1] = 255;
  const record = await C.encrypt(bundle, 'file', bytes), plain = await C.decrypt(bundle, record);
  assert.deepEqual(plain, bytes);
  await assert.rejects(C.encrypt(bundle, 'file', new Uint8Array(bytes.length + 1)), /limit/);
});
