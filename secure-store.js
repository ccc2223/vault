/* Encrypted device storage. Nothing in this module authenticates cloud access. */
(function (root) {
  'use strict';
  const ITERATIONS = 600000;
  const AAD = new TextEncoder().encode('vault/local/v1');
  // Attachment bytes are encrypted one record per file, bound to their random id.
  const fileAAD = id => new TextEncoder().encode('vault/file/v1\n' + id);
  // Earlier versions of notes and deleted notes, one record per version, listed in the sealed vault's history.
  const versionAAD = id => new TextEncoder().encode('vault/version/v1\n' + id);
  const encode = bytes => {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const complete = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Storage transaction interrupted.'));
  });
  async function derive(password, salt, iterations = ITERATIONS) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: decode(salt), iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key,
      new TextEncoder().encode(JSON.stringify(data)));
    return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
  }
  async function decrypt(key, record) {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.iv), additionalData: AAD },
      key, decode(record.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(data));
    if (!Array.isArray(payload.notes) || payload.notes.some(n => typeof n.path !== 'string' || typeof n.content !== 'string') ||
      (payload.files != null && (!Array.isArray(payload.files) || payload.files.some(f => typeof f.path !== 'string' || typeof f.id !== 'string')))) {
      throw new Error('Saved vault has an invalid format. No data was changed.');
    }
    return payload;
  }

  class VaultStore {
    constructor() {
      this.db = null; this.key = null; this.header = null; this.cloud = null; this.rotation = null;
      this.records = new Map(); this.files = new Map(); this.history = []; this.last = null; this.revision = 0;
      this.queue = Promise.resolve(); this.pending = 0; this.failure = null;
    }
    async open(onBlocked, onVersionChange, vaultId) {
      if (!/^[0-9a-f-]{36}$/.test(vaultId || '')) throw new Error('A vault identity is required.');
      const r = indexedDB.open('vault-e2ee-v1:' + vaultId, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('sealed')) r.result.createObjectStore('sealed');
        // Encrypted attachment bytes keyed by random id; their names and paths live in the sealed vault.
        if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
        if (!r.result.objectStoreNames.contains('versions')) r.result.createObjectStore('versions');
      };
      r.onblocked = () => onBlocked?.();
      this.db = await request(r);
      this.db.onversionchange = () => { this.db.close(); onVersionChange?.(); };
    }
    async read() {
      return request(this.db.transaction('sealed').objectStore('sealed').get('vault'));
    }
    async write(record, expected, files = null, versions = null) {
      // Compare, replace and re-encrypt related bytes in one atomic IDB transaction.
      const tx = this.db.transaction(['sealed', 'files', 'versions'], 'readwrite');
      const done = complete(tx);
      const store = tx.objectStore('sealed');
      let conflict = false;
      const r = store.get('vault');
      r.onsuccess = () => {
        if ((r.result?.revision || 0) !== expected) { conflict = true; tx.abort(); return; }
        store.put(record, 'vault');
        if (files) for (const [id, sealed] of files) tx.objectStore('files').put(sealed, id);
        if (versions) for (const [id, sealed] of versions) tx.objectStore('versions').put(sealed, id);
      };
      try { await done; }
      catch (error) {
        if (conflict) throw new Error('Vault changed in another tab. Lock and reopen this tab before editing.');
        throw error;
      }
      this.revision = record.revision;
    }
    async unlock(password) {
      const record = await this.read();
      if (!record) return false;
      if (record.version !== 1 || record.iterations !== ITERATIONS) throw new Error('Unsupported vault format. Update Vault before unlocking.');
      const key = await derive(password, record.salt, record.iterations);
      let payload;
      try { payload = await decrypt(key, record); }
      catch { throw new Error('Could not unlock saved notes. Check the password; saved data has not been changed.'); }
      this.key = key; this.header = { version: 1, salt: record.salt, iterations: record.iterations };
      this.revision = record.revision; this.records = new Map(payload.notes.map(n => [n.path, n]));
      this.files = new Map((payload.files || []).map(f => [f.path, f]));
      this.history = Array.isArray(payload.history) ? payload.history.filter(v => typeof v?.id === 'string' && typeof v.path === 'string') : [];
      this.last = payload.last || null; this.cloud = payload.cloud || null; this.rotation = payload.rotation || null; this.failure = null;
      await this.sweep().catch(() => {});
      return true;
    }
    async initialize(password, cloud) {
      if (await this.read()) throw new Error('An encrypted vault already exists. Unlock it instead.');
      const records = [];
      const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
      const key = await derive(password, salt);
      const payload = { notes: records, files: [], history: [], last: null, cloud, rotation: null };
      const sealed = await encrypt(key, payload);
      // Verify the exact encrypted payload before committing.
      const verified = await decrypt(key, sealed);
      if (JSON.stringify(verified) !== JSON.stringify(payload)) throw new Error('Encryption verification failed.');
      const header = { version: 1, salt, iterations: ITERATIONS };
      await this.write({ ...header, ...sealed, revision: 1 }, 0);
      this.key = key; this.header = header;
      this.cloud = structuredClone(cloud); this.rotation = null;
      this.records = new Map(records.map(n => [n.path, n])); this.files = new Map(); this.history = []; this.last = null; this.failure = null;
    }
    async all() { if (!this.key) throw new Error('Vault is locked.'); return structuredClone([...this.records.values()]); }
    async allFiles() { if (!this.key) throw new Error('Vault is locked.'); return structuredClone([...this.files.values()]); }
    async seal(name, aad, bytes) {
      if (!this.key) throw new Error('Vault is locked.');
      const key = this.key, id = crypto.randomUUID();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, key, bytes);
      if (this.key !== key) throw new Error('Vault is locked.');
      const tx = this.db.transaction(name, 'readwrite');
      tx.objectStore(name).put({ iv, data }, id);
      await complete(tx);
      return id;
    }
    async unseal(name, aad, id, missing) {
      if (!this.key) throw new Error('Vault is locked.');
      const key = this.key;
      const record = await request(this.db.transaction(name).objectStore(name).get(id));
      if (!record) throw new Error(missing);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad(id) }, key, record.data));
    }
    putFile(bytes) { return this.seal('files', fileAAD, bytes); }
    getFile(id) { return this.unseal('files', fileAAD, id, 'Attachment is missing from this device.'); }
    putVersion(text) { return this.seal('versions', versionAAD, new TextEncoder().encode(text)); }
    async getVersion(id) { return new TextDecoder().decode(await this.unseal('versions', versionAAD, id, 'That version is missing from this device.')); }
    // Remove attachment and version bytes the sealed vault no longer references (replaced, pruned, or written
    // before an interrupted save).
    async sweep() {
      const used = new Set([...this.files.values(), ...this.history].map(f => f.id));
      const tx = this.db.transaction(['files', 'versions'], 'readwrite');
      for (const name of ['files', 'versions']) {
        const store = tx.objectStore(name), keys = await request(store.getAllKeys());
        for (const id of keys) if (!used.has(id)) store.delete(id);
      }
      await complete(tx);
    }
    persist() {
      if (!this.key) return Promise.reject(new Error('Vault is locked.'));
      const key = this.key, header = { ...this.header };
      const payload = structuredClone({ notes: [...this.records.values()], files: [...this.files.values()], history: this.history, last: this.last, cloud: this.cloud, rotation: this.rotation });
      this.pending++;
      const task = this.queue.then(async () => {
        const sealed = await encrypt(key, payload);
        await this.write({ ...header, ...sealed, revision: this.revision + 1 }, this.revision);
        this.failure = null;
      });
      this.queue = task.catch(error => { this.failure = error; }).finally(() => { this.pending--; });
      return task;
    }
    put(note) {
      if (!this.key) return Promise.reject(new Error('Vault is locked.'));
      this.records.set(note.path, structuredClone(note)); return this.persist();
    }
    del(path) {
      if (!this.key) return Promise.reject(new Error('Vault is locked.'));
      this.records.delete(path); return this.persist();
    }
    async drain() { await this.queue; if (this.failure) throw this.failure; }
    async rekey(oldPassword, newPassword) {
      if (!this.key) throw new Error('Vault is locked.');
      await this.drain();
      const record = await this.read();
      // Verify the old password; never overwrite a vault on a failed recovery attempt.
      if (oldPassword !== null) await decrypt(await derive(oldPassword, record.salt, record.iterations), record);
      const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
      const key = await derive(newPassword, salt);
      const payload = { notes: [...this.records.values()], files: [...this.files.values()], history: this.history, last: this.last, cloud: this.cloud, rotation: this.rotation };
      const sealed = await encrypt(key, payload);
      if (JSON.stringify(await decrypt(key, sealed)) !== JSON.stringify(payload)) throw new Error('Encryption verification failed.');
      // Re-encrypt every attachment and version first, then commit them with the vault so both keys never mix.
      const reseal = async (id, aad, bytes) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        return [id, { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, key, bytes) }];
      };
      const files = [], versions = [];
      for (const f of payload.files) files.push(await reseal(f.id, fileAAD, await this.getFile(f.id)));
      for (const v of payload.history) {
        const bytes = await this.unseal('versions', versionAAD, v.id, 'A saved version is missing. Password change was cancelled.');
        versions.push(await reseal(v.id, versionAAD, bytes));
      }
      const header = { version: 1, salt, iterations: ITERATIONS };
      await this.write({ ...header, ...sealed, revision: this.revision + 1 }, this.revision, files, versions);
      this.key = key; this.header = header;
    }
    forget() { this.cloud = null; this.rotation = null; this.key = null; this.header = null; this.records.clear(); this.files.clear(); this.history = []; this.last = null; this.failure = null; }
  }
  root.VaultStore = VaultStore;
})(globalThis);

