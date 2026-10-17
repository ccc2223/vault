'use strict';
// Set this to your sync server (Cloudflare Worker) URL so new devices only need the password.
const SYNC_URL = 'https://vault-sync-01.chriscleven.workers.dev';
const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const baseName = p => p.replace(/^.*\//, '').replace(/\.md$/i, '');

/* ---------- encrypted device storage ---------- */
const DB = {
  async all() { const epoch = Auth.ensure(); const result = await Auth.store.all(); Auth.ensure(epoch); return result; },
  async put(note) { const epoch = Auth.ensure(); await Auth.store.put(note); Auth.ensure(epoch); },
  async del(path) { const epoch = Auth.ensure(); await Auth.store.del(path); Auth.ensure(epoch); },
  async replace() {
    const epoch = Auth.ensure();
    Auth.store.records = new Map([...notes].map(([path, note]) => [path, structuredClone(note)]));
    await Auth.store.persist(); Auth.ensure(epoch);
  }
};

/* ---------- state ---------- */
const notes = new Map();   // path -> {path, content, mtime, sha, dirty, deleted}
let cur = null;            // current path
let index = { byPath: new Map(), byBase: new Map() };

/* ---------- spaces ---------- */
// A space is a top-level folder listed in .vault/spaces.json. Main ('') holds every note outside those folders.
// Notes keep their full repository paths; the UI, links and search only see the current space.
const SPACES = '.vault/spaces.json';
let space = '';            // current space folder
let spaceList = [];        // [{folder, name, updated, removed?}], including removed entries
const topFolder = p => p.includes('/') ? p.slice(0, p.indexOf('/')) : null;
const activeSpaces = () => spaceList.filter(s => !s.removed);
const spaceName = folder => activeSpaces().find(s => s.folder === folder)?.name || 'Main';
function spaceOf(path) {
  const top = topFolder(path)?.toLowerCase();
  return (top && activeSpaces().find(s => s.folder && s.folder.toLowerCase() === top)?.folder) || '';
}
const rel = p => { const s = spaceOf(p); return s ? p.slice(s.length + 1) : p; };
const isNote = n => !n.deleted && n.path !== SPACES;
const live = () => [...notes.values()].filter(n => isNote(n) && spaceOf(n.path) === space);
function parseSpaces(text) {
  try {
    const list = JSON.parse(text).spaces;
    return Array.isArray(list) ? list.filter(s => typeof s?.folder === 'string' && typeof s.name === 'string') : [];
  } catch { return []; }
}
const spacesJSON = list => JSON.stringify({ version: 1, spaces: [...list].sort((a, b) => a.folder.localeCompare(b.folder)) }, null, 2) + '\n';
function loadSpaces() {
  const n = notes.get(SPACES);
  spaceList = n && !n.deleted ? parseSpaces(n.content) : [];
  if (!spaceList.some(s => s.folder === '')) spaceList.unshift({ folder: '', name: 'Main', updated: 0 });
  spaceList.forEach(s => { if (!s.folder) s.removed = false; });
}
// Space lists merge instead of conflicting: the most recent change to each space wins.
function mergeSpaces(local, remote) {
  const by = new Map();
  for (const s of [...parseSpaces(remote), ...parseSpaces(local)]) {
    const key = s.folder.toLowerCase(), old = by.get(key);
    if (!old || (s.updated || 0) >= (old.updated || 0)) by.set(key, s);
  }
  return spacesJSON([...by.values()]);
}

function rebuildIndex() {
  loadSpaces();
  index = { byPath: new Map(), byBase: new Map() };
  for (const n of live().sort((a, b) => a.path.length - b.path.length)) {
    index.byPath.set(rel(n.path).toLowerCase(), n.path);
    const b = baseName(n.path).toLowerCase();
    if (!index.byBase.has(b)) index.byBase.set(b, n.path);
  }
}
function resolve(target) {
  const t = target.trim().toLowerCase().replace(/\.md$/, '');
  if (t.includes('/')) return index.byPath.get(t + '.md') || index.byBase.get(t.replace(/^.*\//, '')) || null;
  return index.byBase.get(t) || null;
}

/* ---------- markdown ---------- */
marked.use({
  gfm: true, breaks: true,
  extensions: [{
    name: 'wikilink', level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), text: (m[2] || m[1]).trim() };
    },
    renderer(t) {
      const ok = resolve(t.target);
      return `<a class="wikilink${ok ? '' : ' missing'}" data-target="${esc(t.target)}">${esc(t.text)}</a>`;
    }
  }]
});
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
  }
});
function renderPreview() {
  const n = notes.get(cur);
  $('#pv').innerHTML = n ? DOMPurify.sanitize(marked.parse(n.content)) : '';
}

/* ---------- persistence ---------- */
let saveT = null, syncT = null;
function touch(n) {
  Auth.ensure();
  n.mtime = Date.now(); n.dirty = true;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    saveT = null;
    try {
      await DB.put(n);
      rebuildIndex(); renderBacklinks(); renderList();
      scheduleSync(15000);
    } catch (error) { if (Auth.active) setStatus('Could not save: ' + error.message, true); }
  }, 400);
}
async function flush() {
  clearTimeout(saveT); saveT = null;
  Auth.ensure();
  await DB.replace();
}

/* ---------- UI: list / search ---------- */
function snippet(content, tokens) {
  const low = content.toLowerCase();
  let i = -1;
  for (const t of tokens) { i = low.indexOf(t); if (i >= 0) break; }
  if (i < 0) return '';
  const s = content.slice(Math.max(0, i - 30), i + 90).replace(/\s+/g, ' ');
  let h = esc(s);
  for (const t of tokens) h = h.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  return h;
}
function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  let arr = live();
  const snips = new Map();
  if (tokens.length) {
    arr = arr.filter(n => {
      const hay = (rel(n.path) + '\n' + n.content).toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
    arr.sort((a, b) => {
      const sa = tokens.every(t => baseName(a.path).toLowerCase().includes(t)) ? 0 : 1;
      const sb = tokens.every(t => baseName(b.path).toLowerCase().includes(t)) ? 0 : 1;
      return sa - sb || b.mtime - a.mtime;
    });
    arr = arr.slice(0, 100);
    arr.forEach(n => snips.set(n.path, snippet(n.content, tokens)));
  } else {
    arr.sort((a, b) => a.path.localeCompare(b.path));
  }
  $('#list').innerHTML = arr.map(n => {
    const r = rel(n.path), folder = r.includes('/') ? r.replace(/\/[^/]*$/, '') : '';
    return `<div class="item${n.path === cur ? ' cur' : ''}" data-p="${esc(n.path)}">
      <div class="t">${esc(baseName(n.path))}${n.dirty ? ' •' : ''}</div>
      ${folder ? `<div class="f">${esc(folder)}</div>` : ''}
      ${snips.get(n.path) ? `<div class="s">${snips.get(n.path)}</div>` : ''}</div>`;
  }).join('') || '<div class="item" style="color:var(--mute)">No notes</div>';
}

/* ---------- backlinks ---------- */
function renderBacklinks() {
  const out = [];
  if (cur) {
    for (const n of live()) {
      if (n.path === cur) continue;
      const lines = n.content.split('\n');
      for (const line of lines) {
        const re = /\[\[([^\]|#]+)/g; let m;
        while ((m = re.exec(line))) {
          if (resolve(m[1]) === cur) { out.push({ path: n.path, line: line.trim().slice(0, 140) }); break; }
        }
      }
    }
  }
  $('#bl-sum').textContent = `Backlinks (${out.length})`;
  $('#bl-body').innerHTML = out.map(b =>
    `<div class="b" data-p="${esc(b.path)}"><span class="p">${esc(baseName(b.path))}</span> <span class="l">— ${esc(b.line)}</span></div>`
  ).join('') || '<div style="color:var(--mute);padding:4px 0">No notes link here yet.</div>';
}

/* ---------- open / create / rename / delete ---------- */
async function openNote(path) {
  const epoch = Auth.ensure();
  await flush();
  Auth.ensure(epoch);
  if (!notes.has(path) || notes.get(path).deleted) return;
  if (spaceOf(path) !== space) { space = spaceOf(path); rebuildIndex(); renderSpace(); }
  cur = path;
  // Remember the current space and the last note in each space (stored encrypted with the notes).
  const last = Auth.store.last && typeof Auth.store.last === 'object' ? Auth.store.last : { notes: {} };
  Auth.store.last = { space, notes: { ...last.notes, [space]: path } };
  $('#ta').value = notes.get(path).content;
  $('#title').textContent = baseName(path);
  document.title = baseName(path) + ' – Vault';
  renderPreview(); renderBacklinks(); renderList();
  document.body.classList.remove('drawer');
}
function normPath(name) {
  let p = name.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  p = p.split('/').map(s => s.replace(/[<>:"|?*]/g, '').trim()).filter(Boolean).join('/');
  if (!p) return null;
  return /\.md$/i.test(p) ? p : p + '.md';
}
// Full repository path for a note name typed in the current space.
function notePath(name) {
  const p = normPath(name); if (!p) return null;
  const full = space ? space + '/' + p : p;
  if (spaceOf(full) !== space) { alert(`"${topFolder(p)}" is a separate space. Switch to it to add notes there.`); return null; }
  return full;
}
async function createNote(name, content = '') {
  Auth.ensure();
  const p = notePath(name); if (!p) return null;
  const ex = [...notes.values()].find(n => n.path.toLowerCase() === p.toLowerCase());
  if (ex && !ex.deleted) { await openNote(ex.path); return ex.path; }
  if (ex && ex.deleted) { notes.delete(ex.path); await DB.del(ex.path); }
  const n = { path: p, content: content || `# ${baseName(p)}\n\n`, mtime: Date.now(), sha: null, dirty: true };
  notes.set(p, n); await DB.put(n);
  rebuildIndex(); await openNote(p);
  const ta = $('#ta'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  scheduleSync(15000);
  return p;
}
async function renameNote() {
  Auth.ensure();
  const n = notes.get(cur); if (!n) return;
  const to = prompt('Rename note (use folder/name to move):', rel(n.path).replace(/\.md$/i, ''));
  if (!to) return;
  const p = notePath(to);
  if (!p || p === n.path) return;
  if ([...notes.values()].some(x => !x.deleted && x.path.toLowerCase() === p.toLowerCase())) { alert('A note with that name already exists.'); return; }
  await flush();
  const old = n.path, oldBase = baseName(old);
  // old path: tombstone if it was synced, otherwise drop
  if (n.sha) n.deleted = true; else notes.delete(old);
  const nn = { path: p, content: n.content, mtime: Date.now(), sha: null, dirty: true };
  notes.set(p, nn);
  // update links in other notes if the base name changed
  const newBase = baseName(p);
  if (oldBase.toLowerCase() !== newBase.toLowerCase()) {
    const re = new RegExp('\\[\\[' + oldBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\]|#])', 'gi');
    for (const o of live()) {
      if (re.test(o.content)) { o.content = o.content.replace(re, '[[' + newBase); o.mtime = Date.now(); o.dirty = true; }
      re.lastIndex = 0;
    }
  }
  // Persist the new note, old tombstone and rewritten links as one encrypted update.
  await DB.replace();
  rebuildIndex(); cur = null; await openNote(p); scheduleSync(15000);
}
async function deleteNote() {
  Auth.ensure();
  const n = notes.get(cur); if (!n) return;
  if (!confirm(`Delete "${baseName(n.path)}"?`)) return;
  clearTimeout(saveT);
  if (n.sha) { n.deleted = true; await DB.put(n); } else { notes.delete(n.path); await DB.del(n.path); }
  rebuildIndex(); cur = null;
  const next = live().sort((a, b) => b.mtime - a.mtime)[0];
  if (next) await openNote(next.path); else await createNote('Untitled');
  scheduleSync(15000);
}

/* ---------- editor ---------- */
const ta = $('#ta');
let rpT = null;
ta.addEventListener('input', () => {
  const n = notes.get(cur); if (!n) return;
  n.content = ta.value; touch(n);
  clearTimeout(rpT); rpT = setTimeout(renderPreview, 150);
  updateSug();
});
$('#pv').addEventListener('click', async e => {
  const a = e.target.closest('a.wikilink'); if (!a) return;
  e.preventDefault();
  const t = a.dataset.target, p = resolve(t);
  if (p) await openNote(p); else await createNote(t);
});
$('#list').addEventListener('click', e => { const i = e.target.closest('.item[data-p]'); if (i) openNote(i.dataset.p); });
$('#bl-body').addEventListener('click', e => { const i = e.target.closest('.b[data-p]'); if (i) openNote(i.dataset.p); });
$('#q').addEventListener('input', renderList);

/* [[ autocomplete */
let sugItems = [], sugSel = 0, sugStart = -1;
function updateSug() {
  const pos = ta.selectionStart, before = ta.value.slice(0, pos);
  const m = /\[\[([^\]\n|]*)$/.exec(before);
  const box = $('#sug');
  if (!m) { box.style.display = 'none'; sugItems = []; return; }
  sugStart = pos - m[1].length - 2;
  const q = m[1].toLowerCase();
  sugItems = live().filter(n => baseName(n.path).toLowerCase().includes(q) && n.path !== cur)
    .sort((a, b) => b.mtime - a.mtime).slice(0, 8).map(n => baseName(n.path));
  if (!sugItems.length) { box.style.display = 'none'; return; }
  sugSel = 0; drawSug(); box.style.display = 'block';
}
function drawSug() {
  $('#sug').innerHTML = sugItems.map((s, i) => `<div class="${i === sugSel ? 'sel' : ''}" data-i="${i}">${esc(s)}</div>`).join('');
}
function pickSug(i) {
  const name = sugItems[i]; if (name == null) return;
  const pos = ta.selectionStart;
  ta.value = ta.value.slice(0, sugStart) + '[[' + name + ']]' + ta.value.slice(pos);
  const np = sugStart + name.length + 4;
  ta.setSelectionRange(np, np);
  $('#sug').style.display = 'none'; sugItems = [];
  ta.dispatchEvent(new Event('input'));
  $('#sug').style.display = 'none';
}
$('#sug').addEventListener('mousedown', e => { e.preventDefault(); const d = e.target.closest('div[data-i]'); if (d) pickSug(+d.dataset.i); });
ta.addEventListener('keydown', e => {
  const open = $('#sug').style.display === 'block' && sugItems.length;
  if (open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sugSel = (sugSel + 1) % sugItems.length; drawSug(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); sugSel = (sugSel - 1 + sugItems.length) % sugItems.length; drawSug(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSug(sugSel); return; }
    if (e.key === 'Escape') { $('#sug').style.display = 'none'; return; }
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
    ta.setSelectionRange(s + 2, s + 2);
    ta.dispatchEvent(new Event('input'));
  }
});
ta.addEventListener('blur', () => setTimeout(() => { $('#sug').style.display = 'none'; }, 150));

/* ---------- modes ---------- */
function setMode(m) {
  $('#panes').className = m;
  for (const k of ['edit', 'split', 'view']) $('#m-' + k).classList.toggle('on', k === m);
  localStorage.setItem('vault.mode', m);
  if (m !== 'edit') renderPreview();
}
$('#m-edit').onclick = () => setMode('edit');
$('#m-split').onclick = () => setMode('split');
$('#m-view').onclick = () => setMode('view');

/* ---------- quick switcher ---------- */
let qsSel = 0, qsRes = [];
function fuzzy(name, q) {
  name = name.toLowerCase();
  const i = name.indexOf(q);
  if (i >= 0) return 1000 - i - name.length * 0.01;
  let j = 0;
  for (const c of name) if (c === q[j]) j++;
  return j === q.length ? 10 : 0;
}
function drawQs() {
  const q = $('#qs-in').value.trim().toLowerCase();
  qsRes = q
    ? live().map(n => ({ n, s: fuzzy(baseName(n.path), q) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.n.mtime - a.n.mtime).slice(0, 12).map(x => ({ path: x.n.path }))
    : live().sort((a, b) => b.mtime - a.mtime).slice(0, 12).map(n => ({ path: n.path }));
  if (q && !qsRes.some(r => baseName(r.path).toLowerCase() === q)) qsRes.push({ create: $('#qs-in').value.trim() });
  qsSel = Math.min(qsSel, qsRes.length - 1);
  $('#qs-list').innerHTML = qsRes.map((r, i) =>
    `<div class="${i === qsSel ? 'sel' : ''}" data-i="${i}">${r.create != null ? `Create “${esc(r.create)}”` : esc(rel(r.path).replace(/\.md$/i, ''))}</div>`).join('');
}
async function qsGo(i) {
  const r = qsRes[i]; if (!r) return;
  $('#dlg-qs').close();
  if (r.create != null) await createNote(r.create); else await openNote(r.path);
}
function openSwitcher() {
  $('#qs-in').value = ''; qsSel = 0; drawQs(); $('#dlg-qs').showModal(); $('#qs-in').focus();
}
$('#qs-in').addEventListener('input', () => { qsSel = 0; drawQs(); });
$('#qs-in').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); qsSel = Math.min(qsSel + 1, qsRes.length - 1); drawQs(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qsSel = Math.max(qsSel - 1, 0); drawQs(); }
  else if (e.key === 'Enter') { e.preventDefault(); qsGo(qsSel); }
});
$('#qs-list').addEventListener('click', e => { const d = e.target.closest('div[data-i]'); if (d) qsGo(+d.dataset.i); });
$('#dlg-qs').addEventListener('click', e => { if (e.target === $('#dlg-qs')) $('#dlg-qs').close(); });

/* ---------- GitHub sync ---------- */
const getCfg = () => Auth.session;
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const b64e = s => { const b = new TextEncoder().encode(s); let bin = ''; b.forEach(x => bin += String.fromCharCode(x)); return btoa(bin); };
const b64d = s => { const bin = atob(s.replace(/\s/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };
async function gh(path, opts = {}) {
  const epoch = Auth.ensure();
  const c = getCfg();
  if (!c || c.exp <= Date.now()) {
    Auth.session = null;
    throw new Error('Sync session expired. Sign in again in Settings.');
  }
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + c.session };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(c.url + '/gh' + path, { ...opts, headers, signal: Auth.controller.signal, cache: 'no-store' });
  Auth.ensure(epoch);
  const result = await r.json();
  Auth.ensure(epoch);
  if (!r.ok) {
    if (r.status === 401) { Auth.session = null; throw new Error('Sync session expired. Sign in again in Settings.'); }
    throw new Error(r.status + (result.message ? ' ' + result.message : ''));
  }
  return result;
}
function setStatus(t, err) { if (!Auth.active) return; const s = $('#status'); s.textContent = t; s.classList.toggle('err', !!err); }
function scheduleSync(ms) { if (!getCfg()) return; clearTimeout(syncT); syncT = setTimeout(sync, ms); }
let syncing = null;
async function sync() {
  if (!Auth.active || !Auth.checkIdle()) return;
  const epoch = Auth.epoch;
  const c = getCfg();
  if (!c) { setStatus('Saved notes unlocked — sign in in Settings to sync'); return; }
  if (syncing === epoch) return;
  syncing = epoch; clearTimeout(syncT); setStatus('Syncing…');
  let changed = false;
  try {
    await flush();
    const tree = await gh('/git/trees/' + encodeURIComponent(c.branch || 'main') + '?recursive=1');
    if (tree.truncated) throw new Error('Repository is too large to sync safely.');
    const remote = new Map(tree.tree
      .filter(t => t.type === 'blob' && (t.path === SPACES || /\.md$/i.test(t.path) && !t.path.split('/').some(s => s.startsWith('.'))))
      .map(t => [t.path, t.sha]));
    const today = new Date().toISOString().slice(0, 10);

    // pull: fetch changed blobs a few at a time; each result is applied in memory in one synchronous step
    let restored = 0;
    await pool([...remote].filter(([p, sha]) => notes.get(p)?.sha !== sha), 6, async ([p, sha]) => {
      const text = b64d((await gh('/git/blobs/' + sha)).content);
      const l = notes.get(p);
      changed = true;
      if (!l) {
        notes.set(p, { path: p, content: text, mtime: Date.now(), sha, dirty: false });
      } else if (l.deleted) {
        // Deleted here but edited elsewhere since our last sync: keep the remote edit rather than discard it.
        Object.assign(l, { content: text, sha, deleted: false, dirty: false, mtime: Date.now() }); restored++;
      } else if (!l.dirty) {
        l.content = text; l.sha = sha; l.mtime = Date.now(); showPulled(l);
      } else if (p === SPACES) {
        l.content = mergeSpaces(l.content, text); l.sha = sha; l.dirty = l.content !== text;
      } else if (l.content !== text) {
        const stem = p.replace(/\.md$/i, '') + ` (conflict ${today}`;
        let cp = stem + ').md', suffix = 2;
        while (notes.has(cp)) cp = stem + ' ' + suffix++ + ').md';
        notes.set(cp, { path: cp, content: text, mtime: Date.now(), sha: null, dirty: true });
        l.sha = sha;
      } else { l.sha = sha; l.dirty = false; }
    });
    // remote deletions
    for (const l of [...notes.values()]) {
      if (remote.has(l.path) || l.deleted) continue;
      if (l.sha && !l.dirty) { notes.delete(l.path); changed = true; }
      else if (l.sha) { l.sha = null; changed = true; }
    }
    // Persist everything pulled as one encrypted write instead of re-encrypting the vault per note.
    if (changed) { await DB.replace(); changed = false; }
    // push
    let pushed = 0;
    for (const l of [...notes.values()]) {
      if (l.deleted) {
        if (remote.has(l.path)) {
          // The pull restores tombstones whose remote changed, so this sha is the version we deleted.
          await gh('/contents/' + encPath(l.path), { method: 'DELETE', body: JSON.stringify({ message: 'Delete ' + l.path, sha: l.sha, branch: c.branch || 'main' }) });
          pushed++;
        }
        notes.delete(l.path); changed = true; continue;
      }
      if (l.dirty || !l.sha) {
        const sent = l.content;
        const body = { message: 'Update ' + l.path, content: b64e(sent), branch: c.branch || 'main' };
        if (l.sha) body.sha = l.sha;
        const res = await gh('/contents/' + encPath(l.path), { method: 'PUT', body: JSON.stringify(body) });
        l.sha = res.content.sha; l.dirty = l.content !== sent; changed = true; pushed++;
      }
    }
    if (changed) { await DB.replace(); changed = false; }
    rebuildIndex();
    if (!cur || !notes.has(cur) || notes.get(cur).deleted) {
      if (!activeSpaces().some(s => s.folder === space)) { space = ''; rebuildIndex(); }
      const next = live().sort((a, b) => b.mtime - a.mtime)[0];
      cur = null; if (next) await openNote(next.path);
    } else {
      // Follow the open note if another device created or removed the space it belongs to.
      if (spaceOf(cur) !== space) { space = spaceOf(cur); rebuildIndex(); }
      showPulled(notes.get(cur));
    }
    renderSpace(); renderList(); renderBacklinks();
    setStatus('Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      (pushed ? ` · pushed ${pushed}` : '') + (restored ? ` · restored ${restored} deleted note${restored > 1 ? 's' : ''} edited elsewhere` : ''));
  } catch (e) {
    // Keep what was already pulled or pushed; the lock path persists its own snapshot.
    if (changed && epoch === Auth.epoch) await DB.replace().catch(() => {});
    if (epoch === Auth.epoch) setStatus('Sync failed: ' + e.message, true);
  } finally { if (syncing === epoch) syncing = null; }
}
// Run fn over items with limited concurrency. On failure, stop taking new items and wait for the rest to settle.
async function pool(items, limit, fn) {
  let next = 0; const errors = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!errors.length && next < items.length) {
      try { await fn(items[next++]); } catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw errors[0];
}
// Show pulled text in the open editor at once, even when focused, so the next keystroke builds on it.
// Only unedited notes are replaced; local edits keep their text and the remote copy becomes a conflict note.
function showPulled(n) {
  if (n.path !== cur || n.dirty || ta.value === n.content) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = n.content;
  ta.setSelectionRange(Math.min(start, ta.value.length), Math.min(end, ta.value.length));
  renderPreview();
}

/* ---------- spaces UI ---------- */
function renderSpace() { $('#space-name').textContent = spaceName(space); }
async function saveSpaces(list) {
  const n = notes.get(SPACES) || { path: SPACES, sha: null };
  Object.assign(n, { content: spacesJSON(list), mtime: Date.now(), dirty: true, deleted: false });
  notes.set(SPACES, n); await DB.put(n);
  rebuildIndex(); renderSpace(); scheduleSync(15000);
}
async function switchSpace(folder, path) {
  const epoch = Auth.ensure();
  await flush(); Auth.ensure(epoch);
  space = activeSpaces().some(s => s.folder === folder) ? folder : '';
  cur = null; $('#q').value = '';
  rebuildIndex(); renderSpace();
  const want = path || Auth.store.last?.notes?.[space];
  const start = want && notes.has(want) && isNote(notes.get(want)) && spaceOf(want) === space
    ? want : live().sort((a, b) => b.mtime - a.mtime)[0]?.path;
  if (start) await openNote(start); else await createNote('Home', `# ${spaceName(space)}\n\n`);
}
async function createSpace(name) {
  Auth.ensure();
  name = name.trim();
  const typed = name.replace(/[\\/<>:"|?*]/g, '').replace(/^[.\s]+/, '').trim(), key = typed.toLowerCase();
  if (!typed) throw new Error('Enter a space name.');
  if (activeSpaces().some(s => s.folder.toLowerCase() === key)) throw new Error('That space already exists.');
  // An existing folder in Main becomes the space as it is: its notes move over without any file changes.
  const inFolder = [...notes.values()].filter(n => isNote(n) && topFolder(n.path)?.toLowerCase() === key);
  const folder = inFolder.length ? topFolder(inFolder[0].path) : typed;
  if (inFolder.length && !confirm(`${inFolder.length} note${inFolder.length > 1 ? 's' : ''} in "${folder}/" will move into this space. Files stay where they are in GitHub.`)) return;
  await saveSpaces([...spaceList.filter(s => s.folder.toLowerCase() !== key), { folder, name, updated: Date.now() }]);
  $('#dlg-spaces').close();
  await switchSpace(folder);
}
async function renameSpace(folder) {
  Auth.ensure();
  const name = prompt('Rename space (the GitHub folder keeps its name):', spaceName(folder))?.trim();
  if (!name) return;
  await saveSpaces(spaceList.map(s => s.folder === folder ? { ...s, name, updated: Date.now() } : s));
  drawSpaces();
}
async function removeSpace(folder) {
  Auth.ensure();
  if (!confirm(`Remove the "${spaceName(folder)}" space? No notes are deleted: they stay in GitHub and appear in Main as the "${folder}" folder.`)) return;
  await saveSpaces(spaceList.map(s => s.folder === folder ? { ...s, removed: true, updated: Date.now() } : s));
  if (space === folder || spaceOf(cur || '') !== space) await switchSpace('');
  else { renderList(); renderBacklinks(); }
  drawSpaces();
}
function drawSpaces() {
  const counts = new Map();
  for (const n of notes.values()) if (isNote(n)) counts.set(spaceOf(n.path), (counts.get(spaceOf(n.path)) || 0) + 1);
  $('#sp-list').innerHTML = activeSpaces().sort((a, b) => !a.folder ? -1 : !b.folder ? 1 : a.name.localeCompare(b.name)).map(s =>
    `<div class="sp${s.folder === space ? ' cur' : ''}" data-f="${esc(s.folder)}">
      <button class="go">${esc(s.name)} <span class="n">${counts.get(s.folder) || 0}</span></button>
      <button class="ren" title="Rename space">✎</button>
      ${s.folder ? '<button class="rm" title="Remove space (keeps its notes)">✕</button>'
        : '<button class="rm" style="visibility:hidden" tabindex="-1" aria-hidden="true">✕</button>'}</div>`).join('');
}
function openSpaces() {
  Auth.ensure();
  if ($('#dlg-spaces').open) return;
  $('#sp-name').value = ''; $('#sp-err').textContent = '';
  drawSpaces(); $('#dlg-spaces').showModal();
}
$('#space').onclick = openSpaces;
$('#sp-close').onclick = () => $('#dlg-spaces').close();
$('#dlg-spaces').addEventListener('click', e => { if (e.target === $('#dlg-spaces')) $('#dlg-spaces').close(); });
$('#sp-list').addEventListener('click', async e => {
  const row = e.target.closest('.sp[data-f]'); if (!row) return;
  const folder = row.dataset.f;
  $('#sp-err').textContent = '';
  try {
    if (e.target.closest('.go')) { $('#dlg-spaces').close(); await switchSpace(folder); }
    else if (e.target.closest('.ren')) await renameSpace(folder);
    else if (e.target.closest('.rm')) await removeSpace(folder);
  } catch (error) { if (Auth.active) $('#sp-err').textContent = error.message; }
});
$('#sp-new').onsubmit = async e => {
  e.preventDefault();
  $('#sp-err').textContent = '';
  try { await createSpace($('#sp-name').value); }
  catch (error) { if (Auth.active) $('#sp-err').textContent = error.message; }
};

/* settings dialog */
$('#cfg').onclick = () => {
  Auth.ensure();
  $('#c-url').value = Auth.settings.url || '';
  $('#c-branch').value = Auth.settings.branch || 'main';
  $('#c-pw').value = ''; $('#c-err').textContent = '';
  $('#dlg-cfg').showModal();
};
$('#c-cancel').onclick = () => $('#dlg-cfg').close();
$('#c-clear').onclick = () => Auth.lock('Signed out. Enter your password to unlock.');
$('#lock').onclick = () => Auth.lock();
$('#c-save').onclick = async () => {
  const button = $('#c-save'); button.disabled = true;
  try {
    await Auth.connect($('#c-url').value, $('#c-branch').value, $('#c-pw').value);
    $('#c-pw').value = ''; $('#dlg-cfg').close(); sync();
  } catch (error) { if (Auth.active) $('#c-err').textContent = error.message; }
  finally { $('#c-pw').value = ''; button.disabled = false; }
};
$('#c-rekey').onclick = () => {
  $('#dlg-cfg').close(); $('#change-error').textContent = '';
  $('#old-password').value = ''; $('#new-password').value = '';
  $('#dlg-password').showModal();
};
$('#change-cancel').onclick = () => { $('#dlg-password').close(); $('#old-password').value = ''; $('#new-password').value = ''; };
$('#change-save').onclick = async () => {
  $('#change-save').disabled = true;
  try {
    await Auth.changePassword($('#old-password').value, $('#new-password').value);
    if (Auth.active) { $('#dlg-password').close(); setStatus('Local password updated.'); }
  } catch (error) { if (Auth.active) $('#change-error').textContent = error.message; }
  finally { $('#old-password').value = ''; $('#new-password').value = ''; $('#change-save').disabled = false; }
};

/* ---------- toolbar / shortcuts ---------- */
$('#new').onclick = () => { const n = prompt('New note name (use folder/name for folders):'); if (n) createNote(n); };
$('#title').onclick = renameNote;
$('#del').onclick = deleteNote;
$('#sync').onclick = sync;
$('#switch').onclick = openSwitcher;
$('#menu').onclick = () => document.body.classList.toggle('drawer');
$('#back').onclick = () => document.body.classList.remove('drawer');
document.addEventListener('keydown', e => {
  if (!Auth.active) return;
  Auth.ensure();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openSpaces(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openSwitcher(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); sync(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); document.body.classList.add('drawer'); $('#q').focus(); }
  else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); setMode($('#panes').className === 'edit' ? 'view' : 'edit'); }
  else if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#new').click(); }
});
window.addEventListener('beforeunload', e => {
  if (Auth.store.pending || (Auth.active && saveT)) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (!Auth.active) return;
  if (!Auth.checkIdle()) return;
  if (document.hidden) flush().catch(error => setStatus('Could not save: ' + error.message, true));
  else if (getCfg()) sync();
});

/* ---------- init ---------- */
const WELCOME = `# Welcome to Vault

Your notes are plain markdown files, stored in this browser and synced to your own private GitHub repo.

- Link notes with [[wikilinks]] — try [[Example Note]] (click it in the preview to create it)
- Type \`[[\` in the editor to autocomplete note names
- Backlinks appear under the editor
- **Ctrl/Cmd+O** quick switcher · **Ctrl/Cmd+S** sync · **Alt+N** new note
- Use \`folder/name\` when creating a note to put it in a folder
- Set up sync with the ⚙ button

- [ ] Try a task item
`;
const App = {
  snapshot() { return { notes: structuredClone([...notes.values()]), last: structuredClone(Auth.store.last) }; },
  clear() {
    clearTimeout(saveT); saveT = null; clearTimeout(syncT); clearTimeout(rpT);
    notes.clear(); cur = null; space = ''; rebuildIndex(); syncing = null;
    $('#space-name').textContent = ''; $('#sp-list').replaceChildren();
    $('#ta').value = ''; $('#pv').replaceChildren(); $('#list').replaceChildren();
    $('#title').textContent = ''; document.title = 'Vault — Locked';
    $('#bl-body').replaceChildren(); $('#bl-sum').textContent = 'Backlinks';
    $('#q').value = ''; $('#qs-in').value = ''; $('#qs-list').replaceChildren();
    $('#sug').replaceChildren(); $('#sug').style.display = 'none';
    qsRes = []; sugItems = []; sugStart = -1;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    for (const input of document.querySelectorAll('input[type=password]')) input.value = '';
    $('#status').textContent = 'Locked'; document.body.classList.remove('drawer');
  },
  async open() {
    for (const note of await DB.all()) notes.set(note.path, note);
    space = ''; rebuildIndex();
    // Older versions stored only the last note's path.
    const last = Auth.store.last, legacy = typeof last === 'string' ? last : null;
    if (legacy || !last) Auth.store.last = { space: '', notes: {} };
    if (![...notes.values()].some(isNote)) await createNote('Welcome', WELCOME);
    setMode(localStorage.getItem('vault.mode') || 'split');
    await switchSpace(legacy ? spaceOf(legacy) : last?.space || '', legacy || undefined);
    if (getCfg()) sync();
    else setStatus('Saved notes unlocked — offline or sign in in Settings to sync');
  },
  flush, sync
};
Auth.start(App, SYNC_URL);
