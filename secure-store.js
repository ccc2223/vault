/* Encrypted device storage. Nothing in this module authenticates cloud access. */
(function (root) {
  'use strict';
  const ITERATIONS = 600000;
  const AAD = new TextEncoder().encode('vault/local/v1');
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
    if (!Array.isArray(payload.notes) || payload.notes.some(n => typeof n.path !== 'string' || typeof n.content !== 'string')) {
      throw new Error('Saved vault has an invalid format. No data was changed.');
    }
    return payload;
  }

  class VaultStore {
    constructor() {
      this.db = null; this.key = null; this.header = null;
      this.records = new Map(); this.last = null; this.revision = 0;
      this.queue = Promise.resolve(); this.pending = 0; this.failure = null;
    }
    async open(onBlocked, onVersionChange) {
      const r = indexedDB.open('vault', 2);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('notes')) r.result.createObjectStore('notes', { keyPath: 'path' });
        if (!r.result.objectStoreNames.contains('sealed')) r.result.createObjectStore('sealed');
      };
      r.onblocked = () => onBlocked?.();
      this.db = await request(r);
      this.db.onversionchange = () => { this.db.close(); onVersionChange?.(); };
    }
    async read() {
      return request(this.db.transaction('sealed').objectStore('sealed').get('vault'));
    }
    async hasLegacy() {
      return (await request(this.db.transaction('notes').objectStore('notes').count())) > 0;
    }
    async legacy() {
      return request(this.db.transaction('notes').objectStore('notes').getAll());
    }
    async write(record, expected, clearLegacy = false) {
      // Read, compare, replace and legacy cleanup share one atomic IDB transaction.
      const tx = this.db.transaction(['sealed', 'notes'], 'readwrite');
      const done = complete(tx);
      const store = tx.objectStore('sealed');
      let conflict = false;
      const r = store.get('vault');
      r.onsuccess = () => {
        if ((r.result?.revision || 0) !== expected) { conflict = true; tx.abort(); return; }
        store.put(record, 'vault');
        if (clearLegacy) tx.objectStore('notes').clear();
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
      this.last = payload.last || null; this.failure = null;
      return true;
    }
    async initialize(password) {
      if (await this.read()) throw new Error('An encrypted vault already exists. Unlock it instead.');
      const records = await this.legacy();
      const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
      const key = await derive(password, salt);
      const payload = { notes: records, last: null };
      const sealed = await encrypt(key, payload);
      // Verify the exact encrypted payload before committing or deleting plaintext.
      const verified = await decrypt(key, sealed);
      if (JSON.stringify(verified) !== JSON.stringify(payload)) throw new Error('Encryption verification failed. Original notes were kept.');
      const header = { version: 1, salt, iterations: ITERATIONS };
      await this.write({ ...header, ...sealed, revision: 1 }, 0, true);
      this.key = key; this.header = header;
      this.records = new Map(records.map(n => [n.path, n])); this.last = null; this.failure = null;
    }
    async all() { if (!this.key) throw new Error('Vault is locked.'); return structuredClone([...this.records.values()]); }
    persist() {
      if (!this.key) return Promise.reject(new Error('Vault is locked.'));
      const key = this.key, header = { ...this.header };
      const payload = structuredClone({ notes: [...this.records.values()], last: this.last });
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
      await this.drain();
      const record = await this.read();
      // Verify the old password; never overwrite a vault on a failed recovery attempt.
      await decrypt(await derive(oldPassword, record.salt, record.iterations), record);
      const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
      const key = await derive(newPassword, salt);
      const payload = { notes: [...this.records.values()], last: this.last };
      const sealed = await encrypt(key, payload);
      if (JSON.stringify(await decrypt(key, sealed)) !== JSON.stringify(payload)) throw new Error('Encryption verification failed.');
      const header = { version: 1, salt, iterations: ITERATIONS };
      await this.write({ ...header, ...sealed, revision: this.revision + 1 }, this.revision);
      this.key = key; this.header = header;
    }
    forget() { this.key = null; this.header = null; this.records.clear(); this.last = null; this.failure = null; }
  }
  root.VaultStore = VaultStore;
})(globalThis);
