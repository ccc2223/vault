/* Password unlock, memory-only cloud sessions and coordinated device locking. */
'use strict';
const Auth = {
  store: new VaultStore(), active: false, epoch: 0, session: null,
  controller: new AbortController(), settings: {}, lastActivity: 0,
  idleMs: 60 * 60 * 1000, timer: null, release: null, locking: null,
  lockFailed: false, critical: Promise.resolve(), channel: null,
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
  remember(url, branch = 'main') {
    this.settings = { url, branch: branch.trim() || 'main' };
    localStorage.setItem('vault.settings', JSON.stringify(this.settings));
  },
  async login(url, password, signal) {
    const result = await fetch(url + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ password }), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok || !data.session) throw new Error(data.message || 'Could not sign in (' + result.status + ').');
    // Older Workers issue longer sessions. Enforce an eight-hour ceiling in the app too.
    const exp = Math.min(Number(data.exp) || Number(data.session.split('.')[0]), Date.now() + 8 * 3600000);
    if (!Number.isFinite(exp) || exp <= Date.now()) throw new Error('The server returned an invalid session.');
    return { url, session: data.session, exp, branch: this.settings.branch || 'main' };
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
  async start(app, defaultURL) {
    this.app = app;
    // Retain only non-sensitive preferences from old versions; never reuse old credentials.
    try {
      const previous = JSON.parse(localStorage.getItem('vault.gh') || 'null');
      this.settings = JSON.parse(localStorage.getItem('vault.settings') || 'null') ||
        { url: previous?.url || localStorage.getItem('vault.url') || defaultURL, branch: previous?.branch || 'main' };
      localStorage.setItem('vault.settings', JSON.stringify(this.settings));
      for (const key of ['vault.gh', 'vault.last', 'vault.url']) localStorage.removeItem(key);
    } catch {
      for (const key of ['vault.gh', 'vault.last', 'vault.url']) localStorage.removeItem(key);
      this.settings = { url: defaultURL, branch: 'main' };
    }
    document.getElementById('unlock-url').value = this.settings.url || defaultURL || '';
    document.getElementById('unlock-form').onsubmit = event => { event.preventDefault(); void this.unlock(); };
    document.getElementById('retry-lock').onclick = () => this.lock('Locked. Your saved notes are encrypted.');
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vault-security-v3') : null;
    if (this.channel) this.channel.onmessage = event => {
      if (event.data === 'lock') void this.lock('Locked from another tab.', false);
    };
    window.addEventListener('storage', event => {
      if (event.key === 'vault.lock' && event.newValue) void this.lock('Locked from another tab.', false);
    });
    for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
      document.addEventListener(type, event => {
        if (this.active && !this.checkIdle()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
        if (this.active && event.isTrusted) this.activity();
      }, { capture: true, passive: false });
    }
    window.addEventListener('focus', () => this.checkIdle());
    window.addEventListener('pageshow', () => this.checkIdle());
    window.addEventListener('pagehide', () => { void this.lock('Enter your password to reopen Vault.'); });
    try {
      if (!crypto.subtle) throw new Error('Vault requires a secure HTTPS browser context.');
      await this.store.open(
        () => this.message('unlock-info', 'Close all older Vault tabs or installed windows on this device to finish the security upgrade.'),
        () => { void this.lock('Vault was updated in another tab. Reload this page.'); }
      );
      const record = await this.store.read();
      const legacy = await this.store.hasLegacy();
      this.message('unlock-info', record ? 'Enter your local password. Saved notes can also be unlocked offline.' :
        legacy ? 'Sign in to encrypt your existing notes, including unsynced edits. Keep this tab open until the upgrade finishes.' :
          'Enter your Cloudflare Worker URL and password to connect this device.');
      document.getElementById('unlock-submit').disabled = false;
    } catch (error) { this.message('unlock-error', error.message); }
    if ('serviceWorker' in navigator) {
      // A new version takes over while this page still runs the old code; reload while still locked.
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (!this.active) location.reload(); });
      }
      navigator.serviceWorker.register('sw.js').then(registration => registration.update()).catch(() => {});
    }
  },
  async unlock() {
    if (this.active || this.lockFailed || this.locking) return;
    const button = document.getElementById('unlock-submit'); button.disabled = true;
    const input = document.getElementById('unlock-password');
    let password = input.value; input.value = '';
    this.message('unlock-error', ''); this.message('unlock-info', 'Unlocking…');
    const attempt = ++this.epoch;
    this.controller.abort(); this.controller = new AbortController();
    try {
      if (!password) throw new Error('Enter your password.');
      await this.acquire();
      if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
      let url = document.getElementById('unlock-url').value.trim();
      if (url) url = this.normalizeURL(url);
      this.critical = this.store.unlock(password);
      const existed = await this.critical;
      if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
      let warning = '';
      try {
        if (!url) throw new Error('Enter your HTTPS sync server URL.');
        const session = await this.login(url, password, this.controller.signal);
        if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
        this.session = session;
      } catch (error) {
        if (!existed || attempt !== this.epoch) throw error;
        warning = 'Saved notes unlocked. Cloud sync is unavailable: ' + error.message;
        this.session = null;
      }
      if (!existed) {
        this.critical = this.store.initialize(password);
        await this.critical;
      }
      password = '';
      if (attempt !== this.epoch) throw new Error('Unlock cancelled.');
      this.remember(url, this.settings.branch);
      this.active = true; this.lastActivity = Date.now(); this.armTimer();
      document.body.dataset.locked = 'false';
      document.getElementById('unlock-password').value = '';
      await this.app.open();
      if (warning) document.getElementById('status').textContent = warning;
      this.message('unlock-info', '');
    } catch (error) {
      if (this.active) await this.lock('Could not finish opening Vault. Your saved notes were kept.');
      else if (!this.locking) { this.store.forget(); this.session = null; this.releaseLease(); }
      this.message('unlock-error', error.message);
    } finally { password = ''; button.disabled = this.lockFailed; }
  },
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
          this.store.last = snapshot.last;
        }
        if (this.store.key) { await this.store.persist(); await this.store.drain(); }
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
  async connect(value, branch, password) {
    const epoch = this.ensure();
    if (!password) throw new Error('Enter your Cloudflare password to sign in again.');
    const url = this.normalizeURL(value);
    const session = await this.login(url, password, this.controller.signal);
    this.ensure(epoch);
    this.remember(url, branch); this.session = { ...session, branch: this.settings.branch };
  },
  async changePassword(oldPassword, newPassword) {
    const epoch = this.ensure();
    if (!oldPassword || !newPassword) throw new Error('Enter both the old local password and the new Cloudflare password.');
    const session = await this.login(this.settings.url, newPassword, this.controller.signal);
    this.ensure(epoch);
    // No sync or user editing may race re-encryption. The native dialog blocks editing.
    this.controller.abort(); this.controller = new AbortController(); this.epoch++;
    const current = this.epoch;
    this.critical = (async () => {
      await this.app.flush();
      this.ensure(current);
      await this.store.rekey(oldPassword, newPassword);
    })();
    try {
      await this.critical; this.ensure(current); this.session = session;
    } catch (error) {
      this.ensure(current);
      throw new Error('Password update failed. Your existing encrypted notes were kept. Check the old local password.');
    }
  }
};
