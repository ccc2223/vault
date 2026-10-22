/* Ciphertext-only remote adapter. Its caller owns decrypted editor state. */
(function (root) {
  'use strict';
  const C = root.VaultCrypto;
  class CloudVault {
    constructor(request, bundle, checkpoint = null) {
      this.request = request; this.bundle = bundle; this.checkpoint = checkpoint; this.cache = new Map();
    }
    async read(ref, bundle = this.bundle) {
      C.ref(ref, ref.kind);
      const key = [bundle.epoch, ref.kind, ref.objectId, ref.revisionId, ref.sha].join(':');
      if (!this.cache.has(key)) {
        const { record, sha } = await this.request('/vault/objects/' + ref.objectId + '/' + ref.revisionId);
        if (sha !== ref.sha || await C.gitSha(record) !== ref.sha) throw new Error('Encrypted object hash does not match.');
        const data = await C.decrypt(bundle, record, ref);
        if (ref.kind === 'file') return data;
        this.cache.set(key, data);
      }
      return this.cache.get(key).slice();
    }
    async load() {
      const current = await this.request('/vault/head'); C.head(current.head);
      const h = current.head, old = this.checkpoint;
      if (h.vaultId !== this.bundle.vaultId) throw new Error('This device belongs to a different vault.');
      if (h.epoch !== this.bundle.epoch || h.authDigest !== await C.digest(C.decode(this.bundle.accessSecret))) throw new Error('Vault password changed. Sign in again in Settings.');
      if (old && (h.generation < old.head.generation || h.generation === old.head.generation && current.sha !== old.sha)) throw new Error('Vault rollback or conflicting checkpoint detected. Local edits were kept.');
      const manifest = C.manifest(C.parse(await this.read(h.manifest)), h);
      if (old?.manifest) {
        const present = new Set(manifest.entries.map(e => e.kind + ':' + e.path));
        for (const e of old.manifest.entries) if (!present.has(e.kind + ':' + e.path)) throw new Error('A checkpoint omitted a known record. Local edits were kept.');
      }
      return { head: h, sha: current.sha, manifest };
    }
    async upload(kind, data, objectId, bundle = this.bundle) {
      const record = await C.encrypt(bundle, kind, data, objectId);
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await this.request('/vault/objects/' + record.objectId + '/' + record.revisionId, { method: 'PUT', json: record }); break; }
        catch (e) { if (e.status === 401 || e.status === 400 || e.status === 413 || attempt === 2) throw e; }
      }
      const ref = { kind, objectId: record.objectId, revisionId: record.revisionId, sha: result.sha };
      C.ref(ref, kind); if (await C.gitSha(record) !== ref.sha) throw new Error('Storage returned the wrong object hash.');
      return ref;
    }
    async prepare(base, entries, options = {}) {
      const bundle = options.bundle || this.bundle;
      const h = structuredClone(options.head || base.head);
      h.generation = base.head.generation + 1;
      const manifest = C.manifest({ version: 1, vaultId: h.vaultId, epoch: h.epoch, generation: h.generation, entries }, h);
      h.manifest = await this.upload('manifest', C.json(manifest), undefined, bundle); C.head(h);
      return { head: h, manifest };
    }
    async publishPrepared(base, prepared, options = {}) {
      const h = prepared.head;
      const payload = { expectedHeadSha: base.sha, head: h };
      let result;
      try { result = await this.request(options.setup ? '/vault/setup' : '/vault/commit', { method: 'POST', json: payload }); }
      catch (e) {
        // A timed-out response may have committed. Resolve it before generating another revision.
        if (e.status === 409 || e.name === 'AbortError') throw e;
        try {
          const actual = await this.request('/vault/bootstrap', { public: true });
          if (JSON.stringify(actual.head) === JSON.stringify(h)) result = actual;
        } catch {}
        if (!result) throw e;
      }
      if (JSON.stringify(result.head) !== JSON.stringify(h) || !/^[0-9a-f]{40}$/.test(result.sha)) throw new Error('Storage returned an unexpected checkpoint.');
      const checkpoint = { head: h, sha: result.sha, manifest: prepared.manifest };
      this.checkpoint = checkpoint; return checkpoint;
    }
    async publish(base, entries, options = {}) {
      return this.publishPrepared(base, await this.prepare(base, entries, options), options);
    }
    async prepareRotation(base, generated) {
      const entries = [];
      for (const e of base.manifest.entries) {
        const data = e.deleted ? new Uint8Array() : await this.read(e.ref);
        const ref = await this.upload(e.kind, data, e.ref.objectId, generated.bundle);
        entries.push({ ...e, ref });
      }
      return this.prepare(base, entries, { head: generated.head, bundle: generated.bundle });
    }
  }
  root.CloudVault = CloudVault;
})(globalThis);
