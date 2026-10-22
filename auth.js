/* One password unlocks a local key bundle. Only a random access secret reaches the Worker. */
'use strict';
const Auth = {
  store: new VaultStore(), active: false, epoch: 0, session: null, bundle: null, cloud: null,
  controller: new AbortController(), settings: {}, lastActivity: 0, preparing: false, setupToken: '',
  idleMs: 60 * 60 * 1000, timer: null, release: null, locking: null, lockFailed: false,
  critical: Promise.resolve(), channel: null, changing: false,
  message(id, text) { document.getElementById(id).textContent = text; },
  ensure(epoch = this.epoch) {
    if (!this.active || epoch !== this.epoch) throw new Error('Vault is locked.');
    if (!this.checkIdle()) throw new Error('Vault locked after one hour of inactivity.');
    return this.epoch;
  },
  checkIdle() {
    if (!this.active) return false;
    if (Date.now() - this.lastActivity >= this.idleMs) {
      void this.lock('Locked after one hour of inactivity.'); return false;
    }
    return true;
  },
  activity() {
    if (!this.checkIdle()) return;
    this.lastActivity = Date.now(); this.armTimer();
  },
  armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.checkIdle()) this.armTimer();
    }, Math.max(1, this.idleMs - (Date.now() - this.lastActivity)));
  },
  normalizeURL(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Enter your HTTPS sync server URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an HTTPS sync URL without credentials, a query or a fragment.');
    }
    return url.href.replace(/\/+$/, '');
  },
  async acquire() {
    if (!navigator.locks) throw new Error('This browser needs Web Locks support. Update your browser before using encrypted Vault.');
    if (this.release) return;
    await new Promise((resolve, reject) => {
      navigator.locks.request('vault-encrypted-editor', { ifAvailable: true }, async lease => {
        if (!lease) { reject(new Error('Vault is unlocked in another tab. Lock or close that tab, then try again.')); return; }
        await new Promise(release => { this.release = release; resolve(); });
      }).catch(reject);
    });
  },
  releaseLease() { this.release?.(); this.release = null; },
  async lock(message = 'Vault is locked. Enter your password to continue.', broadcast = true) {
    if (this.locking) return this.locking;
    const wasActive = this.active;
    const snapshot = wasActive ? this.app.snapshot() : null;
    this.active = false; this.epoch++; this.session = null;
    this.controller.abort(); clearTimeout(this.timer);
    document.body.dataset.locked = 'true'; this.app.clear();
    document.getElementById('unlock-submit').disabled = true;
    this.message('unlock-info', this.store.key ? 'Saving encrypted notes and locking…' : message);
    if (broadcast) {
      this.channel?.postMessage('lock');
      try { localStorage.setItem('vault.lock', String(Date.now()) + ':' + crypto.randomUUID()); } catch {}
    }
    this.locking = (async () => {
      try {
        await this.critical.catch(() => {});
        if (snapshot) {
          this.store.records = new Map(snapshot.notes.map(note => [note.path, note]));
          this.store.files = new Map(snapshot.files.map(file => [file.path, file]));
          this.store.last = snapshot.last; this.store.history = snapshot.history;
        }
        if (this.store.key) { await this.store.persist(); await this.store.drain(); }
        this.cloud?.cache.clear(); this.cloud = null; this.bundle = null; this.preparing = false; this.changing = false;
        this.store.forget(); this.releaseLease(); this.lockFailed = false;
        document.getElementById('retry-lock').hidden = true;
        this.message('unlock-error', ''); this.message('unlock-info', message);
      } catch (error) {
        // Keep the last unsaved copy behind the lock screen instead of losing it.
        this.lockFailed = true;
        this.message('unlock-error', 'Could not save the last edits: ' + error.message +
          ' Keep this tab open and retry. Notes are hidden, but locking cannot finish until the save succeeds.');
        document.getElementById('retry-lock').hidden = false;
      } finally {
        this.locking = null;
        document.getElementById('unlock-submit').disabled = this.lockFailed;
      }
    })();
    return this.locking;
  },
  async request(path, options = {}) {
    const epoch = this.epoch, { json, public: publicRequest = false, ...init } = options;
    if (!publicRequest && !this.active && !this.preparing) throw new Error('Vault is locked.');
    if (!publicRequest && this.active) this.ensure();
    const headers = { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers };
    if (!publicRequest) {
      if (this.session && this.session.exp > Date.now()) headers.Authorization = 'Bearer ' + this.session.session;
      else if (this.setupToken) headers.Authorization = 'Setup ' + this.setupToken;
      else { this.session = null; throw new Error('Sync session expired. Sign in again in Settings.'); }
    }
    const response = await fetch(this.settings.url + path, { ...init, headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}), cache: 'no-store',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]) });
    if (epoch !== this.epoch || this.controller.signal.aborted) throw new DOMException('Vault request cancelled.', 'AbortError');
    const value = await response.json();
    if (epoch !== this.epoch) throw new DOMException('Vault request cancelled.', 'AbortError');
    if (!response.ok) {
      if (response.status === 401) this.session = null;
      const error = new Error(value.message || 'Encrypted sync failed (' + response.status + ').'); error.status = response.status; throw error;
    }
    return value;
  },
  remember() { localStorage.setItem('vault.e2ee.settings', JSON.stringify(this.settings)); },
  async openStore(vaultId) {
    if (this.store.db) {
      if (this.settings.vaultId !== vaultId) throw new Error('This device has saved data for a different vault. Use a separate browser profile.');
      return;
    }
    await this.store.open(
      () => this.message('unlock-info', 'Close other Vault windows to finish opening secure storage.'),
      () => { void this.lock('Vault changed in another window. Reload this page.'); }, vaultId);
    this.settings.vaultId = vaultId; this.remember();
  },
  async login(bundle) {
    const epoch = this.epoch;
    const data = await this.request('/login', { method: 'POST', public: true, json: { accessSecret: bundle.accessSecret } });
    if (epoch !== this.epoch || typeof data.session !== 'string' || !Number.isFinite(data.exp) || data.exp <= Date.now() || data.exp > Date.now() + 8 * 3600000) throw new Error('Invalid cloud session.');
    this.session = data; return data;
  },
  client(bundle = this.bundle, checkpoint = this.store.cloud?.checkpoint) {
    return new CloudVault((path, options) => this.request(path, options), bundle, checkpoint || null);
  },
  async start(app, defaultURL) {
    this.app = app;
    try { this.settings = JSON.parse(localStorage.getItem('vault.e2ee.settings') || 'null') || { url: defaultURL }; } catch { this.settings = { url: defaultURL }; }
    const fragment = new URLSearchParams(location.hash.slice(1));
    this.setupToken = /^[A-Za-z0-9_-]{43}$/.test(fragment.get('setup') || '') ? fragment.get('setup') : '';
    if (fragment.has('setup')) {
      if (fragment.get('server')) this.settings.url = this.normalizeURL(fragment.get('server'));
      history.replaceState(null, '', location.pathname + location.search);
    }
    this.settings.url = this.normalizeURL(this.settings.url || defaultURL);
    document.getElementById('unlock-url').value = this.settings.url;
    document.getElementById('unlock-form').onsubmit = event => { event.preventDefault(); void this.unlock(); };
    document.getElementById('retry-lock').onclick = () => this.lock();
    document.getElementById('recover-open').onclick = () => document.getElementById('dlg-recover').showModal();
    document.getElementById('recover-cancel').onclick = () => document.getElementById('dlg-recover').close();
    document.getElementById('recover-submit').onclick = () => { void this.recover(); };
    document.getElementById('dlg-recover').addEventListener('close', () => {
      document.getElementById('recovery-input').value = ''; document.getElementById('recovery-password').value = '';
    });
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vault-e2ee-lock-v1') : null;
    if (this.channel) this.channel.onmessage = event => { if (event.data === 'lock') void this.lock('Locked from another tab.', false); };
    window.addEventListener('storage', event => { if (event.key === 'vault.lock' && event.newValue) void this.lock('Locked from another tab.', false); });
    for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) document.addEventListener(type, event => {
      if (this.active && !this.checkIdle()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (this.active && event.isTrusted) this.activity();
    }, { capture: true, passive: false });
    for (const type of ['focus', 'pageshow']) window.addEventListener(type, () => this.checkIdle());
    window.addEventListener('pagehide', () => { void this.lock('Enter your password to reopen Vault.'); });
    try {
      if (!crypto.subtle || !navigator.locks) throw new Error('Vault requires HTTPS and a current browser with Web Crypto and Web Locks.');
      if (this.settings.vaultId) await this.openStore(this.settings.vaultId);
      const saved = this.store.db && await this.store.read();
      this.message('unlock-info', saved ? 'Enter your vault password. Saved notes also work offline.' : this.setupToken ? 'Create a vault password of 15–256 characters.' : 'Enter your vault password to connect this device.');
      document.getElementById('setup-confirm-row').hidden = !this.setupToken;
      document.getElementById('unlock-submit').disabled = false;
    } catch (error) { this.message('unlock-error', error.message); }
    if ('serviceWorker' in navigator) {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.addEventListener('controllerchange', () => { if (!this.active && !this.preparing) location.reload(); });
      navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
    }
  },
  async confirmRecovery(key) {
    const dialog = document.getElementById('dlg-recovery-key'), input = document.getElementById('recovery-confirm');
    document.getElementById('recovery-key').value = key; input.value = '';
    const signal = this.controller.signal;
    if (signal.aborted) throw new Error('Recovery key confirmation cancelled.');
    return new Promise((resolve, reject) => {
      let accepted = false;
      const abort = () => { dialog.close(); };
      const close = () => {
        signal.removeEventListener('abort', abort); dialog.removeEventListener('close', close);
        document.getElementById('recovery-key').value = ''; input.value = '';
        document.getElementById('recovery-download').onclick = document.getElementById('recovery-confirm-save').onclick = null;
        accepted && !signal.aborted ? resolve() : reject(new Error('Recovery key confirmation cancelled.'));
      };
      document.getElementById('recovery-download').onclick = () => {
        const url = URL.createObjectURL(new Blob([key + '\n'], { type: 'text/plain' }));
        const a = document.createElement('a'); a.href = url; a.download = 'vault-recovery-key.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      document.getElementById('recovery-confirm-save').onclick = () => {
        if (input.value.trim() !== key) { document.getElementById('recovery-key-error').textContent = 'Re-enter the full recovery key to confirm you saved it.'; return; }
        accepted = true; dialog.close();
      };
      document.getElementById('recovery-key-error').textContent = '';
      dialog.addEventListener('close', close); signal.addEventListener('abort', abort, { once: true });
      dialog.showModal();
    });
  },
  async unlock() {
    if (this.active || this.preparing || this.locking || this.lockFailed) return;
    const button = document.getElementById('unlock-submit'), input = document.getElementById('unlock-password');
    let password = input.value; input.value = ''; button.disabled = true;
    this.preparing = true; const attempt = ++this.epoch;
    this.controller.abort(); this.controller = new AbortController();
    this.message('unlock-error', ''); this.message('unlock-info', 'Unlocking encrypted vault…');
    try {
      VaultCrypto.password(password); await this.acquire();
      const url = this.normalizeURL(document.getElementById('unlock-url').value.trim());
      if (this.store.db && url !== this.settings.url) throw new Error('Use Sync settings to reconnect an existing device.');
      this.settings.url = url;
      let warning = '';
      const existing = this.store.db && await this.store.read();
      if (existing) {
        this.critical = this.store.unlock(password); await this.critical;
        if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
        if (this.store.rotation) { this.critical = this.finishRotation(); await this.critical; }
        this.bundle = this.store.cloud?.bundle;
        if (!this.bundle) throw new Error('Encrypted device credentials are missing.');
        this.cloud = this.client();
        try { await this.login(this.bundle); } catch (e) { warning = 'Saved notes unlocked. Cloud sync unavailable: ' + e.message; }
      } else {
        const remote = await this.request('/vault/bootstrap', { public: true });
        if (!remote.head) {
          if (!this.setupToken) throw new Error('Open the setup link from the provisioning command to create this vault.');
          if (password !== document.getElementById('unlock-confirm').value) throw new Error('The new passwords do not match.');
          const generated = await VaultCrypto.create(password);
          await this.confirmRecovery(generated.recoveryKey);
          this.bundle = generated.bundle; this.cloud = this.client(this.bundle, null);
          const checkpoint = await this.cloud.publish({ head: generated.head, sha: null }, [], { setup: true });
          if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
          await this.openStore(this.bundle.vaultId);
          this.critical = this.store.initialize(password, { bundle: this.bundle, checkpoint }); await this.critical;
          this.setupToken = '';
        } else {
          this.bundle = await VaultCrypto.unlock(remote.head, password);
          await this.openStore(this.bundle.vaultId); await this.login(this.bundle);
          this.cloud = this.client(this.bundle, null); const checkpoint = await this.cloud.load();
          this.critical = this.store.initialize(password, { bundle: this.bundle, checkpoint }); await this.critical;
        }
        if (!this.session) await this.login(this.bundle);
      }
      if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
      this.remember(); password = ''; document.getElementById('unlock-confirm').value = '';
      this.active = true; this.lastActivity = Date.now(); this.armTimer(); document.body.dataset.locked = 'false';
      await this.app.open(); if (warning) document.getElementById('status').textContent = warning;
      this.message('unlock-info', '');
    } catch (error) {
      if (this.active) await this.lock('Opening failed. Your encrypted notes were kept.');
      else if (!this.locking) { this.store.forget(); this.bundle = null; this.cloud = null; this.session = null; this.releaseLease(); }
      this.message('unlock-error', error.message);
    } finally { password = ''; this.preparing = false; button.disabled = this.lockFailed; }
  },
  async connect(value, ignoredBranch, password) {
    const epoch = this.ensure(); VaultCrypto.password(password);
    if (this.changing) throw new Error('A credential update is already running.');
    const url = this.normalizeURL(value);
    if (url !== this.settings.url) throw new Error('Changing sync servers requires a separate browser profile.');
    this.changing = true;
    const previous = this.store.cloud, previousSession = this.session, salt = this.store.header.salt;
    try {
      await this.app.waitSync(); await this.app.flush(); this.ensure(epoch);
      const remote = await this.request('/vault/bootstrap', { public: true });
      const bundle = await VaultCrypto.unlock(remote.head, password); this.ensure(epoch);
      if (bundle.vaultId !== this.bundle.vaultId) throw new Error('The server contains a different vault.');
      await this.login(bundle); this.ensure(epoch);
      this.critical = (async () => {
        this.store.cloud = { ...previous, bundle };
        try { await this.store.rekey(null, password); }
        catch (error) { if (this.store.header.salt === salt) this.store.cloud = previous; throw error; }
      })();
      await this.critical; this.ensure(epoch); this.bundle = bundle; this.cloud?.cache.clear(); this.cloud = this.client();
    } catch (error) {
      if (this.store.header?.salt === salt && this.active) this.session = previousSession;
      throw error;
    } finally { this.changing = false; }
  },
  async finishRotation() {
    const pending = this.store.rotation;
    if (!pending) return;
    const old = this.store.cloud.bundle, next = pending.generated.bundle;
    const remote = await this.request('/vault/bootstrap', { public: true });
    let checkpoint;
    if (remote.head?.vaultId !== next.vaultId) throw new Error('Rotation belongs to a different vault.');
    if (remote.head.epoch === next.epoch && remote.head.authDigest === pending.generated.head.authDigest) {
      await this.login(next); checkpoint = await this.client(next, null).load();
    } else if (remote.head.epoch === old.epoch && remote.head.authDigest === pending.base.head.authDigest) {
      await this.login(old);
      const client = this.client(old, this.store.cloud.checkpoint);
      for (let attempt = 0; attempt < 3; attempt++) {
        const base = await client.load();
        if (base.sha !== pending.base.sha) {
          pending.base = base; pending.prepared = await client.prepareRotation(base, pending.generated);
          await this.store.persist();
        }
        try { checkpoint = await client.publishPrepared(pending.base, pending.prepared); break; }
        catch (e) { if (e.status !== 409 || attempt === 2) throw e; }
      }
      await this.login(next);
    } else throw new Error('Vault changed during password rotation. Encrypted local state was kept.');
    this.store.cloud = { bundle: next, checkpoint }; this.store.rotation = null;
    await this.store.persist(); await this.store.drain(); this.bundle = next; this.cloud?.cache.clear(); this.cloud = this.client();
  },
  async changePassword(oldPassword, newPassword) {
    const epoch = this.ensure(); VaultCrypto.password(newPassword);
    if (!oldPassword) throw new Error('Enter the current password.');
    const local = await this.store.read();
    // Verify current local password before preparing any remote writes.
    const probe = new VaultStore(); probe.db = this.store.db;
    await probe.unlock(oldPassword); probe.forget(); this.ensure(epoch);
    if (this.changing) throw new Error('A credential update is already running.');
    if (!this.session || this.session.exp <= Date.now()) await this.login(this.bundle);
    await this.app.sync({ strict: true }); await this.app.flush(); this.ensure(epoch);
    const generated = await VaultCrypto.create(newPassword, { vaultId: this.bundle.vaultId, epoch: this.bundle.epoch + 1 });
    await this.confirmRecovery(generated.recoveryKey); this.ensure(epoch);
    this.changing = true;
    await this.app.waitSync(); this.ensure(epoch);
    this.critical = (async () => {
      const base = await this.cloud.load(), prepared = await this.cloud.prepareRotation(base, generated);
      this.ensure(epoch);
      this.store.rotation = { base, prepared, generated: { head: generated.head, bundle: generated.bundle } };
      try { await this.store.rekey(oldPassword, newPassword); }
      catch (error) {
        // A failed atomic local rekey must never journal the new master under the old password.
        if (this.store.header?.salt === local.salt) this.store.rotation = null;
        throw error;
      }
      await this.finishRotation();
    })();
    try { await this.critical; this.ensure(epoch); }
    catch (e) {
      const changed = this.store.header?.salt !== local.salt;
      await this.lock(changed ? 'Password rotation is pending. Unlock with the NEW password to resume.' : 'Password change did not finish. Unlock with the current password.');
      throw new Error(changed ? 'Use the new password on this device to resume the pending rotation.' : e.message);
    } finally { this.changing = false; }
  },
  async recover() {
    const button = document.getElementById('recover-submit'); button.disabled = true;
    let attempt;
    let recovery = document.getElementById('recovery-input').value, password = document.getElementById('recovery-password').value;
    try {
      if (this.active || this.preparing || this.locking) throw new Error('Lock Vault before recovery.');
      VaultCrypto.password(password);
      if (this.store.db && await this.store.read()) throw new Error('This profile has saved local notes. Use a fresh browser profile for recovery; keep this copy for any unsynced drafts.');
      this.settings.url = this.normalizeURL(document.getElementById('unlock-url').value.trim());
      this.preparing = true; attempt = ++this.epoch;
      this.controller.abort(); this.controller = new AbortController(); await this.acquire();
      const remote = await this.request('/vault/bootstrap', { public: true });
      const old = await VaultCrypto.unlock(remote.head, recovery, true); recovery = '';
      await this.login(old); const client = this.client(old, null), base = await client.load();
      const generated = await VaultCrypto.create(password, { vaultId: old.vaultId, epoch: old.epoch + 1 });
      if (attempt !== this.epoch) throw new Error('Recovery cancelled.');
      document.getElementById('dlg-recover').close(); await this.confirmRecovery(generated.recoveryKey);
      const prepared = await client.prepareRotation(base, generated);
      await this.openStore(old.vaultId);
      if (attempt !== this.epoch) throw new Error('Recovery cancelled.');
      this.critical = (async () => {
        await this.store.initialize(password, { bundle: old, checkpoint: base }); this.remember();
        this.store.rotation = { base, prepared, generated: { head: generated.head, bundle: generated.bundle } };
        await this.store.persist(); await this.finishRotation();
      })();
      await this.critical;
      if (attempt !== this.epoch) throw new Error('Recovery cancelled.');
      this.remember();
      this.active = true; this.lastActivity = Date.now(); this.armTimer(); document.body.dataset.locked = 'false'; await this.app.open();
    } catch (e) {
      this.message('unlock-error', e.message);
      if (this.store.rotation) this.message('unlock-info', 'Recovery is pending. Unlock with your new password to resume.');
      if (this.active) await this.lock('Recovery did not finish. Encrypted local state was kept.');
      else if (!this.locking) { this.session = null; this.bundle = null; this.cloud = null; this.store.forget(); this.releaseLease(); }
    } finally { recovery = ''; password = ''; this.preparing = false; button.disabled = false; }
  }
};
