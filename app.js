'use strict';
// Set this to your sync server (Cloudflare Worker) URL so new devices only need the password.
const SYNC_URL = '';
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
let index = { byPath: new Map(), byBase: new Map(), files: new Map(), fileBase: new Map() };

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
  index = { byPath: new Map(), byBase: new Map(), files: new Map(), fileBase: new Map() };
  for (const n of live().sort((a, b) => a.path.length - b.path.length)) {
    index.byPath.set(rel(n.path).toLowerCase(), n.path);
    const b = baseName(n.path).toLowerCase();
    if (!index.byBase.has(b)) index.byBase.set(b, n.path);
  }
  // Attachments downloaded to this device, in the current space. Nothing is indexed while locking.
  if (Auth.active) for (const f of [...Auth.store.files.values()].filter(f => spaceOf(f.path) === space).sort((a, b) => a.path.length - b.path.length)) {
    index.files.set(rel(f.path).toLowerCase(), f.path);
    const b = f.path.replace(/^.*\//, '').toLowerCase();
    if (!index.fileBase.has(b)) index.fileBase.set(b, f.path);
  }
}
function resolve(target) {
  const t = target.trim().toLowerCase().replace(/\.md$/, '');
  if (t.includes('/')) return index.byPath.get(t + '.md') || index.byBase.get(t.replace(/^.*\//, '')) || null;
  return index.byBase.get(t) || null;
}
// Attachments resolve like Obsidian: path from the space root, then relative to the note, then by file name.
function resolveFile(target, from) {
  let t = target.trim().replace(/\\/g, '/');
  try { t = decodeURI(t); } catch {}
  const join = p => { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/').toLowerCase(); };
  const dir = from ? rel(from).replace(/[^/]*$/, '') : '';
  return index.files.get(join(t)) || index.files.get(join(dir + t)) || index.fileBase.get(t.replace(/^.*\//, '').toLowerCase()) || null;
}

/* ---------- markdown ---------- */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const fileName = p => p.replace(/^.*\//, '');
function fileLink(path) { return `<a class="att-link" data-file="${esc(path)}" title="Download">📎 ${esc(fileName(path))}</a>`; }
// Paths of the note being rendered and the notes it embeds; relative attachments resolve from the innermost.
let rendering = [];
// Heading keys ignore case, punctuation and formatting, so [[Note#Goals & plans]] finds "## Goals & *plans*".
const headingKey = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function noteLink(target, heading, text) {
  const ok = !target || resolve(target);
  return `<a class="wikilink${ok ? '' : ' missing'}" data-target="${esc(target)}"${heading ? ` data-heading="${esc(headingKey(heading))}"` : ''}>${esc(text)}</a>`;
}
// A leading YAML block (Obsidian properties) is shown separately from the note's text.
const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
function splitFrontmatter(content) {
  const m = FRONTMATTER.exec(content);
  return m ? { yaml: m[1], body: content.slice(m[0].length) } : { yaml: null, body: content };
}
function propertiesHTML(yaml) {
  const rows = [];
  for (const line of yaml.split(/\r?\n/)) {
    const key = /^([^\s#:-][^:]*):[ \t]*(.*)$/.exec(line), item = /^\s+-\s*(.*)$/.exec(line);
    if (key) rows.push([key[1].trim(), key[2].trim() ? [key[2].trim()] : []]);
    else if (item && rows.length) rows.at(-1)[1].push(item[1].trim());
  }
  if (!rows.length) return '';
  return `<details class="props"><summary>Properties</summary><table>${rows.map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td>${esc(v.map(x => x.replace(/^(["'])(.*)\1$/, '$2')).join(', '))}</td></tr>`).join('')}</table></details>`;
}
// The part of a note under a heading, up to the next heading of the same or a higher level.
function section(body, heading) {
  const lines = body.split('\n'), key = headingKey(heading);
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && headingKey(l.replace(/^#+\s+/, '')) === key);
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start])[0].length;
  let end = start + 1;
  while (end < lines.length && !(/^#{1,6}\s/.test(lines[end]) && /^#+/.exec(lines[end])[0].length <= level)) end++;
  return lines.slice(start, end).join('\n');
}
function renderMarkdown(path, content) {
  rendering.push(path);
  try {
    const { yaml, body } = splitFrontmatter(content);
    return (yaml != null && rendering.length === 1 ? propertiesHTML(yaml) : '') + marked.parse(body);
  } finally { rendering.pop(); }
}
// ![[file]], ![[file|300]] and ![[file|300x200]] for attachments; ![[Note]] and ![[Note#Heading]] embed notes.
function embedHTML(target, option, heading) {
  const p = resolveFile(target, rendering.at(-1));
  if (p && IMAGE.test(p)) {
    const size = /^(\d+)(?:x(\d+))?$/.exec(option);
    return `<img data-file="${esc(p)}" alt="${esc(size ? fileName(p) : option || fileName(p))}"` +
      (size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : '') + '>';
  }
  if (p) return fileLink(p);
  const n = notes.get(resolve(target));
  const title = option || (heading ? `${target} › ${heading}` : target);
  if (!n) {
    if (/\.[a-z0-9]+$/i.test(target) && !/\.md$/i.test(target)) return `<span class="att-missing">${esc(fileName(target))}</span>`;
    return noteLink(target, heading, title);
  }
  // Embeds nest up to three deep; a note that embeds itself, directly or not, shows a link instead.
  if (rendering.includes(n.path) || rendering.length >= 4) return noteLink(target, heading, title);
  const body = splitFrontmatter(n.content).body, part = heading ? section(body, heading) : body;
  if (part == null) return noteLink(target, heading, title);
  return `<div class="embed"><div class="embed-title">${noteLink(target, heading, title)}</div>${renderMarkdown(n.path, part)}</div>`;
}
marked.use({
  gfm: true, breaks: true,
  renderer: {
    // Headings carry a data key for [[Note#Heading]] links. Ids could clash with the app's own elements.
    heading(text, level, raw) { return `<h${level} data-heading="${esc(headingKey(raw))}">${text}</h${level}>\n`; },
    // Relative image paths are attachments; they get their source from the encrypted store after rendering.
    image(href, title, text) {
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
      const p = resolveFile(href, rendering.at(-1));
      return p ? `<img data-file="${esc(p)}" alt="${text}"${title ? ` title="${esc(title)}"` : ''}>` : `<span class="att-missing">${text || esc(href)}</span>`;
    }
  },
  extensions: [{
    name: 'embed', level: 'inline',
    start(src) { return src.indexOf('![['); },
    tokenizer(src) {
      const m = /^!\[\[([^\]|#^]+)(?:#(?!\^)([^\]|]*)|#\^[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(src);
      if (m) return { type: 'embed', raw: m[0], target: m[1].trim(), heading: (m[2] || '').trim(), option: (m[3] || '').trim() };
    },
    renderer(t) { return embedHTML(t.target, t.option, t.heading); }
  }, {
    name: 'wikilink', level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      // [[Note]], [[Note|text]], [[Note#Heading]] and [[#Heading]] in the same note.
      const m = /^\[\[([^\]|#]*)(?:#(?!\^)([^\]|]*)|#\^[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (!m || !m[1].trim() && !m[2]?.trim()) return;
      const target = m[1].trim(), heading = (m[2] || '').trim();
      return { type: 'wikilink', raw: m[0], target, heading, text: (m[3] || (target && heading ? `${target} › ${heading}` : target || heading)).trim() };
    },
    renderer(t) {
      const ok = resolve(t.target);
      if (!ok && t.target && !/\.md$/i.test(t.target)) { const f = resolveFile(t.target, rendering.at(-1)); if (f) return fileLink(f); }
      return noteLink(t.target, t.heading, t.text);
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
  rendering = [];
  $('#pv').innerHTML = n ? DOMPurify.sanitize(renderMarkdown(n.path, n.content)) : '';
  const epoch = Auth.epoch;
  for (const img of $('#pv').querySelectorAll('img[data-file]')) {
    const f = Auth.store.files.get(img.dataset.file);
    if (f) fileURL(f).then(url => { if (epoch === Auth.epoch && img.isConnected) img.src = url; }, () => img.classList.add('broken'));
  }
}

/* ---------- attachments ---------- */
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const fileURLs = new Map();   // file id -> Promise of an object URL, most recently created last
// Raster images become typed blob: URLs. SVG becomes a data: URL: a blob: URL shares the app's origin, so an
// SVG (or any document) opened from one in a new tab could run script with access to this app's storage.
function fileURL(f) {
  if (!fileURLs.has(f.id)) {
    fileURLs.set(f.id, Auth.store.getFile(f.id).then(bytes => {
      const ext = f.path.replace(/^.*\./, '').toLowerCase();
      return ext === 'svg' ? 'data:image/svg+xml;base64,' + bytesB64(bytes) : URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
    }));
    fileURLs.get(f.id).catch(() => fileURLs.delete(f.id));
    if (fileURLs.size > 100) { const [id, url] = fileURLs.entries().next().value; fileURLs.delete(id); revoke(url); }
  }
  return fileURLs.get(f.id);
}
const revoke = url => url.then(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); }, () => {});
// Other attachments are only ever downloaded, never opened in the app's origin.
async function downloadFile(path) {
  const f = Auth.store.files.get(path); if (!f) return;
  const url = URL.createObjectURL(new Blob([await Auth.store.getFile(f.id)], { type: 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = fileName(path); a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
  const file = e.target.closest('a.att-link');
  if (file) { e.preventDefault(); downloadFile(file.dataset.file).catch(error => setStatus('Could not open attachment: ' + error.message, true)); return; }
  const a = e.target.closest('a.wikilink'); if (!a) return;
  e.preventDefault();
  const t = a.dataset.target, p = t ? resolve(t) : cur;
  if (!p) { await createNote(t); return; }
  if (p !== cur) await openNote(p);
  if (a.dataset.heading) scrollToHeading(a.dataset.heading);
});
// Show a heading in the preview, and move the editor's cursor to it without focusing (no keyboard pops up on phones).
function scrollToHeading(key) {
  const h = [...$('#pv').querySelectorAll(':scope > [data-heading]')].find(h => h.dataset.heading === key);
  h?.scrollIntoView({ block: 'start' });
  const lines = ta.value.split('\n'), i = lines.findIndex(l => /^#{1,6}\s/.test(l) && headingKey(l.replace(/^#+\s+/, '')) === key);
  if (i < 0) return;
  const at = lines.slice(0, i).reduce((sum, l) => sum + l.length + 1, 0);
  ta.setSelectionRange(at, at);
  ta.scrollTop = ta.scrollHeight * i / lines.length;
}
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
  const signal = opts.signal ? AbortSignal.any([Auth.controller.signal, opts.signal]) : Auth.controller.signal;
  const r = await fetch(c.url + '/gh' + path, { ...opts, headers, signal, cache: 'no-store' });
  Auth.ensure(epoch);
  const result = await r.json();
  Auth.ensure(epoch);
  if (!r.ok) {
    if (r.status === 401) { Auth.session = null; throw new Error('Sync session expired. Sign in again in Settings.'); }
    // GitHub signals rate limits with 403/429 and either Retry-After or an exhausted quota and its reset time.
    const exhausted = r.headers.get('X-RateLimit-Remaining') === '0';
    const reset = exhausted ? Number(r.headers.get('X-RateLimit-Reset')) * 1000 - Date.now() : 0;
    throw Object.assign(new Error(r.status + (result.message ? ' ' + result.message : '')), {
      status: r.status, limited: (r.status === 403 || r.status === 429) && (r.headers.has('Retry-After') || exhausted || /rate limit/i.test(result.message)),
      wait: Number(r.headers.get('Retry-After')) * 1000 || Math.max(0, reset) || 0
    });
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
    const visible = t => t.type === 'blob' && !t.path.split('/').some(s => s.startsWith('.'));
    const remote = new Map(tree.tree
      .filter(t => t.path === SPACES || visible(t) && /\.md$/i.test(t.path))
      .map(t => [t.path, t.sha]));
    const remoteFiles = new Map(tree.tree.filter(t => visible(t) && !/\.md$/i.test(t.path) && !(t.size > FILE_MAX)).map(t => [t.path, t.sha]));
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
    syncStatus = 'Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      (pushed ? ` · pushed ${pushed}` : '') + (restored ? ` · restored ${restored} deleted note${restored > 1 ? 's' : ''} edited elsewhere` : '');
    setStatus(syncStatus);
    pullFiles(remoteFiles);
  } catch (e) {
    // Keep what was already pulled or pushed; the lock path persists its own snapshot.
    if (changed && epoch === Auth.epoch) await DB.replace().catch(() => {});
    if (epoch === Auth.epoch) setStatus('Sync failed: ' + e.message, true);
  } finally { if (syncing === epoch) syncing = null; }
}

// Attachments download after notes, in the background, so a large first download never delays editing or pushes.
// Only one download runs at a time; a sync that finishes meanwhile queues its newer file list.
const FILE_MAX = 25 * 1024 * 1024;
let syncStatus = '', filesRun = null, filesNext = null;
function pullFiles(remoteFiles) {
  if (filesRun) { filesNext = remoteFiles; return; }
  const epoch = Auth.epoch;
  filesRun = (async () => {
    for (let want = remoteFiles; want && epoch === Auth.epoch; want = filesNext) { filesNext = null; await pullFilesOnce(epoch, want); }
  })().catch(error => { if (epoch === Auth.epoch) setStatus('Attachment download failed: ' + error.message, true); })
    .finally(() => { if (epoch === Auth.epoch) filesRun = null; });
}
async function pullFilesOnce(epoch, remoteFiles) {
  const store = Auth.store, replaced = [];
  // Metadata is saved before old bytes are deleted; bytes are written before metadata refers to them.
  const save = async () => {
    await store.persist(); Auth.ensure(epoch);
    await store.deleteFiles(replaced.splice(0));
    rebuildIndex(); renderPreview();
  };
  for (const f of [...store.files.values()]) if (!remoteFiles.has(f.path)) { store.files.delete(f.path); replaced.push(f.id); }
  if (replaced.length) await save();
  const todo = [...remoteFiles].filter(([p, sha]) => store.files.get(p)?.sha !== sha);
  let done = 0, unsaved = 0;
  try {
    await pool(todo, 3, async ([p, sha]) => {
      const bytes = b64bytes((await gh('/git/blobs/' + sha)).content);
      const id = await store.putFile(bytes);
      Auth.ensure(epoch);
      const old = store.files.get(p);
      if (old) replaced.push(old.id);
      store.files.set(p, { path: p, sha, size: bytes.length, id });
      setStatus(`${syncStatus} · attachments ${++done}/${todo.length}`);
      if (++unsaved >= 10) { unsaved = 0; await save(); }
    });
  } finally {
    if (epoch === Auth.epoch && (unsaved || replaced.length)) await save();
  }
  if (todo.length) setStatus(`${syncStatus} · ${todo.length} attachment${todo.length === 1 ? '' : 's'} downloaded`);
}
const b64bytes = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
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

/* ---------- import a folder as a space ---------- */
// A picked or dropped folder (such as an Obsidian vault) becomes a new space. Files reach GitHub byte for byte
// in one commit: text goes inline in tree requests, other files as blobs. See docs/import-plan.md.
const IMPORT_WARN = 500 * 1024 * 1024;
const JUNK = new Set(['thumbs.db', 'desktop.ini']);
const TEXT_EXT = /\.(md|txt|canvas|json|css|js|csv|svg|html?|xml|ya?ml|base)$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let importJob = null;   // {root, files, skipped, hidden, size, done: Map(path -> {sha, text?}), ctrl, running}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function gitSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`), all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}
function bytesB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// Exact text for valid UTF-8 without NUL bytes; anything else is uploaded as a binary blob.
function asText(bytes) { if (bytes.includes(0)) return null; try { return utf8.decode(bytes); } catch { return null; } }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Import cancelled.')); }, { once: true });
  });
}
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

// entries: [{path: 'Root/sub/file.md', file}] relative to the picked folder's parent.
function scanImport(entries) {
  const root = entries[0]?.path.split('/')[0] || '';
  const files = [], skipped = [], hidden = new Set();
  let size = 0;
  for (const { path, file } of entries) {
    const segs = path.split('/').slice(1), rel = segs.join('/');
    const dot = segs.findIndex(s => s.startsWith('.'));
    if (dot >= 0) { hidden.add(segs.slice(0, dot + 1).join('/')); continue; }
    if (!rel || !file) continue;
    if (JUNK.has(segs.at(-1).toLowerCase())) { hidden.add(rel); continue; }
    if (file.size > FILE_MAX) { skipped.push(rel + ' (' + mb(file.size) + ')'); continue; }
    files.push({ path: rel, file }); size += file.size;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, skipped, hidden: [...hidden].sort(), size };
}
// Walk a dropped folder. Hidden folders such as .git are recorded but never read.
async function readDropped(entry, prefix, out) {
  if (entry.isFile) { out.push({ path: prefix + entry.name, file: await new Promise((res, rej) => entry.file(res, rej)) }); return; }
  if (prefix && entry.name.startsWith('.')) { out.push({ path: prefix + entry.name + '/', file: null }); return; }
  const reader = entry.createReader();
  for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length;) {
    for (const child of batch) await readDropped(child, prefix + entry.name + '/', out);
  }
}
function importFolder(name) {
  const folder = name.trim().replace(/[\\/<>:"|?*]/g, '').replace(/^[.\s]+/, '').trim(), key = folder.toLowerCase();
  if (!folder) throw new Error('Enter a space name.');
  if (activeSpaces().some(s => s.folder.toLowerCase() === key) || [...notes.values()].some(n => !n.deleted && topFolder(n.path)?.toLowerCase() === key)) {
    throw new Error(`A space or folder named "${folder}" already exists. Choose another name.`);
  }
  return folder;
}
function importProgress(text) { if (Auth.active) $('#imp-status').textContent = text; }
// Retry GitHub rate limits (common for many attachment uploads) instead of failing the import.
async function ghPatient(path, opts) {
  for (let attempt = 0, delay = 60000; ; attempt++, delay = Math.min(delay * 2, 900000)) {
    try { return await gh(path, opts); }
    catch (error) {
      if (!error.limited || attempt >= 8) throw error;
      const until = Date.now() + (error.wait || delay);
      while (Date.now() < until) {
        importProgress(`Waiting for GitHub's rate limit… resuming in ${Math.ceil((until - Date.now()) / 1000)} s`);
        await sleep(Math.min(1000, until - Date.now()), opts.signal);
      }
    }
  }
}

function openImport(entries) {
  Auth.ensure();
  if (importJob?.running) { if (!$('#dlg-import').open) $('#dlg-import').showModal(); return; }
  const scan = scanImport(entries);
  importJob = { ...scan, done: new Map(), ctrl: null, running: false };
  const notesN = scan.files.filter(f => /\.md$/i.test(f.path)).length, others = scan.files.length - notesN;
  const binaries = scan.files.filter(f => !TEXT_EXT.test(f.path)).length;
  $('#imp-name').value = scan.root.replace(/^[.\s]+/, '');
  $('#imp-sum').textContent = scan.files.length
    ? `${notesN} note${notesN === 1 ? '' : 's'}, ${others} attachment${others === 1 ? '' : 's'} (${mb(scan.size)}).` +
      (binaries > 60 ? ` GitHub limits uploads, so attachments take about ${Math.ceil(binaries / 70)} minutes.` : '')
    : 'This folder has no files to import.';
  const skips = [...scan.hidden.map(p => p + ' (hidden)'), ...scan.skipped.map(p => p + ' — over 25 MB')];
  $('#imp-skip').hidden = !skips.length;
  $('#imp-skip summary').textContent = `Skipped ${skips.length} item${skips.length === 1 ? '' : 's'}`;
  $('#imp-skip-list').innerHTML = skips.map(s => `<li>${esc(s)}</li>`).join('');
  $('#imp-status').textContent = ''; $('#imp-go').textContent = 'Import';
  $('#imp-err').textContent = getCfg() ? '' : 'Sign in to sync in Settings before importing.';
  $('#imp-go').disabled = !scan.files.length;
  $('#dlg-spaces').close();
  if (!$('#dlg-import').open) $('#dlg-import').showModal();
}

async function runImport() {
  const epoch = Auth.ensure(), job = importJob;
  if (!job || job.running) return;
  const name = $('#imp-name').value.trim(), folder = importFolder(name);
  if (!getCfg()) throw new Error('Sign in to sync in Settings before importing.');
  if (job.size > IMPORT_WARN && !confirm(`This import is ${mb(job.size)}. Every device downloads it after syncing. Continue?`)) return;
  job.running = true; job.ctrl = new AbortController();
  const signal = job.ctrl.signal;
  try { await uploadImport(epoch, job, folder, name, signal); }
  catch (error) {
    // Workers deployed before imports existed refuse the Git Data routes.
    if (error.status === 403 && /Not allowed/.test(error.message)) throw new Error('Your sync server needs an update to import folders. Redeploy worker.js from this version of Vault.');
    throw error;
  } finally { job.running = false; }
}
async function uploadImport(epoch, job, folder, name, signal) {
  // 1. Read every file; text is kept for inline tree entries, everything else is uploaded as a blob.
  const todo = job.files.filter(f => !job.done.has(f.path));
  let read = job.files.length - todo.length;
  await pool(todo, 3, async f => {
    const bytes = new Uint8Array(await f.file.arrayBuffer());
    Auth.ensure(epoch); if (signal.aborted) throw new Error('Import cancelled.');
    const text = asText(bytes);
    const sha = text == null
      ? (await ghPatient('/git/blobs', { method: 'POST', body: JSON.stringify({ content: bytesB64(bytes), encoding: 'base64' }), signal })).sha
      : await gitSha(bytes);
    job.done.set(f.path, { sha, text, mtime: f.file.lastModified || Date.now() });
    importProgress(`Reading and uploading files ${++read}/${job.files.length}…`);
  });
  // 2. Build the space's folder as a standalone tree, a chunk at a time.
  let folderTree = null, chunk = [], size = 0, built = 0;
  const flushTree = async () => {
    if (!chunk.length) return;
    importProgress(`Building folder ${built += chunk.length}/${job.files.length}…`);
    const body = { tree: chunk }; if (folderTree) body.base_tree = folderTree;
    folderTree = (await ghPatient('/git/trees', { method: 'POST', body: JSON.stringify(body), signal })).sha;
    chunk = []; size = 0;
  };
  for (const f of job.files) {
    const d = job.done.get(f.path);
    chunk.push(d.text == null ? { path: f.path, mode: '100644', type: 'blob', sha: d.sha } : { path: f.path, mode: '100644', type: 'blob', content: d.text });
    size += d.text?.length || 100;
    if (chunk.length >= 1000 || size >= 2000000) await flushTree();
  }
  await flushTree();
  // 3. Commit it with the updated space list. Holding the sync slot keeps a background sync from pushing in between,
  //    and from deleting the seeded notes before its next tree read. An attachment download started from an older
  //    tree would likewise remove seeded attachments, so it finishes first.
  while (syncing === epoch || filesRun) {
    if (filesRun) importProgress('Waiting for attachment downloads to finish…');
    await sleep(100, signal);
  }
  Auth.ensure(epoch); syncing = epoch;
  try {
    importProgress('Committing…');
    const spaces = await commitImport(job, folder, name, folderTree, signal);
    // 4. Seed notes and the space list with their GitHub shas, so the next sync has nothing to download.
    for (const f of job.files) {
      const d = job.done.get(f.path), p = folder + '/' + f.path;
      if (!/\.md$/i.test(p) || d.text == null || notes.has(p)) continue;
      notes.set(p, { path: p, content: d.text, mtime: d.mtime, sha: d.sha, dirty: false });
    }
    // Attachments are stored from the picked files when they still match what was uploaded.
    let stored = 0;
    for (const f of job.files) {
      const d = job.done.get(f.path), p = folder + '/' + f.path;
      if (/\.md$/i.test(p) || Auth.store.files.has(p)) continue;
      try {
        const bytes = new Uint8Array(await f.file.arrayBuffer());
        if (await gitSha(bytes) !== d.sha) continue;
        const id = await Auth.store.putFile(bytes);
        Auth.ensure(epoch);
        Auth.store.files.set(p, { path: p, sha: d.sha, size: bytes.length, id });
        importProgress(`Saving attachments ${++stored}…`);
      } catch (error) { Auth.ensure(epoch); }
    }
    const sha = await gitSha(new TextEncoder().encode(spaces)), l = notes.get(SPACES);
    if (!l || !l.dirty || l.deleted) notes.set(SPACES, { path: SPACES, content: spaces, mtime: Date.now(), sha, dirty: false });
    else { l.content = mergeSpaces(l.content, spaces); l.sha = sha; l.dirty = l.content !== spaces; }
    importProgress('Saving notes…');
    await DB.replace();
  } finally { if (syncing === epoch) syncing = null; }
  importJob = null;
  $('#dlg-import').close();
  rebuildIndex(); await switchSpace(folder);
  setStatus(`Imported ${job.files.length} file${job.files.length === 1 ? '' : 's'} into "${name}"`);
  scheduleSync(0);
}
async function commitImport(job, folder, name, folderTree, signal) {
  const branch = getCfg().branch || 'main', key = folder.toLowerCase();
  const notesN = job.files.filter(f => /\.md$/i.test(f.path)).length;
  const message = `Import "${name}" (${notesN} note${notesN === 1 ? '' : 's'}, ${job.files.length - notesN} attachment${job.files.length - notesN === 1 ? '' : 's'})`;
  for (let attempt = 1; ; attempt++) {
    const head = (await gh('/git/ref/heads/' + encPath(branch), { signal })).object.sha;
    const commit = await gh('/git/commits/' + head, { signal });
    const top = await gh('/git/trees/' + commit.tree.sha, { signal });
    let remote = '';
    try { remote = b64d((await gh('/contents/' + encPath(SPACES) + '?ref=' + head, { signal })).content); }
    catch (error) { if (error.status !== 404) throw error; }
    const existing = top.tree.find(t => t.path.split('/')[0].toLowerCase() === key);
    if (existing) {
      // Trees are content-addressed: an identical folder means an earlier attempt landed but its response was lost.
      if (existing.type === 'tree' && existing.sha === folderTree && parseSpaces(remote).some(s => s.folder === folder && !s.removed)) return remote;
      throw new Error(`"${folder}" already exists in your notes repo. Choose another name.`);
    }
    const spaces = spacesJSON([...parseSpaces(remote).filter(s => s.folder.toLowerCase() !== key), { folder, name, updated: Date.now() }]);
    const tree = await gh('/git/trees', { method: 'POST', signal, body: JSON.stringify({ base_tree: commit.tree.sha, tree: [
      { path: folder, mode: '040000', type: 'tree', sha: folderTree },
      { path: SPACES, mode: '100644', type: 'blob', content: spaces }] }) });
    const made = await gh('/git/commits', { method: 'POST', signal, body: JSON.stringify({ message, tree: tree.sha, parents: [head] }) });
    try {
      await gh('/git/refs/heads/' + encPath(branch), { method: 'PATCH', signal, body: JSON.stringify({ sha: made.sha, force: false }) });
      return spaces;
    } catch (error) {
      // Another device pushed meanwhile: rebuild only the top-level tree on the new head.
      if (error.status !== 422 || attempt >= 3) throw error;
    }
  }
}

if ('webkitdirectory' in document.createElement('input')) $('#sp-import').hidden = false;
$('#sp-import').onclick = () => { $('#imp-pick').value = ''; $('#imp-pick').click(); };
$('#imp-pick').onchange = () => {
  const files = [...$('#imp-pick').files];
  $('#imp-pick').value = '';
  if (files.length) openImport(files.map(file => ({ path: file.webkitRelativePath || file.name, file })));
};
$('#imp-go').onclick = async () => {
  $('#imp-err').textContent = ''; $('#imp-go').disabled = true;
  try { await runImport(); }
  catch (error) {
    if (!Auth.active) return;
    $('#imp-err').textContent = error.message; $('#imp-status').textContent = '';
    $('#imp-go').textContent = 'Retry';
  } finally { $('#imp-go').disabled = false; }
};
$('#imp-cancel').onclick = () => {
  if (importJob?.running) importJob.ctrl.abort(new Error('Import cancelled.'));
  else { importJob = null; $('#dlg-import').close(); }
};
$('#dlg-import').addEventListener('cancel', e => { if (importJob?.running) e.preventDefault(); else importJob = null; });
document.addEventListener('dragover', e => {
  if (Auth.active && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
});
document.addEventListener('drop', async e => {
  if (!Auth.active || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  // Entries must be taken during the event; they are read afterwards.
  const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (items.length !== 1 || !items[0].isDirectory) { setStatus('Drop a single folder to import it as a space.', true); return; }
  const epoch = Auth.epoch;
  try {
    const out = []; await readDropped(items[0], '', out);
    if (epoch === Auth.epoch) openImport(out);
  } catch (error) { if (Auth.active) setStatus('Could not read the dropped folder: ' + error.message, true); }
});

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
    importJob?.ctrl?.abort(); importJob = null;
    filesRun = null; filesNext = null; syncStatus = '';
    for (const url of fileURLs.values()) revoke(url);
    fileURLs.clear();
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
    // Remove attachment bytes an interrupted download or import left without metadata.
    await Auth.store.sweepFiles().catch(() => {});
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
