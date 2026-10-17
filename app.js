'use strict';
// Set this to your sync server (Cloudflare Worker) URL so new devices only need the password.
const SYNC_URL = 'https://vault-sync-01.chriscleven.workers.dev';
const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const baseName = p => p.replace(/^.*\//, '').replace(/\.md$/i, '');
const fileName = p => p.replace(/^.*\//, '');
// Images sync and embed like Obsidian attachments. Other file types stay in GitHub only.
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

/* ---------- encrypted device storage ---------- */
const DB = {
  async all() { const epoch = Auth.ensure(); const result = await Auth.store.all(); Auth.ensure(epoch); return result; },
  async put(note) { const epoch = Auth.ensure(); await Auth.store.put(note); Auth.ensure(epoch); },
  async del(path) { const epoch = Auth.ensure(); await Auth.store.del(path); Auth.ensure(epoch); },
  async files() { const epoch = Auth.ensure(); const result = await Auth.store.allFiles(); Auth.ensure(epoch); return result; },
  async replace() {
    const epoch = Auth.ensure();
    Auth.store.records = new Map([...notes].map(([path, note]) => [path, structuredClone(note)]));
    Auth.store.files = new Map([...files].map(([path, file]) => [path, structuredClone(file)]));
    await Auth.store.persist(); Auth.ensure(epoch);
  }
};

/* ---------- state ---------- */
const notes = new Map();   // path -> {path, content, mtime, sha, dirty, deleted}
const files = new Map();   // path -> {path, id, size, mtime, sha, dirty}; bytes are encrypted separately by id
let cur = null;            // current path
let index = { byPath: new Map(), byBase: new Map(), fileByPath: new Map(), fileByBase: new Map() };

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
  index = { byPath: new Map(), byBase: new Map(), fileByPath: new Map(), fileByBase: new Map() };
  for (const n of live().sort((a, b) => a.path.length - b.path.length)) {
    index.byPath.set(rel(n.path).toLowerCase(), n.path);
    const b = baseName(n.path).toLowerCase();
    if (!index.byBase.has(b)) index.byBase.set(b, n.path);
  }
  for (const f of liveFiles().sort((a, b) => a.path.length - b.path.length)) {
    index.fileByPath.set(rel(f.path).toLowerCase(), f.path);
    const b = fileName(f.path).toLowerCase();
    if (!index.fileByBase.has(b)) index.fileByBase.set(b, f.path);
  }
}
const liveFiles = () => [...files.values()].filter(f => spaceOf(f.path) === space);
// Find an attachment from a note: relative to the note's folder, then the space root, then by file name anywhere.
function resolveFile(target, from = cur) {
  let t = target.trim().replace(/^<(.*)>$/, '$1');
  if (!t || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(t)) return null;
  try { t = decodeURIComponent(t); } catch {}
  t = t.replace(/^\.?\/+/, '').toLowerCase();
  const join = parts => {
    const out = [];
    for (const s of parts.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
    return out.join('/');
  };
  const dir = from ? rel(from).replace(/[^/]*$/, '').toLowerCase() : '';
  return index.fileByPath.get(join(dir + t)) || index.fileByPath.get(join(t)) || index.fileByBase.get(t.replace(/^.*\//, '')) || null;
}
function resolve(target) {
  const t = target.trim().toLowerCase().replace(/\.md$/, '');
  if (t.includes('/')) return index.byPath.get(t + '.md') || index.byBase.get(t.replace(/^.*\//, '')) || null;
  return index.byBase.get(t) || null;
}

/* ---------- markdown ---------- */
const imgTag = (path, alt, size) => `<img class="att" data-att="${esc(path)}" alt="${esc(alt)}"` +
  (size ? ` width="${size[1]}"` + (size[2] ? ` height="${size[2]}" style="height:${size[2]}px"` : '') : '') + '>';
// "alt|300x200" -> alt and size, like Obsidian (the size is always last).
const splitSize = label => {
  const parts = (label || '').split('|'), m = /^(\d+)(?:x(\d+))?$/.exec(parts[parts.length - 1].trim());
  if (m) parts.pop();
  return { alt: parts.join('|').trim(), size: m };
};
const missingImg = name => `<span class="att missing" title="Image not found">${esc(name)}</span>`;
marked.use({
  gfm: true, breaks: true,
  renderer: {
    // Local Markdown images show the encrypted copy on this device; web images keep the default renderer.
    image(href, title, text) {
      if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return false;
      const p = resolveFile(href), { alt, size } = splitSize(text);
      if (p) return imgTag(p, alt, size);
      return IMAGE.test(href) ? missingImg(text || href) : false;
    }
  },
  extensions: [{
    // ![[image.png]], ![[image.png|300]] or ![[image.png|300x200]]
    name: 'embed', level: 'inline',
    start(src) { return src.indexOf('![['); },
    tokenizer(src) {
      const m = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m) return { type: 'embed', raw: m[0], target: m[1].trim(), text: (m[2] || '').trim() };
    },
    renderer(t) {
      if (!IMAGE.test(t.target)) return wikilinkHTML(t.target, t.text || t.target);
      const p = resolveFile(t.target), { alt, size } = splitSize(t.text);
      return p ? imgTag(p, alt || fileName(t.target), size) : missingImg(t.target);
    }
  }, {
    name: 'wikilink', level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), text: (m[2] || m[1]).trim() };
    },
    renderer(t) { return wikilinkHTML(t.target, t.text); }
  }]
});
function wikilinkHTML(target, text) {
  const att = IMAGE.test(target) && resolveFile(target);
  if (att) return `<a class="wikilink" data-att="${esc(att)}">${esc(text)}</a>`;
  const ok = resolve(target);
  return `<a class="wikilink${ok ? '' : ' missing'}" data-target="${esc(target)}">${esc(text)}</a>`;
}
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
  }
});
// The editor renders most Markdown itself; marked draws blocks it shows whole, such as tables.
function renderInto(el, md) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(md));
  loadImages(el);
}
// Decrypted images are shown through object URLs that live in memory only and are revoked on lock.
let urls = new Map();      // attachment id -> Promise<object URL>
function attachmentURL(f) {
  if (!urls.has(f.id)) {
    const epoch = Auth.epoch;
    urls.set(f.id, Auth.store.getFile(f.id).then(bytes => {
      if (epoch !== Auth.epoch) throw new Error('Vault is locked.');
      return URL.createObjectURL(new Blob([bytes], { type: MIME[f.path.replace(/^.*\./, '').toLowerCase()] || 'application/octet-stream' }));
    }));
    urls.get(f.id).catch(() => urls.delete(f.id));
  }
  return urls.get(f.id);
}
function loadImages(root) {
  const epoch = Auth.epoch;
  for (const img of root.querySelectorAll('img[data-att]')) {
    const f = files.get(img.dataset.att); if (!f) continue;
    attachmentURL(f).then(u => { if (epoch === Auth.epoch && img.isConnected) img.src = u; })
      .catch(() => { if (epoch === Auth.epoch && img.isConnected) img.outerHTML = missingImg(fileName(f.path)); });
  }
}
function revokeImages() {
  for (const u of urls.values()) u.then(URL.revokeObjectURL, () => {});
  urls = new Map();
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
      rebuildIndex(); renderBacklinks(); renderList(); editor.refresh();
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
  editor.load(notes.get(path).content);
  $('#title').textContent = baseName(path);
  document.title = baseName(path) + ' – Vault';
  renderBacklinks(); renderList();
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
  editor.focus(true);
  scheduleSync(15000);
  return p;
}
async function renameNote(name) {
  Auth.ensure();
  const n = notes.get(cur); if (!n) return;
  const to = name ?? prompt('Rename note (use folder/name to move):', rel(n.path).replace(/\.md$/i, ''));
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
// Live preview: Markdown is hidden except in the element being edited (see editor.js).
async function followLink(target) { const p = resolve(target); if (p) await openNote(p); else await createNote(target); }
async function openAttachment(path) { const f = files.get(path); if (f) window.open(await attachmentURL(f), '_blank', 'noopener'); }
const editor = LiveEditor.create($('#ed'), {
  change(text) { const n = notes.get(cur); if (!n) return; n.content = text; touch(n); },
  cursor(typed) { if (typed) updateSug(); else hideSug(); },
  keydown: e => sugKey(e),
  paste(e) {
    const list = imagesIn(e.clipboardData?.files);
    if (!list.length) return false;
    e.preventDefault(); tryAdd(list, true); return true;
  },
  drop(e) {
    const list = imagesIn(e.dataTransfer.files);
    if (list.length) tryAdd(list, false); else setStatus('Only images can be added to notes.', true);
  },
  follow: target => followLink(target).catch(error => { if (Auth.active) setStatus(error.message, true); }),
  openAttachment: path => openAttachment(path).catch(() => {}),
  imageURL(path) { const f = files.get(path); return f ? attachmentURL(f) : Promise.reject(new Error('Image not found')); },
  resolveImage: target => resolveFile(target),
  noteExists: target => !!resolve(target),
  isImage: name => IMAGE.test(name),
  fileName, renderInto
});
$('#list').addEventListener('click', e => { const i = e.target.closest('.item[data-p]'); if (i) openNote(i.dataset.p); });

/* images: paste, drop or pick; saved to attachments/ in the note's space */
const MAX_SIDE = 2000, MAX_BYTES = 20 * 1024 * 1024;
// Scale photos down to MAX_SIDE. Large or scaled images are re-encoded: JPEG for photos, WebP where
// transparency may matter (PNG if the browser can't write WebP). GIF and SVG are kept as they are.
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif|bmp|avif)$/i.test(file.type)) return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= 1024 * 1024 && EXT[file.type]) { bmp.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close();
  const alpha = /^image\/(png|webp)$/i.test(file.type);
  const out = await new Promise(r => canvas.toBlob(r, alpha ? 'image/webp' : 'image/jpeg', alpha ? 0.9 : 0.85));
  canvas.width = canvas.height = 0;
  return out && EXT[out.type] && (scale < 1 || out.size < file.size || !EXT[file.type]) ? out : file;
}
function attachmentPath(name, ext, folder) {
  const dir = (folder ? folder + '/' : '') + 'attachments/';
  const stem = name.replace(/\.[^.]*$/, '').replace(/[\\/<>:"|?*#^[\]]/g, '').trim() || 'image';
  const taken = p => [...files.values()].some(f => spaceOf(f.path) === folder && fileName(f.path).toLowerCase() === fileName(p).toLowerCase());
  let p = dir + stem + '.' + ext, i = 1;
  while (taken(p)) p = dir + stem + ' ' + i++ + '.' + ext;
  return p;
}
// Local time, like Obsidian's "Pasted image 20261017125801.png".
const stamp = (d = new Date()) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
  .map((x, i) => String(x).padStart(i ? 2 : 4, '0')).join('');
async function addImages(list, pasted) {
  const epoch = Auth.ensure();
  const n = notes.get(cur); if (!n || !list.length) return;
  const folder = spaceOf(n.path), links = [], problems = [];
  setStatus('Adding image' + (list.length > 1 ? 's' : '') + '…');
  for (const file of list) {
    const img = await shrink(file); Auth.ensure(epoch);
    const ext = EXT[img.type];
    if (!ext) { problems.push(`"${file.name}" isn't a supported image format`); continue; }
    if (img.size > MAX_BYTES) { problems.push(`"${file.name}" is larger than 20 MB`); continue; }
    const bytes = new Uint8Array(await img.arrayBuffer());
    const id = await Auth.store.putFile(bytes); Auth.ensure(epoch);
    const path = attachmentPath(pasted ? 'Pasted image ' + stamp() : file.name, ext, folder);
    files.set(path, { path, id, size: bytes.length, mtime: Date.now(), sha: null, dirty: true });
    links.push(`![[${fileName(path)}]]`);
  }
  if (links.length) {
    await DB.replace(); Auth.ensure(epoch); rebuildIndex();
    const text = links.join('\n');
    if (cur === n.path) editor.insert(text);
    else { n.content += (n.content.endsWith('\n') ? '' : '\n') + text; touch(n); }
    scheduleSync(15000);
  }
  setStatus(problems.length ? 'Could not add ' + problems.join('; ') + '.' : `Added ${links.length} image${links.length > 1 ? 's' : ''}`, problems.length > 0);
}
const imagesIn = list => [...(list || [])].filter(f => f.type.startsWith('image/'));
function tryAdd(list, pasted) {
  addImages(list, pasted).catch(error => { if (Auth.active) setStatus('Could not add image: ' + error.message, true); });
}
$('#img').onclick = () => $('#img-in').click();
$('#img-in').onchange = () => { const list = imagesIn($('#img-in').files); $('#img-in').value = ''; tryAdd(list, false); };
$('#bl-body').addEventListener('click', e => { const i = e.target.closest('.b[data-p]'); if (i) openNote(i.dataset.p); });
$('#q').addEventListener('input', renderList);

/* [[ autocomplete */
let sugItems = [], sugSel = 0, sugStart = -1;
function hideSug() { $('#sug').style.display = 'none'; sugItems = []; }
function updateSug() {
  const pos = editor.pos, before = editor.lineBefore();
  const m = /\[\[([^\]\n|]*)$/.exec(before);
  const box = $('#sug');
  if (!m) { hideSug(); return; }
  sugStart = pos - m[1].length - 2;
  const q = m[1].toLowerCase();
  // After ![[ suggest images, otherwise notes.
  sugItems = before[before.length - m[0].length - 1] === '!'
    ? liveFiles().filter(f => fileName(f.path).toLowerCase().includes(q)).sort((a, b) => b.mtime - a.mtime).slice(0, 8).map(f => fileName(f.path))
    : live().filter(n => baseName(n.path).toLowerCase().includes(q) && n.path !== cur)
      .sort((a, b) => b.mtime - a.mtime).slice(0, 8).map(n => baseName(n.path));
  if (!sugItems.length) { box.style.display = 'none'; return; }
  sugSel = 0; drawSug(); box.style.display = 'block';
  // Show the list under the [[ being typed, or above it near the bottom of the editor.
  const at = editor.coords(sugStart), area = $('#panes').getBoundingClientRect();
  if (!at) return;
  box.style.left = Math.max(0, Math.min(at.left - area.left, area.width - box.offsetWidth - 8)) + 'px';
  const below = at.bottom - area.top + 4;
  box.style.top = (below + box.offsetHeight > area.height ? Math.max(0, at.top - area.top - box.offsetHeight - 4) : below) + 'px';
}
function drawSug() {
  $('#sug').innerHTML = sugItems.map((s, i) => `<div class="${i === sugSel ? 'sel' : ''}" data-i="${i}">${esc(s)}</div>`).join('');
}
function pickSug(i) {
  const name = sugItems[i]; if (name == null) return;
  editor.insert('[[' + name + ']]', sugStart, editor.pos);
  hideSug();
}
$('#sug').addEventListener('mousedown', e => { e.preventDefault(); const d = e.target.closest('div[data-i]'); if (d) pickSug(+d.dataset.i); });
// Runs before the editor's own keys while the list is open.
function sugKey(e) {
  if ($('#sug').style.display !== 'block' || !sugItems.length) return false;
  if (e.key === 'ArrowDown') sugSel = (sugSel + 1) % sugItems.length;
  else if (e.key === 'ArrowUp') sugSel = (sugSel - 1 + sugItems.length) % sugItems.length;
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSug(sugSel); return true; }
  else if (e.key === 'Escape') { hideSug(); return true; }
  else return false;
  e.preventDefault(); drawSug(); return true;
}
editor.view.contentDOM.addEventListener('blur', () => setTimeout(() => { $('#sug').style.display = 'none'; }, 150));

/* ---------- source mode ---------- */
// Ctrl/Cmd+E switches between live preview and the plain Markdown source, like Obsidian's Source mode.
function setSource(on) {
  editor.setSource(on);
  localStorage.setItem('vault.mode', on ? 'source' : 'live');
}

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
const bytesB64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64bytes = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
const b64e = s => bytesB64(new TextEncoder().encode(s));
const b64d = s => new TextDecoder().decode(b64bytes(s));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// "folder/name (conflict 2026-10-17).ext", numbered when that name is taken.
function conflictPath(p, taken, today) {
  const ext = /\.[^./]+$/.exec(p)?.[0] || '', stem = p.slice(0, p.length - ext.length) + ` (conflict ${today}`;
  let cp = stem + ')' + ext, suffix = 2;
  while (taken.has(cp)) cp = stem + ' ' + suffix++ + ')' + ext;
  return cp;
}
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
    const remoteFiles = new Map(tree.tree
      .filter(t => t.type === 'blob' && IMAGE.test(t.path) && !t.path.split('/').some(s => s.startsWith('.')))
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
        const cp = conflictPath(p, notes, today);
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
    // pull images: bytes are stored encrypted first, then the vault records them in the same write as the notes
    let images = 0;
    await pool([...remoteFiles].filter(([p, sha]) => files.get(p)?.sha !== sha), 4, async ([p, sha]) => {
      const bytes = b64bytes((await gh('/git/blobs/' + sha)).content);
      const id = await Auth.store.putFile(bytes); Auth.ensure(epoch);
      const meta = { path: p, id, size: bytes.length, mtime: Date.now(), sha, dirty: false };
      const l = files.get(p);
      changed = true; images++;
      if (!l || !l.dirty) { files.set(p, meta); return; }
      const mine = await Auth.store.getFile(l.id); Auth.ensure(epoch);
      if (sameBytes(mine, bytes)) { l.sha = sha; l.dirty = false; return; }
      // Both sides changed the image: keep this device's copy and save the remote one beside it.
      const cp = conflictPath(p, files, today);
      files.set(cp, { ...meta, path: cp, sha: null, dirty: true }); l.sha = sha;
    });
    for (const l of [...files.values()]) {
      if (remoteFiles.has(l.path)) continue;
      if (l.sha && !l.dirty) { files.delete(l.path); changed = true; images++; }
      else if (l.sha) { l.sha = null; changed = true; }
    }
    // Persist everything pulled as one encrypted write instead of re-encrypting the vault per note.
    if (changed) { await DB.replace(); changed = false; }
    // push images before notes, so another device never syncs a note whose new image isn't uploaded yet
    let pushed = 0;
    for (const l of [...files.values()]) {
      if (!l.dirty && l.sha) continue;
      const sent = l.id, bytes = await Auth.store.getFile(sent); Auth.ensure(epoch);
      const body = { message: (l.sha ? 'Update ' : 'Add ') + l.path, content: bytesB64(bytes), branch: c.branch || 'main' };
      if (l.sha) body.sha = l.sha;
      const res = await gh('/contents/' + encPath(l.path), { method: 'PUT', body: JSON.stringify(body) });
      l.sha = res.content.sha; l.dirty = l.id !== sent; changed = true; pushed++;
    }
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
      if (images) editor.refresh();
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
  if (n.path !== cur || n.dirty || editor.text === n.content) return;
  editor.replace(n.content);
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
// Edit the space name in place (the GitHub folder keeps its name); Enter or blur saves, Escape cancels.
function renameSpace(folder, row) {
  Auth.ensure();
  const go = row.querySelector('.go');
  const input = Object.assign(document.createElement('input'), { value: spaceName(folder), className: 'go', maxLength: 60 });
  go.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const name = input.value.trim();
    try {
      if (save && name && name !== spaceName(folder)) await saveSpaces(spaceList.map(s => s.folder === folder ? { ...s, name, updated: Date.now() } : s));
    } catch (error) { if (Auth.active) $('#sp-err').textContent = error.message; }
    if (Auth.active) drawSpaces();
  };
  input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
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
    else if (e.target.closest('.ren')) renameSpace(folder, row);
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
// New note: create it with a placeholder name (e.g. "31.07.26 note 1") and put the cursor in the title to type over it.
$('#new').onclick = async () => {
  const d = new Date(), pad = x => String(x).padStart(2, '0');
  const day = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear() % 100)}`;
  let i = 1;
  while ([...notes.values()].some(n => !n.deleted && n.path.toLowerCase() === notePath(`${day} note ${i}`)?.toLowerCase())) i++;
  if (await createNote(`${day} note ${i}`)) $('#title').focus();
};
{
  // Click/tap the title to edit it in place; Enter or blur commits, Escape cancels.
  const t = $('#title');
  const show = () => { const n = notes.get(cur); t.textContent = n ? baseName(n.path) : ''; };
  t.contentEditable = 'plaintext-only'; t.spellcheck = false;
  t.onfocus = () => { const n = notes.get(cur); if (!n) return t.blur(); t.textContent = rel(n.path).replace(/\.md$/i, ''); getSelection().selectAllChildren(t); };
  t.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } else if (e.key === 'Escape') { t.dataset.cancel = '1'; t.blur(); } };
  t.onblur = async () => {
    const cancel = t.dataset.cancel; delete t.dataset.cancel;
    const to = t.textContent.trim();
    if (!cancel && to) { try { await renameNote(to); } catch (e) { console.error(e); } }
    if (cur) show();
  };
}
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
  else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); setSource(!editor.source); }
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

- Link notes with [[wikilinks]] — try [[Example Note]] (click it to create it)
- Type \`[[\` to autocomplete note names
- Markdown symbols only show where you're editing; **Ctrl/Cmd+E** shows the whole source
- Backlinks appear under the editor
- **Ctrl/Cmd+O** quick switcher · **Ctrl/Cmd+S** sync · **Alt+N** new note
- Use \`folder/name\` when creating a note to put it in a folder
- Set up sync with the ⚙ button

- [ ] Try a task item
`;
const App = {
  snapshot() { return { notes: structuredClone([...notes.values()]), files: structuredClone([...files.values()]), last: structuredClone(Auth.store.last) }; },
  clear() {
    clearTimeout(saveT); saveT = null; clearTimeout(syncT);
    notes.clear(); files.clear(); revokeImages(); cur = null; space = ''; rebuildIndex(); syncing = null;
    $('#space-name').textContent = ''; $('#sp-list').replaceChildren();
    editor.load(''); $('#list').replaceChildren();
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
    for (const file of await DB.files()) files.set(file.path, file);
    space = ''; rebuildIndex();
    // Older versions stored only the last note's path.
    const last = Auth.store.last, legacy = typeof last === 'string' ? last : null;
    if (legacy || !last) Auth.store.last = { space: '', notes: {} };
    if (![...notes.values()].some(isNote)) await createNote('Welcome', WELCOME);
    // Older versions stored edit, split or view; all of them now open in live preview.
    setSource(localStorage.getItem('vault.mode') === 'source');
    await switchSpace(legacy ? spaceOf(legacy) : last?.space || '', legacy || undefined);
    if (getCfg()) sync();
    else setStatus('Saved notes unlocked — offline or sign in in Settings to sync');
  },
  flush, sync
};
Auth.start(App, SYNC_URL);
