/* Vault cloud protocol v1. Web Crypto only; this file is shared with the Worker. */
(function (root) {
  'use strict';
  const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true });
  const VERSION = 1, ITERATIONS = 600000;
  const LIMITS = Object.freeze({ note: 5 * 1024 * 1024, file: 20 * 1024 * 1024, manifest: 4 * 1024 * 1024 });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const fail = message => { throw new Error(message || 'Invalid encrypted vault data.'); };
  function fields(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) fail();
  }
  const id = () => crypto.randomUUID();
  const bytes = n => crypto.getRandomValues(new Uint8Array(n));
  function encode(data) {
    const value = new Uint8Array(data); let s = '';
    for (let i = 0; i < value.length; i += 32768) s += String.fromCharCode(...value.subarray(i, i + 32768));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(s, max = 30 * 1024 * 1024) {
    if (typeof s !== 'string' || s.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) fail();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tail = alphabet.indexOf(s.at(-1));
    if (s.length % 4 === 2 && (tail & 15) || s.length % 4 === 3 && (tail & 3)) fail();
    const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/')), b = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
    if (b.length > max) fail();
    return b;
  }
  const fixed = (s, n) => decode(s, n).length === n || fail();
  const json = value => utf8.encode(JSON.stringify(value));
  const parse = value => JSON.parse(text.decode(value));
  const digest = async value => encode(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? utf8.encode(value) : value));
  async function gitSha(value) {
    const raw = json(value), prefix = utf8.encode('blob ' + raw.length + '\0');
    const all = new Uint8Array(prefix.length + raw.length); all.set(prefix); all.set(raw, prefix.length);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function password(value) {
    if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 256) fail('Use a password of 15–256 characters. Spaces are allowed.');
    return value;
  }
  function ref(r, kind) {
    fields(r, 'kind,objectId,revisionId,sha');
    if (!UUID.test(r.objectId) || !UUID.test(r.revisionId) || r.kind !== kind || !/^[0-9a-f]{40}$/.test(r.sha)) fail();
    return r;
  }
  function envelope(e, max) {
    if (!e || typeof e !== 'object') fail();
    fixed(e.iv, 12);
    const length = decode(e.ciphertext, max + 16).length;
    if (length < 16) fail();
  }
  function head(h, draft = false) {
    fields(h, 'format,version,vaultId,epoch,generation,authDigest,unlock,recovery,manifest');
    fields(h.unlock, 'kdf,iterations,salt,iv,ciphertext'); fields(h.recovery, 'iv,ciphertext');
    if (h.format !== 'vault-e2ee' || h.version !== VERSION || !UUID.test(h.vaultId) || !Number.isSafeInteger(h.epoch) || h.epoch < 1 ||
      !Number.isSafeInteger(h.generation) || h.generation < (draft ? 0 : 1)) fail('Unsupported encrypted vault format.');
    fixed(h.authDigest, 32);
    if (h.unlock?.kdf !== 'PBKDF2-SHA256' || h.unlock.iterations !== ITERATIONS) fail('Unsupported password derivation parameters.');
    fixed(h.unlock.salt, 16); envelope(h.unlock, 2048); envelope(h.recovery, 2048);
    if (!draft || h.manifest) ref(h.manifest, 'manifest');
    return h;
  }
  function bundle(b, h) {
    fields(b, 'version,vaultId,epoch,master,accessSecret');
    if (b.version !== VERSION || b.vaultId !== h.vaultId || b.epoch !== h.epoch) fail('Vault identity does not match.');
    fixed(b.master, 32); fixed(b.accessSecret, 32); return b;
  }
  async function aes(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function hkdf(raw, salt, info) {
    const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(salt), info: json(info) }, key,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function passwordKey(value, salt) {
    password(value);
    const key = await crypto.subtle.importKey('raw', utf8.encode(value), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: decode(salt, 16), iterations: ITERATIONS }, key,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(key, data, aad) {
    const iv = bytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: json(aad), tagLength: 128 }, key, data);
    return { iv: encode(iv), ciphertext: encode(ciphertext) };
  }
  async function unseal(key, value, aad) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv, 12), additionalData: json(aad), tagLength: 128 }, key, decode(value.ciphertext)));
  }
  function wrapContext(h, kind) {
    return ['vault/key/v1', h.vaultId, h.epoch, h.authDigest, kind,
      ...(kind === 'password' ? [h.unlock.kdf, h.unlock.iterations, h.unlock.salt] : [])];
  }
  async function recoverySecret(value) {
    const match = /^VK1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{6})$/.exec(String(value).trim());
    if (!match) fail('Invalid recovery key.');
    const raw = decode(match[1], 32); fixed(match[2], 4);
    if (encode((await crypto.subtle.digest('SHA-256', raw)).slice(0, 4)) !== match[2]) fail('Recovery key checksum does not match.');
    return raw;
  }
  async function create(value, options = {}) {
    password(value);
    const b = { version: VERSION, vaultId: options.vaultId || id(), epoch: options.epoch || 1, master: encode(bytes(32)), accessSecret: encode(bytes(32)) };
    const h = { format: 'vault-e2ee', version: VERSION, vaultId: b.vaultId, epoch: b.epoch, generation: 0,
      authDigest: await digest(decode(b.accessSecret)), unlock: { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: encode(bytes(16)) }, manifest: null };
    const recovery = bytes(32);
    const recoveryKey = 'VK1.' + encode(recovery) + '.' + encode((await crypto.subtle.digest('SHA-256', recovery)).slice(0, 4));
    Object.assign(h.unlock, await seal(await passwordKey(value, h.unlock.salt), json(b), wrapContext(h, 'password')));
    h.recovery = await seal(await hkdf(recovery, h.vaultId, ['vault/recovery/v1']), json(b), wrapContext(h, 'recovery'));
    head(h, true);
    return { bundle: b, head: h, recoveryKey };
  }
  async function unlock(h, value, recovery = false) {
    head(h, h.generation === 0);
    let b;
    try {
      const key = recovery ? await hkdf(await recoverySecret(value), h.vaultId, ['vault/recovery/v1']) : await passwordKey(value, h.unlock.salt);
      b = bundle(parse(await unseal(key, recovery ? h.recovery : h.unlock, wrapContext(h, recovery ? 'recovery' : 'password'))), h);
    } catch { fail(recovery ? 'Could not unlock with that recovery key.' : 'Could not unlock the vault. Check the password.'); }
    if (await digest(decode(b.accessSecret)) !== h.authDigest) fail('Vault credentials do not match.');
    return b;
  }
  function recordContext(e) { return ['vault/object/v1', e.vaultId, e.epoch, e.kind, e.objectId, e.revisionId]; }
  function record(e, expected, h) {
    fields(e, 'version,vaultId,epoch,kind,objectId,revisionId,iv,ciphertext');
    if (e.version !== VERSION || e.vaultId !== h.vaultId || e.epoch !== h.epoch || !Object.hasOwn(LIMITS, e.kind) || !UUID.test(e.objectId) || !UUID.test(e.revisionId)) fail();
    if (expected && (e.kind !== expected.kind || e.objectId !== expected.objectId || e.revisionId !== expected.revisionId)) fail('Encrypted record was substituted.');
    envelope(e, LIMITS[e.kind]); return e;
  }
  async function encrypt(b, kind, data, objectId = id()) {
    if (!Object.hasOwn(LIMITS, kind)) fail();
    const raw = typeof data === 'string' ? utf8.encode(data) : new Uint8Array(data);
    if (raw.byteLength > LIMITS[kind]) fail('Record exceeds the encrypted vault size limit.');
    const e = { version: VERSION, vaultId: b.vaultId, epoch: b.epoch, kind, objectId, revisionId: id() };
    Object.assign(e, await seal(await hkdf(decode(b.master, 32), b.vaultId, recordContext(e)), raw, recordContext(e)));
    return e;
  }
  async function decrypt(b, e, expected) {
    record(e, expected, b);
    try { return await unseal(await hkdf(decode(b.master, 32), b.vaultId, recordContext(e)), e, recordContext(e)); }
    catch { fail('Encrypted record failed authentication. No local edits were changed.'); }
  }
  function path(value) {
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) fail('Invalid note path.');
    return value;
  }
  function manifest(m, h) {
    fields(m, 'version,vaultId,epoch,generation,entries');
    if (m.version !== VERSION || m.vaultId !== h.vaultId || m.epoch !== h.epoch || m.generation !== h.generation || !Array.isArray(m.entries) || m.entries.length > 20000) fail('Invalid encrypted manifest.');
    const seen = new Set();
    for (const entry of m.entries) {
      fields(entry, 'path,kind,deleted,mtime,ref');
      path(entry.path);
      if (seen.has(entry.path) || !['note', 'file'].includes(entry.kind) || typeof entry.deleted !== 'boolean' || !Number.isSafeInteger(entry.mtime) || entry.mtime < 0) fail('Invalid encrypted manifest entry.');
      seen.add(entry.path); ref(entry.ref, entry.kind);
    }
    return m;
  }
  root.VaultCrypto = Object.freeze({ VERSION, ITERATIONS, LIMITS, id, bytes, encode, decode, json, parse, digest, gitSha, password, head, ref, record, manifest, path, create, unlock, encrypt, decrypt, recoverySecret });
})(globalThis);
