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
let index = { byPath: new Map(), byBase: new Map(), fileByPath: new Map(), fileByBase: new Map(), tags: new Map(), noteTags: new Map() };

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

// #tags as the editor finds them (see editor.js): not in code, and after a space, a bracket or the line start.
const TAGS = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
function tagsIn(content) {
  const text = content.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '').replace(/(`+)[^`]*?\1/g, '');
  return [...text.matchAll(TAGS)].map(m => m[2]);
}
// A search for #tag finds that tag and the tags nested under it (#tag/sub).
const hasTag = (path, tag) => [...index.noteTags.get(path) || []].some(t => t === tag || t.startsWith(tag + '/'));

function rebuildIndex() {
  loadSpaces();
  index = { byPath: new Map(), byBase: new Map(), fileByPath: new Map(), fileByBase: new Map(), tags: new Map(), noteTags: new Map() };
  for (const n of live().sort((a, b) => a.path.length - b.path.length)) {
    index.byPath.set(rel(n.path).toLowerCase(), n.path);
    const b = baseName(n.path).toLowerCase();
    if (!index.byBase.has(b)) index.byBase.set(b, n.path);
    const mine = new Set();
    for (const tag of tagsIn(n.content)) {
      const key = tag.toLowerCase();
      if (!index.tags.has(key)) index.tags.set(key, { name: tag, paths: new Set() });
      index.tags.get(key).paths.add(n.path); mine.add(key);
    }
    index.noteTags.set(n.path, mine);
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
    // Local Markdown images show the encrypted copy on this device; web images need explicit loading.
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
      const m = /^!\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m) return { type: 'embed', raw: m[0], target: m[1].trim(), heading: m[2]?.slice(1).trim(), text: (m[3] || '').trim() };
    },
    renderer(t) {
      if (!IMAGE.test(t.target)) return wikilinkHTML(t.target, t.text || t.target, t.heading);
      const p = resolveFile(t.target), { alt, size } = splitSize(t.text);
      return p ? imgTag(p, alt || fileName(t.target), size) : missingImg(t.target);
    }
  }, {
    name: 'wikilink', level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      const m = /^\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m && (m[1].trim() || m[2]?.slice(1).trim())) return { type: 'wikilink', raw: m[0], target: m[1].trim(), heading: m[2]?.slice(1).trim(), text: (m[3] || m[1] + (m[2] || '')).trim() };
    },
    renderer(t) { return wikilinkHTML(t.target, t.text, t.heading); }
  }]
});
function wikilinkHTML(target, text, heading) {
  const att = IMAGE.test(target) && resolveFile(target);
  if (att) return `<a class="wikilink" data-att="${esc(att)}">${esc(text)}</a>`;
  const ok = !target || resolve(target);
  return `<a class="wikilink${ok ? '' : ' missing'}" data-target="${esc(target)}"${heading ? ` data-heading="${esc(heading)}"` : ''}>${esc(text)}</a>`;
}
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    // Keep URLs inert through innerHTML insertion. Only protectImage may set a web image's src.
    const src = node.getAttribute('src');
    node.removeAttribute('src'); node.removeAttribute('srcset'); node.removeAttribute('data-vault-image');
    node.setAttribute('referrerpolicy', 'no-referrer');
    if (src) node.setAttribute('data-vault-image', src);
  }
});
function protectImage(img, value) {
  img.referrerPolicy = 'no-referrer';
  if (/^data:image\//i.test(value)) { img.src = value; return img; }
  let url;
  try { url = new URL(value, location.href); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    return Object.assign(document.createElement('span'), { className: 'att missing', textContent: 'Image blocked' });
  }
  const epoch = Auth.epoch;
  const button = Object.assign(document.createElement('button'), {
    type: 'button', className: 'remote-image', textContent: 'Load remote image',
    title: 'Loading shares your IP address with ' + url.hostname
  });
  if (img.alt) button.setAttribute('aria-label', 'Load remote image: ' + img.alt);
  // Do not select the image or enter a table cell instead of activating its privacy control.
  button.addEventListener('mousedown', event => event.stopPropagation());
  button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
  button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (!event.isTrusted || !Auth.active || Auth.epoch !== epoch || !Auth.checkIdle()) return;
    img.src = url.href; button.replaceWith(img);
  });
  return button;
}
// The editor renders most Markdown itself; marked draws the inside of table cells.
function renderInline(el, md) {
  // Restrict alternate image-loading paths in untrusted HTML (srcset, CSS, SVG and media).
  el.innerHTML = DOMPurify.sanitize(marked.parseInline(md), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ['input', 'picture', 'source', 'video', 'audio', 'style', 'link'],
    FORBID_ATTR: ['style', 'srcset', 'background']
  });
  for (const img of el.querySelectorAll('img[data-vault-image]')) {
    const src = img.dataset.vaultImage; delete img.dataset.vaultImage;
    img.replaceWith(protectImage(img, src));
  }
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
  const epoch = Auth.ensure();
  await Promise.all(versionWaits); Auth.ensure(epoch);
  await DB.replace();
}

/* ---------- trash and note history ---------- */
// Earlier versions and deleted notes stay on this device only, encrypted one record per version like images, and
// listed in the sealed vault as {id, path, time, size, hash, why, trashed}. GitHub retains synced revisions in Git history.
const KEEP_VERSIONS = 20, KEEP_MS = 30 * 86400000, VERSION_GAP = 5 * 60000;
const versionWaits = new Set();  // versions still being encrypted; saves wait for them
const versioned = new Map();     // path -> when this session last kept a version before an edit
async function digest(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash).subarray(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const latestVersion = path => Auth.store.history.reduce((a, v) => v.path === path && !v.trashed && (!a || v.time > a.time) ? v : a, null);
// Keep text as an earlier version of path, or as a deleted note in the trash. why: edit, sync, restore or delete.
function keepVersion(path, text, why, trashed = false) {
  if (path === SPACES || (!trashed && !text.trim())) return Promise.resolve();
  const epoch = Auth.ensure(), time = Date.now();
  const task = (async () => {
    const hash = await digest(text);
    if (!trashed && latestVersion(path)?.hash === hash) return;
    const id = await Auth.store.putVersion(text); Auth.ensure(epoch);
    Auth.store.history.push({ id, path, time, size: text.length, hash, why, trashed });
    pruneHistory();
  })();
  const settled = task.catch(() => {});
  versionWaits.add(settled); settled.then(() => versionWaits.delete(settled));
  return task;
}
// Before a note is edited, keep the text the edit replaces, at most once every five minutes.
function beforeEdit(n) {
  if (Date.now() - Math.max(versioned.get(n.path) || 0, latestVersion(n.path)?.time || 0) < VERSION_GAP) return;
  versioned.set(n.path, Date.now());
  keepVersion(n.path, n.content, 'edit').catch(error => { if (Auth.active) setStatus('Could not keep a version: ' + error.message, true); });
}
// Deleted notes, and history of notes that no longer exist, last 30 days; each note keeps its last 20 versions.
function pruneHistory() {
  const now = Date.now(), alive = new Set([...notes.values()].filter(isNote).map(n => n.path)), per = new Map();
  Auth.store.history = [...Auth.store.history].sort((a, b) => b.time - a.time).filter(v => {
    if (v.trashed || !alive.has(v.path)) { if (now - v.time >= KEEP_MS) return false; if (v.trashed) return true; }
    const count = (per.get(v.path) || 0) + 1; per.set(v.path, count);
    return count <= KEEP_VERSIONS;
  });
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
/* ---------- folder tree ---------- */
// Folders open in the sidebar, by full repository path. Saved with the encrypted vault, like the last note.
const expanded = new Set();
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const parentDirs = path => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
const noteRow = (n, extra = '') => `<div class="item${n.path === cur ? ' cur' : ''}" data-p="${esc(n.path)}">
      <div class="t">${esc(baseName(n.path))}${n.dirty ? ' •' : ''}</div>${extra}</div>`;
// Folders first, then notes, each sorted by name with numbers in order ("2" before "10"), like Obsidian.
function treeHTML(list) {
  const root = { dirs: new Map(), notes: [] };
  for (const n of list) {
    let node = root;
    for (const dir of parentDirs(n.path).filter(d => d.length > space.length)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), notes: [] });
      node = node.dirs.get(dir);
    }
    node.notes.push(n);
  }
  const html = node => [...node.dirs].sort(([a], [b]) => byName(fileName(a), fileName(b))).map(([dir, child]) => {
    const open = expanded.has(dir);
    return `<div class="dir${open ? ' open' : ''}" data-d="${esc(dir)}" role="button" tabindex="0" aria-expanded="${open}">
      <svg class="ic" aria-hidden="true"><use href="#i-chev"/></svg><span class="t">${esc(fileName(dir))}</span></div>` +
      (open ? `<div class="kids">${html(child)}</div>` : '');
  }).join('') + node.notes.sort((a, b) => byName(baseName(a.path), baseName(b.path))).map(n => noteRow(n)).join('');
  return html(root);
}
function saveFolders() {
  // Forget folders that no longer hold notes.
  const dirs = new Set([...notes.values()].filter(isNote).flatMap(n => parentDirs(n.path)));
  for (const d of expanded) if (!dirs.has(d)) expanded.delete(d);
  if (Auth.store.last && typeof Auth.store.last === 'object') Auth.store.last.folders = [...expanded];
}
function toggleFolder(dir, open = !expanded.has(dir)) {
  if (open) expanded.add(dir); else expanded.delete(dir);
  saveFolders(); renderList();
  $(`#list .dir[data-d="${CSS.escape(dir)}"]`)?.focus();
}
// Open the folders above a note so it shows in the tree.
function revealNote(path) { for (const d of parentDirs(path)) if (d.length > spaceOf(path).length) expanded.add(d); saveFolders(); }

function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  let arr = live();
  const snips = new Map();
  if (tokens.length) {
    arr = arr.filter(n => {
      const hay = (rel(n.path) + '\n' + n.content).toLowerCase();
      return tokens.every(t => /^#./.test(t) ? hasTag(n.path, t.slice(1)) : hay.includes(t));
    });
    arr.sort((a, b) => {
      const sa = tokens.every(t => baseName(a.path).toLowerCase().includes(t)) ? 0 : 1;
      const sb = tokens.every(t => baseName(b.path).toLowerCase().includes(t)) ? 0 : 1;
      return sa - sb || b.mtime - a.mtime;
    });
    arr = arr.slice(0, 100);
    arr.forEach(n => snips.set(n.path, snippet(n.content, tokens)));
  }
  // Searching lists matching notes flat with their folder; otherwise notes sit in a folder tree.
  $('#list').classList.toggle('tree', !tokens.length);
  $('#list').innerHTML = (tokens.length ? arr.map(n => {
    const r = rel(n.path), folder = r.includes('/') ? r.replace(/\/[^/]*$/, '') : '';
    return noteRow(n, `${folder ? `<div class="f">${esc(folder)}</div>` : ''}
      ${snips.get(n.path) ? `<div class="s">${snips.get(n.path)}</div>` : ''}`);
  }).join('') : treeHTML(arr)) || '<div class="item" style="color:var(--mute)">No notes</div>';
  renderTags(tokens);
  const open = live().reduce((sum, n) => sum + tasksOf(n.content).filter(t => !t.done).length, 0);
  $('#tasks-n').textContent = open; $('#tasks-n').hidden = !open;
  const inTrash = trashed().length;
  $('#trash-n').textContent = inTrash; $('#trash-n').hidden = !inTrash;
}

/* ---------- tags ---------- */
function renderTags(tokens = []) {
  const list = [...index.tags.values()].sort((a, b) => b.paths.size - a.paths.size || a.name.localeCompare(b.name));
  $('#tags-sum').textContent = `Tags (${list.length})`;
  $('#tag-list').innerHTML = list.map(t => `<button class="tag${tokens.includes('#' + t.name.toLowerCase()) ? ' on' : ''}" data-tag="${esc(t.name)}">#${esc(t.name)} <span class="n">${t.paths.size}</span></button>`).join('') ||
    '<div class="none">No tags yet. Type #tag in a note.</div>';
}
// Clicking a tag searches for it; clicking the tag being searched clears the search.
function searchTag(tag) {
  const q = '#' + tag;
  $('#q').value = $('#q').value.trim().toLowerCase() === q.toLowerCase() ? '' : q;
  renderList();
  document.body.classList.add('drawer');
}
$('#tag-list').addEventListener('click', e => { const b = e.target.closest('button[data-tag]'); if (b) searchTag(b.dataset.tag); });
$('#tags').addEventListener('toggle', () => { try { localStorage.setItem('vault.tags', $('#tags').open ? 'open' : ''); } catch {} });
try { $('#tags').open = localStorage.getItem('vault.tags') === 'open'; } catch {}

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
  Auth.store.last = { ...last, space, notes: { ...last.notes, [space]: path } };
  revealNote(path);
  editor.load(notes.get(path).content);
  scheduleOutline();
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
  for (const v of Auth.store.history) if (v.path === old && !v.trashed) v.path = p;
  // Persist the new note, old tombstone, rewritten links and moved history as one encrypted update.
  await DB.replace();
  rebuildIndex(); cur = null; await openNote(p); scheduleSync(15000);
}
async function deleteNote() {
  Auth.ensure();
  const n = notes.get(cur); if (!n) return;
  if (!confirm(`Move "${baseName(n.path)}" to the trash?`)) return;
  clearTimeout(saveT);
  await keepVersion(n.path, n.content, 'delete', true);
  if (n.sha) { n.deleted = true; await DB.put(n); } else { notes.delete(n.path); await DB.del(n.path); }
  rebuildIndex(); cur = null;
  const next = live().sort((a, b) => b.mtime - a.mtime)[0];
  if (next) await openNote(next.path); else await createNote('Untitled');
  scheduleSync(15000);
  setStatus(`Moved "${baseName(n.path)}" to the trash`);
}

/* ---------- editor ---------- */
// Live preview: Markdown is hidden except in the element being edited (see editor.js).
// [[Note]], [[Note#Heading]] or [[#Heading]] in the open note.
async function followLink(target, heading) {
  const p = target ? resolve(target) : cur;
  if (!p) { await createNote(target); return; }
  if (p !== cur) await openNote(p);
  if (heading && !gotoHeading(heading)) setStatus(`No heading "${heading}" in ${baseName(p)}`, true);
}
// Attachments open in an in-app viewer. A new tab would run scripts inside an SVG with Vault's origin; an <img> never does.
async function openAttachment(path) {
  const f = files.get(path); if (!f) return;
  const epoch = Auth.epoch, u = await attachmentURL(f);
  if (epoch !== Auth.epoch) return;
  const img = $('#dlg-img img'); img.src = u; img.alt = fileName(f.path);
  $('#dlg-img').showModal();
}
$('#dlg-img').addEventListener('click', () => $('#dlg-img').close());
$('#dlg-img').addEventListener('close', () => { $('#dlg-img img').removeAttribute('src'); });
const editor = LiveEditor.create($('#ed'), {
  change(text) { const n = notes.get(cur); if (!n) return; beforeEdit(n); n.content = text; touch(n); },
  cursor(typed) { if (typed) updateSug(); else hideSug(); scheduleOutline(); },
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
  follow: (target, heading) => followLink(target, heading).catch(error => { if (Auth.active) setStatus(error.message, true); }),
  openAttachment: path => openAttachment(path).catch(() => {}),
  imageURL(path) { const f = files.get(path); return f ? attachmentURL(f) : Promise.reject(new Error('Image not found')); },
  protectImage,
  resolveImage: target => resolveFile(target),
  noteExists: target => !!resolve(target),
  isImage: name => IMAGE.test(name),
  tag: tag => searchTag(tag),
  fileName, renderInline
});
$('#list').addEventListener('click', e => {
  const d = e.target.closest('.dir[data-d]'); if (d) { toggleFolder(d.dataset.d); return; }
  const i = e.target.closest('.item[data-p]'); if (i) openNote(i.dataset.p);
});
// Folder rows: Enter or Space toggles, right arrow opens, left arrow closes.
$('#list').addEventListener('keydown', e => {
  const d = e.target.closest('.dir[data-d]'); if (!d) return;
  const open = { Enter: undefined, ' ': undefined, ArrowRight: true, ArrowLeft: false };
  if (!(e.key in open)) return;
  e.preventDefault(); toggleFolder(d.dataset.d, open[e.key]);
});

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
    const bytes = img.type === 'image/svg+xml' ? cleanSVG(await img.text()) : new Uint8Array(await img.arrayBuffer());
    if (!bytes) { problems.push(`"${file.name}" isn't a valid SVG image`); continue; }
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
// Strip scripts, event handlers and external references from SVGs added on this device.
function cleanSVG(text) {
  const clean = DOMPurify.sanitize(text.replace(/^\uFEFF?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?/i, ''), { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['use'] }).trim();
  if (!/^<svg[\s>]/.test(clean)) return null;
  return new TextEncoder().encode(/^<svg[^>]*\sxmlns=/.test(clean) ? clean : clean.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"'));
}
const imagesIn = list => [...(list || [])].filter(f => f.type.startsWith('image/'));
function tryAdd(list, pasted) {
  addImages(list, pasted).catch(error => { if (Auth.active) setStatus('Could not add image: ' + error.message, true); });
}
$('#tbl').onclick = () => {
  const r = $('#tbl').getBoundingClientRect(), pos = editor.pos;
  TablePicker.open(r.left, r.bottom + 4, (rows, cols) => { editor.insertTable(rows, cols, pos); });
};
$('#img').onclick = () => $('#img-in').click();
$('#code').onclick = () => editor.insertCodeBlock();
$('#img-in').onchange = () => { const list = imagesIn($('#img-in').files); $('#img-in').value = ''; tryAdd(list, false); };
$('#bl-body').addEventListener('click', e => { const i = e.target.closest('.b[data-p]'); if (i) openNote(i.dataset.p); });
$('#q').addEventListener('input', renderList);

/* [[ autocomplete */
let sugItems = [], sugSel = 0, sugStart = -1, sugTag = false;
function hideSug() { $('#sug').style.display = 'none'; sugItems = []; }
function updateSug() {
  const pos = editor.pos, before = editor.lineBefore();
  const m = /\[\[([^\]\n|]*)$/.exec(before), t = !m && /(?:^|[\s(])#([\p{L}\p{N}_\-/]+)$/u.exec(before);
  const box = $('#sug');
  if (!m && !t) { hideSug(); return; }
  sugTag = !!t;
  sugStart = t ? pos - t[1].length - 1 : pos - m[1].length - 2;
  const q = (t || m)[1].toLowerCase();
  // After [[Note# suggest that note's headings ([[# the open note's), after # tags, after ![[ images, otherwise notes.
  const hm = m && /^([^#]*)#([^#]*)$/.exec(m[1]), of = hm && (hm[1].trim() ? resolve(hm[1]) : cur);
  sugItems = hm ? (of ? headingsOf(of === cur ? editor.text : notes.get(of).content).filter(h => h.text.toLowerCase().includes(hm[2].toLowerCase()))
      .slice(0, 8).map(h => hm[1] + '#' + h.text) : [])
    : t ? [...index.tags.values()].filter(x => x.name.toLowerCase().startsWith(q) && x.name.toLowerCase() !== q)
      .sort((a, b) => b.paths.size - a.paths.size).slice(0, 8).map(x => '#' + x.name)
    : before[before.length - m[0].length - 1] === '!'
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
  // Replace what was typed, and a ]] the editor already closed.
  const close = editor.text.slice(editor.pos, editor.pos + 2) === ']]' ? 2 : 0;
  editor.insert(sugTag ? name + ' ' : '[[' + name + ']]', sugStart, editor.pos + (sugTag ? 0 : close));
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

/* ---------- outline ---------- */
// Headings of a note: ATX headings outside code blocks, as {level, text, pos}.
function headingsOf(content) {
  const out = []; let fence = null, pos = 0;
  for (const line of content.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f && (!fence || f[1][0] === fence[0] && f[1].length >= fence.length)) fence = fence ? null : f[1];
    else if (!fence) {
      const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (m && m[2]) out.push({ level: m[1].length, text: m[2], pos });
    }
    pos += line.length + 1;
  }
  return out;
}
const sameHeading = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function gotoHeading(heading) {
  const h = headingsOf(editor.text).find(x => sameHeading(x.text, heading));
  if (h) editor.goto(h.pos);
  return !!h;
}
let outlineT = 0;
const scheduleOutline = () => { if (!outlineT && document.body.classList.contains('outline')) outlineT = requestAnimationFrame(renderOutline); };
function renderOutline() {
  outlineT = 0;
  const hs = headingsOf(editor.text), top = Math.min(...hs.map(h => h.level)), at = editor.pos;
  const here = hs.reduce((a, h, i) => h.pos <= at ? i : a, -1);
  $('#ol-list').innerHTML = hs.map((h, i) => `<div class="${i === here ? 'cur' : ''}" data-i="${i}" style="padding-left:${(h.level - top) * 12 + 8}px">${esc(h.text)}</div>`).join('') ||
    '<div class="none">No headings in this note.</div>';
}
function toggleOutline(on = !document.body.classList.contains('outline')) {
  document.body.classList.toggle('outline', on);
  try { localStorage.setItem('vault.outline', on && innerWidth > 800 ? 'open' : ''); } catch {}
  if (on) renderOutline();
}
$('#ol-btn').onclick = () => toggleOutline();
$('#ol-close').onclick = () => toggleOutline(false);
$('#ol-list').addEventListener('click', e => {
  const d = e.target.closest('div[data-i]'); if (!d) return;
  const h = headingsOf(editor.text)[+d.dataset.i];
  if (h) editor.goto(h.pos);
  if (innerWidth <= 800) toggleOutline(false);
});

/* ---------- tasks ---------- */
// Task list items (- [ ] and - [x]) outside code blocks, as {done, text, pos}; pos is the [ ] box's offset.
function tasksOf(content) {
  const out = []; let fence = null, pos = 0;
  for (const line of content.split('\n')) {
    const f = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(line);
    if (f && (!fence || f[1][0] === fence[0] && f[1].length >= fence.length)) fence = fence ? null : f[1];
    else if (!fence) {
      const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?:\s+(.*))?$/.exec(line);
      if (m) out.push({ done: m[2] !== ' ', text: (m[3] || '').trim(), pos: pos + m[1].length });
    }
    pos += line.length + 1;
  }
  return out;
}
let taskRows = [];
function drawTasks() {
  const done = $('#tk-done').checked, groups = [];
  taskRows = [];
  for (const n of live().sort((a, b) => b.mtime - a.mtime)) {
    const list = tasksOf(n.path === cur ? editor.text : n.content).filter(t => done || !t.done);
    if (list.length) groups.push([n, list]);
  }
  const open = live().reduce((sum, n) => sum + tasksOf(n.content).filter(t => !t.done).length, 0);
  $('#tk-sum').textContent = open + ' open task' + (open === 1 ? '' : 's');
  $('#tk-list').innerHTML = groups.map(([n, list]) => `<div class="g">${esc(rel(n.path).replace(/\.md$/i, ''))}</div>` + list.map(t => {
    const i = taskRows.push({ path: n.path, ...t }) - 1;
    return `<label class="t${t.done ? ' done' : ''}" data-i="${i}"><input type="checkbox"${t.done ? ' checked' : ''}><span>${esc(t.text) || '&nbsp;'}</span></label>`;
  }).join('')).join('') || `<div class="none">${done ? 'No tasks yet. Start a line with - [ ] to add one.' : 'No open tasks.'}</div>`;
}
function openTasks() {
  Auth.ensure();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  drawTasks(); $('#dlg-tasks').showModal();
}
// Tick or untick a task where it is now; in the open note this is an undoable edit.
function toggleTask(row) {
  const n = notes.get(row.path); if (!n) return;
  const text = row.path === cur ? editor.text : n.content;
  const t = tasksOf(text).find(x => x.pos === row.pos && x.text === row.text) || tasksOf(text).find(x => x.text === row.text && x.done === row.done);
  if (!t) return;
  const mark = t.done ? ' ' : 'x';
  if (row.path === cur) editor.view.dispatch({ changes: { from: t.pos + 1, to: t.pos + 2, insert: mark }, userEvent: 'input' });
  else { beforeEdit(n); n.content = text.slice(0, t.pos + 1) + mark + text.slice(t.pos + 2); touch(n); }
}
$('#tk-list').addEventListener('click', async e => {
  const row = e.target.closest('label[data-i]'); if (!row) return;
  e.preventDefault();
  const task = taskRows[+row.dataset.i];
  if (e.target.matches('input')) { toggleTask(task); drawTasks(); return; }
  // Clicking the text opens the note at the task.
  $('#dlg-tasks').close();
  if (task.path !== cur) await openNote(task.path);
  const t = tasksOf(editor.text).find(x => x.text === task.text);
  if (t) editor.goto(t.pos);
});
$('#tk-done').onchange = drawTasks;
$('#tk-close').onclick = () => $('#dlg-tasks').close();
$('#dlg-tasks').addEventListener('click', e => { if (e.target === $('#dlg-tasks')) $('#dlg-tasks').close(); });
$('#tasks').onclick = openTasks;

/* ---------- trash and history dialog ---------- */
let histTrash = false, histItems = [], histSel = 0;
const when = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const size = n => n < 1000 ? n + ' characters' : (n / 1000).toFixed(1) + 'k characters';
const WHY = { edit: 'Before editing', sync: 'Before a synced change', restore: 'Before restoring an older version' };
const trashed = () => Auth.store.history.filter(v => v.trashed && spaceOf(v.path) === space);
function openHistory(trash) {
  Auth.ensure();
  if (!trash && !cur) return;
  histTrash = trash; histSel = 0; $('#h-err').textContent = '';
  drawHistory();
  if (!$('#dlg-hist').open) $('#dlg-hist').showModal();
}
function drawHistory() {
  histItems = (histTrash ? trashed() : Auth.store.history.filter(v => !v.trashed && v.path === cur)).sort((a, b) => b.time - a.time);
  histSel = Math.max(0, Math.min(histSel, histItems.length - 1));
  $('#h-title').textContent = histTrash ? 'Trash' : 'History: ' + baseName(cur);
  $('#h-hint').textContent = histTrash ? 'Deleted notes stay here for 30 days, encrypted on this device.'
    : 'Earlier versions of this note, kept encrypted on this device. Each note keeps its last 20.';
  $('#h-list').innerHTML = histItems.map((v, i) => `<div class="${i === histSel ? 'sel' : ''}" data-i="${i}">
      <div>${esc(histTrash ? rel(v.path).replace(/\.md$/i, '') : when(v.time))}</div>
      <div class="m">${esc(histTrash ? (v.why === 'sync' ? 'Deleted on another device, ' : 'Deleted ') + when(v.time) : WHY[v.why] || '')} · ${size(v.size)}</div></div>`).join('') ||
    `<div class="none">${histTrash ? 'The trash is empty.' : 'No earlier versions yet. Vault keeps one before you edit, at most every five minutes, and before sync replaces the text.'}</div>`;
  $('#h-restore').disabled = !histItems.length;
  $('#h-forget').hidden = $('#h-empty').hidden = !histTrash;
  $('#h-forget').disabled = $('#h-empty').disabled = !histItems.length;
  showVersion();
}
async function showVersion() {
  const v = histItems[histSel], view = $('#h-view'), epoch = Auth.epoch;
  view.textContent = ''; view.hidden = !v;
  if (!v) return;
  try {
    const text = await Auth.store.getVersion(v.id);
    if (epoch === Auth.epoch && histItems[histSel] === v) view.textContent = text;
  } catch (error) { if (Auth.active) $('#h-err').textContent = error.message; }
}
// Put an earlier version back as an ordinary, undoable edit, keeping the current text as a version first.
async function restoreVersion(v) {
  const epoch = Auth.ensure(), n = notes.get(cur);
  if (!n || v.path !== cur) return;
  const text = await Auth.store.getVersion(v.id); Auth.ensure(epoch);
  if (text !== n.content) {
    await keepVersion(n.path, n.content, 'restore');
    editor.insert(text, 0, editor.text.length);
  }
  setStatus('Restored the version from ' + when(v.time));
}
// Bring a deleted note back under its old name, or beside a note that has taken it.
async function restoreTrashed(v) {
  const epoch = Auth.ensure();
  const text = await Auth.store.getVersion(v.id); Auth.ensure(epoch);
  await flush(); Auth.ensure(epoch);
  const taken = p => [...notes.values()].some(n => isNote(n) && n.path.toLowerCase() === p.toLowerCase());
  let p = v.path;
  for (let i = 1; taken(p); i++) p = v.path.replace(/\.md$/i, ` (restored${i > 1 ? ' ' + i : ''}).md`);
  const old = notes.get(p);  // a delete that hasn't synced yet
  if (old) Object.assign(old, { content: text, mtime: Date.now(), dirty: true, deleted: false });
  else notes.set(p, { path: p, content: text, mtime: Date.now(), sha: null, dirty: true });
  Auth.store.history = Auth.store.history.filter(x => x !== v);
  await DB.replace(); Auth.ensure(epoch);
  rebuildIndex(); cur = null; await openNote(p); scheduleSync(15000);
  setStatus(`Restored "${baseName(p)}" from the trash`);
}
async function forget(list) {
  const epoch = Auth.ensure(), drop = new Set(list);
  Auth.store.history = Auth.store.history.filter(v => !drop.has(v));
  await DB.replace(); Auth.ensure(epoch);
  renderList();
}
$('#hist').onclick = () => openHistory(false);
$('#trash').onclick = () => openHistory(true);
$('#h-close').onclick = () => $('#dlg-hist').close();
$('#dlg-hist').addEventListener('click', e => { if (e.target === $('#dlg-hist')) $('#dlg-hist').close(); });
$('#h-list').addEventListener('click', e => {
  const d = e.target.closest('div[data-i]'); if (!d) return;
  histSel = +d.dataset.i;
  for (const row of $('#h-list').children) row.classList.toggle('sel', row === d);
  showVersion();
});
const histAction = run => async () => {
  const v = histItems[histSel];
  $('#h-err').textContent = '';
  try { await run(v); } catch (error) { if (Auth.active) $('#h-err').textContent = error.message; }
};
$('#h-restore').onclick = histAction(async v => {
  if (!v) return;
  $('#dlg-hist').close();
  if (histTrash) await restoreTrashed(v); else await restoreVersion(v);
});
$('#h-forget').onclick = histAction(async v => {
  if (!v || !confirm(`Delete "${baseName(v.path)}" forever?`)) return;
  await forget([v]); drawHistory();
});
$('#h-empty').onclick = histAction(async () => {
  const list = trashed();
  if (!list.length || !confirm(`Delete ${list.length} note${list.length > 1 ? 's' : ''} in the trash forever?`)) return;
  await forget(list); drawHistory();
});

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

/* ---------- daily notes and templates ---------- */
// Today's note is Daily/YYYY-MM-DD in the current space, made from Templates/Daily if that note exists.
// Templates are the notes in Templates/; {{title}}, {{date}}, {{time}} and {{date:YYYY-MM-DD HH:mm}} fill in.
const DAILY = 'Daily', TEMPLATES = 'Templates';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function formatDate(d, format) {
  const pad = x => String(x).padStart(2, '0');
  const parts = { YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1), M: d.getMonth() + 1, DD: pad(d.getDate()), D: d.getDate(), dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()), H: d.getHours(), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, t => parts[t]);
}
function fillTemplate(text, title, d = new Date()) {
  return text.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi, (m, key, format) => {
    key = key.toLowerCase();
    if (key === 'title') return title;
    return formatDate(d, format?.trim() || (key === 'date' ? 'YYYY-MM-DD' : 'HH:mm'));
  });
}
const templates = () => live().filter(n => rel(n.path).toLowerCase().startsWith(TEMPLATES.toLowerCase() + '/')).sort((a, b) => rel(a.path).localeCompare(rel(b.path)));
async function openToday() {
  Auth.ensure();
  const d = new Date(), day = formatDate(d, 'YYYY-MM-DD'), p = resolve(DAILY + '/' + day);
  if (p && rel(p).toLowerCase() === (DAILY + '/' + day + '.md').toLowerCase()) { await openNote(p); return; }
  const template = notes.get(resolve(TEMPLATES + '/Daily') || '');
  const fromTemplate = template && rel(template.path).toLowerCase() === (TEMPLATES + '/daily.md').toLowerCase();
  await createNote(DAILY + '/' + day, fromTemplate ? fillTemplate(template.content, day, d) || '\n' : `# ${day}\n\n`);
}
// A placeholder name for a new note (e.g. "31.07.26 note 1"), to type over in the title.
function untitled(folder = '') {
  const day = formatDate(new Date(), 'DD.MM.YY'), dir = folder ? folder + '/' : '';
  let i = 1;
  while ([...notes.values()].some(n => !n.deleted && n.path.toLowerCase() === notePath(`${dir}${day} note ${i}`)?.toLowerCase())) i++;
  return `${dir}${day} note ${i}`;
}
function pickTemplate(use) {
  openCommands(templates().map(n => ({ name: rel(n.path).slice(TEMPLATES.length + 1).replace(/\.md$/i, ''), run: () => use(n) })),
    'Pick a template…', `No templates yet. Notes in the ${TEMPLATES} folder appear here.`);
}
const newFromTemplate = () => pickTemplate(async t => {
  const name = untitled();
  if (await createNote(name, fillTemplate(t.content, name) || '\n')) $('#title').focus();
});
const insertTemplate = () => pickTemplate(t => {
  const n = notes.get(cur); if (!n) return;
  editor.focus(); editor.insert(fillTemplate(t.content, baseName(n.path)));
});

/* ---------- command palette ---------- */
// Ctrl/Cmd+P lists every action. Features add theirs with command(name, run, keys); when shows it only where it applies.
const commands = [];
const command = (name, run, keys = '', when = () => true) => commands.push({ name, run, keys, when });
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
let cmdSel = 0, cmdRes = [], cmdItems = null;  // cmdItems: a list to pick from instead of the commands
function recentCommands() { try { return JSON.parse(localStorage.getItem('vault.commands') || '[]'); } catch { return []; } }
function drawCmd() {
  const q = $('#cmd-in').value.trim().toLowerCase(), recent = recentCommands();
  const rank = c => { const i = recent.indexOf(c.name); return i < 0 ? recent.length : i; };
  const all = cmdItems || commands.filter(c => c.when());
  cmdRes = q ? all.map(c => ({ c, s: fuzzy(c.name, q) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || rank(a.c) - rank(b.c)).map(x => x.c)
    : all.sort((a, b) => rank(a) - rank(b));
  cmdSel = Math.max(0, Math.min(cmdSel, cmdRes.length - 1));
  $('#cmd-list').innerHTML = cmdRes.map((c, i) => `<div class="${i === cmdSel ? 'sel' : ''}" data-i="${i}">${esc(c.name)}` +
    (c.keys ? `<kbd>${esc(c.keys.replace('Mod', MOD))}</kbd>` : '') + '</div>').join('') ||
    `<div class="none">${cmdItems ? cmdEmpty : 'No matching commands'}</div>`;
  $('#cmd-list .sel')?.scrollIntoView({ block: 'nearest' });
}
async function cmdGo(i) {
  const c = cmdRes[i]; if (!c) return;
  $('#dlg-cmd').close();
  if (!cmdItems) try { localStorage.setItem('vault.commands', JSON.stringify([c.name, ...recentCommands().filter(n => n !== c.name)].slice(0, 20))); } catch {}
  try { await c.run(); } catch (error) { if (Auth.active) setStatus(error.message, true); }
}
let cmdEmpty = '';
// Without items it lists the commands; with items [{name, run}] it picks one of them (templates, for instance).
function openCommands(items = null, hint = 'Type a command…', empty = '') {
  Auth.ensure();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  cmdItems = items; cmdEmpty = empty;
  $('#cmd-in').value = ''; $('#cmd-in').placeholder = hint; cmdSel = 0; drawCmd(); $('#dlg-cmd').showModal(); $('#cmd-in').focus();
}
$('#cmd-in').addEventListener('input', () => { cmdSel = 0; drawCmd(); });
$('#cmd-in').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdSel = Math.min(cmdSel + 1, cmdRes.length - 1); drawCmd(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdSel = Math.max(cmdSel - 1, 0); drawCmd(); }
  else if (e.key === 'Enter') { e.preventDefault(); cmdGo(cmdSel); }
});
$('#cmd-list').addEventListener('click', e => { const d = e.target.closest('div[data-i]'); if (d) cmdGo(+d.dataset.i); });
$('#dlg-cmd').addEventListener('click', e => { if (e.target === $('#dlg-cmd')) $('#dlg-cmd').close(); });

/* ---------- end-to-end encrypted sync ---------- */
const getCfg = () => Auth.session;
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function conflictPath(p, taken, today) {
  const ext = /\.[^./]+$/.exec(p)?.[0] || '', stem = p.slice(0, p.length - ext.length) + ` (conflict ${today}`;
  let cp = stem + ')' + ext, suffix = 2;
  while (taken.has(cp)) cp = stem + ' ' + suffix++ + ')' + ext;
  return cp;
}
function setStatus(t, err) { if (!Auth.active) return; const s = $('#status'); s.textContent = t; s.classList.toggle('err', !!err); }
function scheduleSync(ms) { if (!getCfg()) return; clearTimeout(syncT); syncT = setTimeout(sync, ms); }
let syncing = null, syncPromise = null;
async function sync(options = {}) {
  if (!Auth.active || !Auth.checkIdle() || Auth.changing) return;
  const epoch = Auth.epoch;
  if (!Auth.cloud || !Auth.session) {
    const error = new Error('Saved notes unlocked. Sign in in Settings to sync.'); setStatus(error.message);
    if (options.strict) throw error; return;
  }
  if (syncing === epoch) {
    try { await syncPromise; } catch (e) { if (options.strict) throw e; } return;
  }
  syncing = epoch; clearTimeout(syncT); setStatus('Syncing encrypted notes…');
  syncPromise = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await encryptedSync(epoch); return; }
      catch (e) { if (e.status !== 409 || attempt === 2) throw e; }
    }
  })();
  try { await syncPromise; }
  catch (e) { if (epoch === Auth.epoch) setStatus('Sync failed: ' + e.message, true); if (options.strict) throw e; }
  finally { if (syncing === epoch) { syncing = null; syncPromise = null; } }
}
async function encryptedSync(epoch) {
  await flush(); Auth.ensure(epoch);
  const cloud = Auth.cloud, base = await cloud.load(); Auth.ensure(epoch);
  const remote = new Map(base.manifest.entries.map(e => [e.path, e]));
  const today = new Date().toISOString().slice(0, 10), pulled = new Map();
  // Validate every changed remote record before applying any of them to the editor.
  await pool(base.manifest.entries.filter(e => !e.deleted && (e.kind === 'note' ? notes : files).get(e.path)?.sha !== e.ref.revisionId), 2, async e => {
    const bytes = await cloud.read(e.ref); Auth.ensure(epoch);
    if (e.kind === 'note') pulled.set(e.path, { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    else { const id = await Auth.store.putFile(bytes); Auth.ensure(epoch); pulled.set(e.path, { id, size: bytes.length }); }
  });
  let images = false;
  for (const e of base.manifest.entries) {
    const map = e.kind === 'note' ? notes : files, old = map.get(e.path), incoming = pulled.get(e.path);
    if (e.deleted) {
      if (!old) continue;
      if (old.dirty && !old.deleted) {
        // An intentional new/restored note may reuse a deleted path; stale edited copies become conflicts.
        if (!old.sha) continue;
        const cp = conflictPath(e.path, map, today);
        map.set(cp, { ...old, path: cp, sha: null, dirty: true });
        if (cur === e.path) cur = cp;
      }
      if (e.kind === 'note' && !old.deleted) await keepVersion(e.path, old.content, 'sync', true);
      map.delete(e.path); images ||= e.kind === 'file'; continue;
    }
    if (!incoming) continue;
    if (e.kind === 'note') {
      const text = incoming.text;
      if (!old) notes.set(e.path, { path: e.path, content: text, sha: e.ref.revisionId, dirty: false, mtime: e.mtime });
      else if (old.deleted) {
        // A remote edit made after the local delete must survive.
        Object.assign(old, { content: text, sha: e.ref.revisionId, deleted: false, dirty: false, mtime: e.mtime });
      } else if (!old.dirty) {
        if (old.content !== text) await keepVersion(e.path, old.content, 'sync');
        Object.assign(old, { content: text, sha: e.ref.revisionId, mtime: e.mtime }); showPulled(old);
      } else if (e.path === SPACES) {
        old.content = mergeSpaces(old.content, text); old.sha = e.ref.revisionId; old.dirty = old.content !== text;
      } else if (old.content !== text) {
        const cp = conflictPath(e.path, notes, today);
        notes.set(cp, { path: cp, content: text, sha: null, dirty: true, mtime: e.mtime }); old.sha = e.ref.revisionId;
      } else { old.sha = e.ref.revisionId; old.dirty = false; }
    } else {
      const meta = { path: e.path, ...incoming, sha: e.ref.revisionId, dirty: false, mtime: e.mtime };
      if (!old || !old.dirty) files.set(e.path, meta);
      else {
        const mine = await Auth.store.getFile(old.id), theirs = await Auth.store.getFile(incoming.id); Auth.ensure(epoch);
        if (sameBytes(mine, theirs)) { old.sha = e.ref.revisionId; old.dirty = false; }
        else { const cp = conflictPath(e.path, files, today); files.set(cp, { ...meta, path: cp, sha: null, dirty: true }); old.sha = e.ref.revisionId; }
      }
      images = true;
    }
  }
  Auth.ensure(epoch);
  Auth.store.cloud.checkpoint = base; cloud.checkpoint = base;
  await DB.replace();
  const staged = [], entries = new Map(remote);
  // Attachments are prepared before notes; the head only publishes after all records exist.
  for (const [kind, map] of [['file', files], ['note', notes]]) for (const item of [...map.values()]) {
    const previous = entries.get(item.path);
    if (previous && previous.kind !== kind) throw new Error('A note and attachment have conflicting paths.');
    if (item.deleted) {
      if (previous && !previous.deleted) {
        entries.set(item.path, { ...previous, deleted: true, mtime: item.mtime }); staged.push({ map, item, deleted: true });
      }
      continue;
    }
    if (!item.dirty && item.sha) continue;
    const sent = kind === 'note' ? item.content : item.id;
    const data = kind === 'note' ? sent : await Auth.store.getFile(sent); Auth.ensure(epoch);
    const ref = await cloud.upload(kind, data, previous?.ref.objectId); Auth.ensure(epoch);
    entries.set(item.path, { path: item.path, kind, deleted: false, mtime: item.mtime, ref });
    staged.push({ map, item, sent, ref, kind });
  }
  let checkpoint = base;
  if (staged.length) checkpoint = await cloud.publish(base, [...entries.values()]);
  Auth.ensure(epoch);
  // A conditional head write confirms publication before any draft is marked clean.
  Auth.store.cloud.checkpoint = checkpoint; cloud.checkpoint = checkpoint;
  for (const s of staged) {
    if (s.map.get(s.item.path) !== s.item) continue;
    if (s.deleted) { if (s.item.deleted) s.map.delete(s.item.path); }
    else { s.item.sha = s.ref.revisionId; s.item.dirty = s.kind === 'note' ? s.item.content !== s.sent : s.item.id !== s.sent; }
  }
  await DB.replace(); Auth.ensure(epoch);
  rebuildIndex();
  if (!cur || !notes.has(cur) || notes.get(cur).deleted) {
    if (!activeSpaces().some(s => s.folder === space)) { space = ''; rebuildIndex(); }
    const next = live().sort((a, b) => b.mtime - a.mtime)[0]; cur = null; if (next) await openNote(next.path);
  } else {
    if (spaceOf(cur) !== space) { space = spaceOf(cur); rebuildIndex(); }
    showPulled(notes.get(cur)); if (images) editor.refresh();
  }
  renderSpace(); renderList(); renderBacklinks();
  setStatus('Encrypted sync ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
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
  if (inFolder.length && !confirm(`${inFolder.length} note${inFolder.length > 1 ? 's' : ''} in "${folder}/" will move into this space. Note contents are kept.`)) return;
  await saveSpaces([...spaceList.filter(s => s.folder.toLowerCase() !== key), { folder, name, updated: Date.now() }]);
  $('#dlg-spaces').close();
  await switchSpace(folder);
}
// Edit the space name in place (the logical folder keeps its name); Enter or blur saves, Escape cancels.
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
  if (!confirm(`Remove the "${spaceName(folder)}" space? No notes are deleted: they appear in Main as the "${folder}" folder.`)) return;
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
  $('#c-pw').value = ''; $('#c-err').textContent = '';
  $('#dlg-cfg').showModal();
};
$('#c-cancel').onclick = () => $('#dlg-cfg').close();
$('#c-clear').onclick = () => Auth.lock('Signed out. Enter your password to unlock.');
$('#lock').onclick = () => Auth.lock();
$('#c-save').onclick = async () => {
  const button = $('#c-save'); button.disabled = true;
  try {
    await Auth.connect($('#c-url').value, null, $('#c-pw').value);
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
    if (Auth.active) { $('#dlg-password').close(); setStatus('Password, vault keys and recovery key updated.'); }
  } catch (error) { if (Auth.active) $('#change-error').textContent = error.message; }
  finally { $('#old-password').value = ''; $('#new-password').value = ''; $('#change-save').disabled = false; }
};

/* ---------- toolbar / shortcuts ---------- */
// New note: create it with a placeholder name and put the cursor in the title to type over it.
$('#new').onclick = async () => { if (await createNote(untitled())) $('#title').focus(); };
// contextmenu.js loads after this file.
addEventListener('DOMContentLoaded', () => ContextMenu.provide('folder', ctx => [
  { label: 'New note in this folder', run: async () => { if (await createNote(untitled(space ? ctx.path.slice(space.length + 1) : ctx.path))) $('#title').focus(); } },
  { label: expanded.has(ctx.path) ? 'Collapse' : 'Expand', run: () => toggleFolder(ctx.path) }
]));
$('#today').onclick = () => openToday();
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
$('#cmd').onclick = () => openCommands();
{
  const hasNote = () => !!cur, today = () => new Date().toLocaleDateString('en-CA');
  command('New note', () => $('#new').click(), 'Alt+N');
  command("Open today's note", openToday, 'Alt+D');
  command('New note from template…', newFromTemplate);
  command('Insert template…', insertTemplate, '', hasNote);
  command('Open note…', openSwitcher, 'Mod+O');
  command('Search notes', () => { document.body.classList.add('drawer'); $('#q').focus(); }, 'Mod+Shift+F');
  command('Switch space…', openSpaces, 'Mod+Shift+O');
  command('Rename note', () => $('#title').focus(), '', hasNote);
  command('Move note to trash', deleteNote, '', hasNote);
  command('Show note history', () => openHistory(false), '', hasNote);
  command('Open trash', () => openHistory(true));
  command('Toggle outline', () => toggleOutline(), '', hasNote);
  command('Show tasks', openTasks);
  command('Show tags', () => { document.body.classList.add('drawer'); $('#tags').open = true; $('#tag-list button')?.focus(); });
  command('Insert table…', () => $('#tbl').click(), '', hasNote);
  command('Insert image…', () => $('#img').click(), '', hasNote);
  command('Insert code block', () => editor.insertCodeBlock(), '', hasNote);
  // Turns the current line (or list item) into a task, like Obsidian's "Toggle checklist".
  command('Insert checkbox', () => {
    const v = editor.view, line = v.state.doc.lineAt(editor.pos), m = /^(\s*)(?:[-*+] (?:\[[ xX]\] )?)?/.exec(line.text);
    v.dispatch({ changes: { from: line.from, to: line.from + m[0].length, insert: m[1] + '- [ ] ' }, selection: { anchor: line.to + m[1].length + 6 - m[0].length }, userEvent: 'input' });
    editor.focus();
  }, '', hasNote);
  command("Insert today's date", () => { editor.focus(); editor.insert(today()); }, '', hasNote);
  command('Toggle live preview and source', () => setSource(!editor.source), 'Mod+E', hasNote);
  command('Sync now', sync, 'Mod+S');
  command('Sync settings', () => $('#cfg').click());
  command('Lock Vault', () => Auth.lock());
}
$('#sync').onclick = sync;
$('#switch').onclick = openSwitcher;
$('#menu').onclick = () => document.body.classList.toggle('drawer');
{
  // Gear menu for rarely used actions. Each item keeps its own click handler; picking one closes the menu first.
  const gear = $('#gear'), box = $('#gear-menu'), items = () => [...box.querySelectorAll('button:not(:disabled)')];
  for (const k of box.querySelectorAll('kbd')) k.textContent = k.textContent.replace('Ctrl', MOD);
  const close = (refocus) => {
    if (box.hidden) return;
    box.hidden = true; gear.setAttribute('aria-expanded', 'false');
    if (refocus) gear.focus();
  };
  // Only a keyboard opening moves focus into the menu, so a tap doesn't show the first item as highlighted.
  const open = (keyboard) => {
    $('#hist').disabled = $('#del').disabled = !cur;
    box.hidden = false; gear.setAttribute('aria-expanded', 'true');
    if (keyboard) items()[0]?.focus({ preventScroll: true });
  };
  gear.onclick = e => box.hidden ? open(e.detail === 0) : close(true);
  box.addEventListener('click', e => { if (e.target.closest('button')) close(false); }, true);
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#gear-wrap')) close(false); }, true);
  $('#gear-wrap').addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key === 'Tab') { close(false); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = items(), i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
  });
}
$('#back').onclick = () => document.body.classList.remove('drawer');
document.addEventListener('keydown', e => {
  if (!Auth.active) return;
  Auth.ensure();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); if (!$('#dlg-cmd').open) openCommands(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openSpaces(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openSwitcher(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); sync(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); document.body.classList.add('drawer'); $('#q').focus(); }
  else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); setSource(!editor.source); }
  else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); $('#new').click(); }
  else if (e.altKey && e.code === 'KeyD') { e.preventDefault(); openToday(); }
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

Your notes are encrypted on this device and end-to-end encrypted before syncing to your private GitHub repository.

- Link notes with [[wikilinks]] — try [[Example Note]] (click it to create it)
- Type \`[[\` to autocomplete note names
- Markdown symbols only show where you're editing; **Ctrl/Cmd+E** shows the whole source
- Backlinks appear under the editor; link to a heading with [[Note#Heading]], and ≡ shows the note's outline
- **Alt+D** or 📅 opens today's note in \`Daily/\`; notes in \`Templates/\` become templates
- **Ctrl/Cmd+P** every command · **Ctrl/Cmd+O** quick switcher · **Ctrl/Cmd+S** sync · **Alt+N** new note
- Use \`folder/name\` when creating a note to put it in a folder
- **Tasks** in the sidebar collects open \`- [ ]\` items from every note
- Add #tags anywhere; click one, or pick it under Tags in the sidebar, to see every note with it
- Set up sync from the ⚙ menu (Sync settings)

- [ ] Try a task item
`;
const App = {
  snapshot() {
    return { notes: structuredClone([...notes.values()]), files: structuredClone([...files.values()]),
      history: structuredClone(Auth.store.history), last: structuredClone(Auth.store.last) };
  },
  clear() {
    clearTimeout(saveT); saveT = null; clearTimeout(syncT);
    notes.clear(); files.clear(); expanded.clear(); revokeImages(); cur = null; space = ''; rebuildIndex(); syncing = null;
    $('#space-name').textContent = ''; $('#sp-list').replaceChildren();
    editor.load(''); $('#list').replaceChildren();
    $('#title').textContent = ''; document.title = 'Vault — Locked';
    $('#bl-body').replaceChildren(); $('#bl-sum').textContent = 'Backlinks';
    $('#tag-list').replaceChildren(); $('#ol-list').replaceChildren(); $('#tags-sum').textContent = 'Tags';
    $('#q').value = ''; $('#qs-in').value = ''; $('#qs-list').replaceChildren(); $('#cmd-in').value = ''; $('#cmd-list').replaceChildren(); cmdRes = [];
    $('#sug').replaceChildren(); $('#sug').style.display = 'none';
    qsRes = []; sugItems = []; sugStart = -1;
    versioned.clear(); histItems = []; $('#h-list').replaceChildren(); $('#h-view').textContent = ''; $('#trash-n').hidden = $('#tasks-n').hidden = true; $('#tk-list').replaceChildren(); taskRows = [];
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    for (const input of document.querySelectorAll('input[type=password]')) input.value = '';
    $('#status').textContent = 'Locked'; document.body.classList.remove('drawer');
  },
  async open() {
    for (const note of await DB.all()) notes.set(note.path, note);
    for (const file of await DB.files()) files.set(file.path, file);
    space = ''; rebuildIndex(); pruneHistory();
    // Older versions stored only the last note's path.
    const last = Auth.store.last, legacy = typeof last === 'string' ? last : null;
    if (legacy || !last) Auth.store.last = { space: '', notes: {} };
    for (const d of Array.isArray(Auth.store.last.folders) ? Auth.store.last.folders : []) if (typeof d === 'string') expanded.add(d);
    if (![...notes.values()].some(isNote) && Auth.session && Auth.store.cloud?.checkpoint?.manifest.entries.some(e => e.kind === 'note' && !e.deleted && e.path !== SPACES)) await sync({ strict: true });
    if (![...notes.values()].some(isNote)) await createNote('Welcome', WELCOME);
    // Older versions stored edit, split or view; all of them now open in live preview.
    setSource(localStorage.getItem('vault.mode') === 'source');
    if (localStorage.getItem('vault.outline') === 'open' && innerWidth > 800) toggleOutline(true);
    await switchSpace(legacy ? spaceOf(legacy) : last?.space || '', legacy || undefined);
    if (getCfg()) sync();
    else setStatus('Saved notes unlocked — offline or sign in in Settings to sync');
  },
  flush, sync, async waitSync() { try { await syncPromise; } catch {} }
};
Auth.start(App, SYNC_URL);

