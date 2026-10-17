'use strict';
// Obsidian-style live preview on CodeMirror 6 (vendor/codemirror.min.js exposes it as CM).
// Notes stay plain Markdown, and the syntax is hidden everywhere (revealing it under the cursor is behind the revealSyntax flag) so the note looks
// rendered: headings, emphasis, links, images, task boxes, quotes, code and tables. Tables are edited cell by cell and code
// blocks are highlighted by language with a copy button, as in Obsidian. Ctrl/Cmd+E shows the source.
const LiveEditor = (() => {
  const {
    EditorView, Decoration, WidgetType, keymap, placeholder, EditorState, EditorSelection, StateField, StateEffect,
    Annotation, Compartment, Prec, Transaction, Language, StreamLanguage, syntaxTree, ensureSyntaxTree, indentUnit, HighlightStyle,
    syntaxHighlighting, commonmarkLanguage, insertNewlineContinueMarkup, deleteMarkupBackward, history,
    historyKeymap, defaultKeymap, indentMore, indentLess, undo, redo, GFM, parseCode, tags, codeModes
  } = CM;

  // [[Note]], [[Note#Heading|alias]], [[#Heading]] and ![[image.png|300]], matching the app's marked extensions.
  const WIKI = /^(!?)\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/;
  const WikiLinks = {
    defineNodes: ['WikiLink', 'Embed'],
    parseInline: [{
      name: 'WikiLink', before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 && next !== 33) return -1;
        const m = WIKI.exec(cx.slice(pos, Math.min(cx.end, pos + 1000)));
        return m && (m[2].trim() || m[3]?.slice(1).trim()) ? cx.addElement(cx.elt(m[1] ? 'Embed' : 'WikiLink', pos, pos + m[0].length)) : -1;
      }
    }]
  };
  // #tags, like Obsidian: letters, digits, _, - and / (for nested tags), not only digits, after a space or line start.
  const TAG = /^#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*/u;
  const Hashtags = {
    defineNodes: ['Hashtag'],
    parseInline: [{
      name: 'Hashtag',
      parse(cx, next, pos) {
        if (next !== 35 || (pos > cx.offset && !/[\s(]/.test(cx.slice(pos - 1, pos)))) return -1;
        const m = TAG.exec(cx.slice(pos, Math.min(cx.end, pos + 200)));
        return m ? cx.addElement(cx.elt('Hashtag', pos, pos + m[0].length)) : -1;
      }
    }]
  };
  // Code blocks are parsed in the language named after the fence: ```js, ```python, ```bash and so on.
  const ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript', ts: 'typescript',
    tsx: 'typescript', jsonc: 'json', json5: 'json', py: 'python', python3: 'python', sh: 'shell', bash: 'shell', zsh: 'shell',
    console: 'shell', shellscript: 'shell', htm: 'html', svg: 'xml', yml: 'yaml', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c',
    cs: 'csharp', 'c#': 'csharp', kt: 'kotlin', objc: 'objectivec', 'objective-c': 'objectivec', golang: 'go', rs: 'rust',
    rb: 'ruby', patch: 'diff', ps1: 'powershell', pwsh: 'powershell', docker: 'dockerfile', postgres: 'sql', mysql: 'sql', sqlite: 'sql'
  };
  const codeLangs = new Map();
  function codeLanguage(info) {
    let name = info.trim().split(/\s+/)[0].toLowerCase();
    if (!Object.hasOwn(codeModes, name)) name = Object.hasOwn(ALIASES, name) ? ALIASES[name] : null;
    if (!name) return null;
    if (!codeLangs.has(name)) codeLangs.set(name, StreamLanguage.define(codeModes[name]));
    return codeLangs.get(name);
  }
  // GFM like the preview (tables, task lists, strikethrough, bare URLs), keeping lang-markdown's list commands.
  const language = new Language(commonmarkLanguage.data, commonmarkLanguage.parser.configure([
    GFM, WikiLinks, Hashtags, parseCode({ codeParser: info => codeLanguage(info)?.parser || null })
  ]), [], 'markdown');
  const styles = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.processingInstruction, class: 'cm-md-mark' },
    { tag: tags.emphasis, class: 'cm-md-em' },
    { tag: tags.strong, class: 'cm-md-strong' },
    { tag: tags.strikethrough, class: 'cm-md-strike' },
    { tag: tags.monospace, class: 'cm-md-code' },
    { tag: tags.url, class: 'cm-md-url' }
  ]));
  // Code colours; the classes are only styled inside code blocks.
  const codeStyles = syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier, tags.definitionKeyword, tags.moduleKeyword], class: 'hl-keyword' },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted, tags.character], class: 'hl-string' },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], class: 'hl-comment' },
    { tag: [tags.number, tags.bool, tags.atom, tags.null, tags.literal], class: 'hl-number' },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName), tags.macroName], class: 'hl-def' },
    { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace, tags.standard(tags.variableName)], class: 'hl-type' },
    { tag: [tags.propertyName, tags.attributeName], class: 'hl-prop' },
    { tag: [tags.deleted, tags.invalid], class: 'hl-deleted' },
    { tag: [tags.meta, tags.heading], class: 'hl-meta' }
  ]));

  const external = Annotation.define();     // text set by the app (sync pulls), not typed
  const setFocus = StateEffect.define(), refresh = StateEffect.define();
  const focused = StateField.define({
    create: () => false,
    update(v, tr) { for (const e of tr.effects) if (e.is(setFocus)) v = e.value; return v; }
  });
  // Internal flag: reveal the Markdown symbols of the element under the cursor. Off by default; a settings option can enable it.
  let revealSyntax = false;
  const WEB = /^(https?:|data:image\/)/i;

  // A clicked image is picked: it stays rendered, its Markdown is selected, and it shows resize handles.
  const pick = StateEffect.define();
  const picked = StateField.define({
    create: () => null,
    update(v, tr) {
      for (const e of tr.effects) if (e.is(pick)) return e.value;
      if (!v || tr.selection || tr.effects.some(e => e.is(setFocus) && !e.value)) return null;
      return tr.docChanged ? { from: tr.changes.mapPos(v.from, 1), to: tr.changes.mapPos(v.to, -1) } : v;
    }
  });
  // Image sizes: ![[a.png|300]], ![[a.png|300x200]], ![[a.png|alt|300x200]] and ![alt|300x200](a.png), like Obsidian.
  const SIZE = /^(\d+)(?:x(\d+))?$/;
  const splitSize = label => {
    const parts = (label || '').split('|'), m = SIZE.exec(parts[parts.length - 1].trim());
    if (m) parts.pop();
    return { alt: parts.join('|').trim(), size: m && [m[1], m[2]] };
  };
  const withSize = (label, w, h) => { const { alt } = splitSize(label); return (alt ? alt + '|' : '') + w + 'x' + h; };
  function sized(src, w, h) {
    const m = WIKI.exec(src);
    if (m) return `![[${m[2]}${m[3] || ''}|${withSize(m[4], w, h)}]]` + src.slice(m[0].length);
    const md = /^!\[([^\]]*)\]/.exec(src);
    return '![' + withSize(md[1], w, h) + ']' + src.slice(md[0].length);
  }
  const imageAt = (state, pos) => {
    for (const side of [1, -1]) for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent)
      if (n.name === 'Embed' || n.name === 'Image') return { from: n.from, to: n.to };
    return null;
  };

  // GFM tables as rows of raw cell Markdown. The first row is the header; aligns come from the delimiter row.
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cell = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cell += '\\|'; i++; }
      else if (s[i] === '|') { cells.push(cell.trim()); cell = ''; }
      else cell += s[i];
    }
    cells.push(cell.trim());
    return cells;
  }
  function parseTable(src) {
    const lines = src.split('\n'), rows = [splitRow(lines[0]), ...lines.slice(2).map(splitRow)];
    // Extra cells are kept as columns rather than dropped, so editing never loses text.
    const cols = Math.max(...rows.map(r => r.length));
    const aligns = splitRow(lines[1] || '').map(d => /^:-*:$/.test(d) ? 'center' : /^:/.test(d) ? 'left' : /:$/.test(d) ? 'right' : '');
    return { rows: rows.map(r => Array.from({ length: cols }, (_, i) => r[i] || '')), aligns: Array.from({ length: cols }, (_, i) => aligns[i] || '') };
  }
  // Padded like Obsidian writes them, so the source stays readable.
  function tableSource({ rows, aligns }) {
    const widths = aligns.map((_, c) => Math.max(3, ...rows.map(r => r[c].length)));
    const line = cells => '| ' + cells.join(' | ') + ' |';
    const rule = aligns.map((a, c) => {
      const w = widths[c];
      return a === 'center' ? ':' + '-'.repeat(w - 2) + ':' : a === 'left' ? ':' + '-'.repeat(w - 1) : a === 'right' ? '-'.repeat(w - 1) + ':' : '-'.repeat(w);
    });
    const pad = r => r.map((cell, c) => cell.padEnd(widths[c]));
    return [line(pad(rows[0])), line(rule), ...rows.slice(1).map(r => line(pad(r)))].join('\n');
  }
  // What a typed cell becomes in the source: one line, with any pipe escaped.
  const cellSource = text => text.replace(/\s*\n\s*/g, ' ').replace(/(^|[^\\])\|/g, '$1\\|').replace(/(^|[^\\])\|/g, '$1\\|').trim();

  function create(parent, hooks) {
    /* ---------- widgets ---------- */
    const missing = name => Object.assign(document.createElement('span'), { className: 'att missing', title: 'Image not found', textContent: name });
    class ImageWidget extends WidgetType {
      // src: {url} for web images, {path} for an attachment, or null when the image can't be found
      constructor(src, alt, size, name, sel) { super(); Object.assign(this, { src, alt, size, name, sel }); this.key = JSON.stringify([src, alt, size, name, sel]); }
      eq(o) { return o.key === this.key; }
      ignoreEvent() { return false; }
      toDOM(view) {
        const wrap = document.createElement('span');
        wrap.className = 'cm-img cm-reveal' + (this.sel ? ' cm-picked' : '');
        if (!this.src) { wrap.append(missing(this.name)); return wrap; }
        const img = Object.assign(document.createElement('img'), { className: 'att', alt: this.alt });
        // Width and height both apply, so a resized image keeps the shape it was given.
        if (this.size) {
          img.width = +this.size[0]; img.style.width = this.size[0] + 'px';
          if (this.size[1]) { img.height = +this.size[1]; img.style.height = this.size[1] + 'px'; }
        }
        img.onload = () => view.requestMeasure();
        if (this.src.url) img.src = this.src.url;
        else {
          img.dataset.att = this.src.path;
          hooks.imageURL(this.src.path).then(u => { img.src = u; }, () => img.replaceWith(missing(this.name)));
        }
        wrap.append(img);
        if (this.sel) for (const dir of ['e', 's', 'se']) {
          const h = Object.assign(document.createElement('span'), { className: 'cm-handle cm-handle-' + dir });
          h.addEventListener('pointerdown', e => resize(view, e, img, dir));
          wrap.append(h);
        }
        return wrap;
      }
    }
    // A table is edited cell by cell, like Obsidian: a focused cell shows its Markdown, the others show it rendered.
    // Each edit rewrites the table's source; the widget keeps its DOM (and the caret) when the new source is its own.
    class TableWidget extends WidgetType {
      constructor(src) { super(); this.src = src; }
      eq(o) { return o.src === this.src; }
      updateDOM(dom) { return dom.table?.src === this.src; }
      ignoreEvent() { return true; }
      toDOM(view) { return tableDOM(view, this.src); }
    }
    const CELL_EDIT = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();
    function tableDOM(view, src) {
      const wrap = document.createElement('div'), model = parseTable(src);
      wrap.className = 'cm-table';
      wrap.table = { src, model };
      const grid = document.createElement('table');
      model.rows.forEach((row, r) => {
        const tr = document.createElement('tr');
        row.forEach((md, c) => {
          const cell = document.createElement(r ? 'td' : 'th');
          Object.assign(cell.dataset, { r, c });
          cell.contentEditable = CELL_EDIT;
          cell.spellcheck = false;
          if (model.aligns[c]) cell.style.textAlign = model.aligns[c];
          showCell(cell, md);
          tr.append(cell);
        });
        (r ? (grid.tBodies[0] || grid.createTBody()) : grid.createTHead()).append(tr);
      });
      const add = (cls, title, run) => {
        const b = Object.assign(document.createElement('button'), { className: 'cm-table-add ' + cls, type: 'button', title, textContent: '+' });
        b.tabIndex = -1; b.contentEditable = 'false';
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', run);
        return b;
      };
      const box = document.createElement('div');
      box.className = 'cm-table-box';
      box.append(grid,
        add('cm-table-add-col', 'Add column', () => edit(view, wrap, m => { insertColumn(m, m.aligns.length); return [0, m.aligns.length - 1]; })),
        add('cm-table-add-row', 'Add row', () => edit(view, wrap, m => { insertRow(m, m.rows.length); return [m.rows.length - 1, 0]; })));
      wrap.append(box);
      wrap.addEventListener('focusin', e => { const cell = e.target.closest('[data-r]'); if (cell) startCell(wrap, cell); });
      wrap.addEventListener('focusout', e => { const cell = e.target.closest('[data-r]'); if (cell) showCell(cell, cellText(wrap, cell)); });
      wrap.addEventListener('mousedown', e => cellMouse(view, wrap, e));
      wrap.addEventListener('click', e => { if (e.target.closest('a')) e.preventDefault(); });
      wrap.addEventListener('input', e => { const cell = e.target.closest('[data-r]'); if (cell) commit(view, wrap, cell); });
      wrap.addEventListener('keydown', e => cellKey(view, wrap, e));
      wrap.addEventListener('contextmenu', e => { const cell = e.target.closest('[data-r]'); if (cell) { e.preventDefault(); tableMenu(view, wrap, cell, e); } });
      return wrap;
    }
    const cellAt = (wrap, r, c) => wrap.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    const cellText = (wrap, cell) => wrap.table.model.rows[cell.dataset.r][cell.dataset.c];
    // Rendered: inline Markdown, so links, emphasis, code and images show as they do elsewhere in the note.
    function showCell(cell, md) {
      delete cell.dataset.editing;
      if (md) hooks.renderInline(cell, md.replace(/\\\|/g, '|')); else cell.textContent = '';
    }
    function startCell(wrap, cell, at) {
      if (cell.dataset.editing) return;
      const shown = cell.textContent, md = cellText(wrap, cell);
      cell.dataset.editing = '1';
      cell.textContent = md;
      // Keep the caret where it was clicked when the cell has no hidden Markdown, else put it at the end.
      caret(cell, at != null && shown === md ? at : md.length);
      return at != null && shown === md ? at : md.length;
    }
    function caret(cell, at) {
      const t = cell.firstChild, range = document.createRange();
      if (t) range.setStart(t, Math.min(at, t.length)); else range.setStart(cell, 0);
      range.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }
    function caretOffset(cell) {
      const sel = getSelection();
      if (!sel.rangeCount || !cell.contains(sel.anchorNode)) return null;
      const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(cell); r.setEnd(sel.anchorNode, sel.anchorOffset);
      return r.toString().length;
    }
    // Where the table's source is now; null if it changed under the widget (then the widget is redrawn anyway).
    function tableRange(view, wrap) {
      let from;
      try { from = view.posAtDOM(wrap); } catch { return null; }
      const to = from + wrap.table.src.length;
      return view.state.sliceDoc(from, to) === wrap.table.src ? { from, to } : null;
    }
    function commit(view, wrap, cell) {
      const at = tableRange(view, wrap); if (!at) return;
      wrap.table.model.rows[cell.dataset.r][cell.dataset.c] = cellSource(cell.textContent);
      const next = tableSource(wrap.table.model);
      if (next === wrap.table.src) return;
      wrap.table.src = next;
      view.dispatch({ changes: { from: at.from, to: at.to, insert: next }, userEvent: 'input' });
      view.requestMeasure();
    }
    // Structural edits redraw the table, then focus the cell that change returns as [row, column].
    function edit(view, wrap, change) {
      const at = tableRange(view, wrap); if (!at) return;
      const model = { rows: wrap.table.model.rows.map(r => [...r]), aligns: [...wrap.table.model.aligns] };
      const focus = change(model);
      const next = model.rows.length ? tableSource(model) : '';
      view.dispatch({ changes: { from: at.from, to: at.to, insert: next }, userEvent: next ? 'input' : 'delete' });
      if (!next) { view.focus(); view.dispatch({ selection: { anchor: at.from } }); return; }
      if (focus) focusCell(view, at.from, ...focus);
    }
    function focusCell(view, from, r, c, at) {
      for (const w of view.contentDOM.querySelectorAll('.cm-table')) {
        let pos; try { pos = view.posAtDOM(w); } catch { continue; }
        if (pos !== from) continue;
        const rows = w.table.model.rows;
        const cell = cellAt(w, Math.max(0, Math.min(r, rows.length - 1)), Math.max(0, Math.min(c, rows[0].length - 1)));
        cell.focus();
        if (at != null) caret(cell, at === 'end' ? cell.textContent.length : at);
        return true;
      }
    }
    const insertRow = (m, at) => m.rows.splice(Math.max(1, at), 0, m.aligns.map(() => ''));
    const insertColumn = (m, at) => { m.rows.forEach(r => r.splice(at, 0, '')); m.aligns.splice(at, 0, ''); };
    function leave(view, wrap, after) {
      const at = tableRange(view, wrap); if (!at) return;
      view.focus();
      if (!after) { view.dispatch({ selection: { anchor: Math.max(0, at.from - 1) }, scrollIntoView: true }); return; }
      // A table at the very end of the note gets an empty line after it to type on.
      if (at.to >= view.state.doc.length) view.dispatch({ changes: { from: at.to, insert: '\n' } });
      view.dispatch({ selection: { anchor: at.to + 1 }, scrollIntoView: true });
    }
    function cellMouse(view, wrap, e) {
      if (e.button !== 0) return;
      const cell = e.target.closest('[data-r]');
      if (!cell || cell.dataset.editing) return;
      // Links in a rendered cell open on click; elsewhere the click starts editing that cell.
      const a = e.target.closest('.wikilink[data-target], .wikilink[data-att], a[href]');
      if (a && !e.shiftKey) {
        e.preventDefault();
        if ('target' in a.dataset || a.dataset.att) follow(a);
        else if (/^(https?:|mailto:)/i.test(a.getAttribute('href'))) window.open(a.href, '_blank', 'noopener,noreferrer');
        return;
      }
      const p = document.caretPositionFromPoint?.(e.clientX, e.clientY), rng = !p && document.caretRangeFromPoint?.(e.clientX, e.clientY);
      const node = p ? p.offsetNode : rng?.startContainer, off = p ? p.offset : rng?.startOffset;
      let at = null;
      if (node && cell.contains(node)) { const r = document.createRange(); r.selectNodeContents(cell); r.setEnd(node, off); at = r.toString().length; }
      e.preventDefault();
      at = startCell(wrap, cell, at);
      cell.focus({ preventScroll: true });
      caret(cell, at);
    }
    function cellKey(view, wrap, e) {
      const cell = e.target.closest('[data-r]'); if (!cell || e.isComposing) return;
      const r = +cell.dataset.r, c = +cell.dataset.c, rows = wrap.table.model.rows, last = rows.length - 1, cols = rows[0].length;
      const from = tableRange(view, wrap)?.from, mod = e.ctrlKey || e.metaKey, key = e.key;
      const go = (r2, c2, at) => { e.preventDefault(); focusCell(view, from, r2, c2, at); };
      if (mod && key.toLowerCase() === 'z' || mod && key.toLowerCase() === 'y') {
        // Undo works on the note, then puts the caret back in the same cell.
        e.preventDefault();
        (key.toLowerCase() === 'y' || e.shiftKey ? redo : undo)(view);
        if (from != null) focusCell(view, from, r, c, 'end');
      }
      else if (key === 'Tab' && !e.shiftKey) {
        if (c < cols - 1) go(r, c + 1, 'end');
        else if (r < last) go(r + 1, 0, 'end');
        else { e.preventDefault(); edit(view, wrap, m => { insertRow(m, m.rows.length); return [m.rows.length - 1, 0]; }); }
      }
      else if (key === 'Tab') { if (c > 0) go(r, c - 1, 'end'); else if (r > 0) go(r - 1, cols - 1, 'end'); else e.preventDefault(); }
      else if (key === 'Enter' && !mod) {
        // Enter moves down a row, adding one at the bottom, like Obsidian.
        if (r < last) go(r + 1, c, 'end');
        else { e.preventDefault(); edit(view, wrap, m => { insertRow(m, m.rows.length); return [m.rows.length - 1, c]; }); }
      }
      else if (key === 'Enter') { e.preventDefault(); leave(view, wrap, true); }
      else if (key === 'Escape') { e.preventDefault(); leave(view, wrap, true); }
      else if (key === 'ArrowUp' && !e.shiftKey) { if (r > 0) go(r - 1, c, 'end'); else { e.preventDefault(); leave(view, wrap, false); } }
      else if (key === 'ArrowDown' && !e.shiftKey) { if (r < last) go(r + 1, c, 'end'); else { e.preventDefault(); leave(view, wrap, true); } }
      else if (key === 'ArrowLeft' && !e.shiftKey && getSelection().isCollapsed && caretOffset(cell) === 0 && (c > 0 || r > 0)) go(c > 0 ? r : r - 1, c > 0 ? c - 1 : cols - 1, 'end');
      else if (key === 'ArrowRight' && !e.shiftKey && getSelection().isCollapsed && caretOffset(cell) === cell.textContent.length && (c < cols - 1 || r < last)) go(c < cols - 1 ? r : r + 1, c < cols - 1 ? c + 1 : 0, 0);
    }
    // Right-click (or long-press) a cell for row, column and alignment actions.
    function tableMenu(view, wrap, cell, e) {
      document.querySelector('.cm-table-menu')?.remove();
      const r = +cell.dataset.r, c = +cell.dataset.c, rows = wrap.table.model.rows;
      const items = [
        ['Add row above', r > 0, m => { insertRow(m, r); return [r, c]; }],
        ['Add row below', true, m => { insertRow(m, r + 1); return [r + 1, c]; }],
        ['Add column left', true, m => { insertColumn(m, c); return [r, c]; }],
        ['Add column right', true, m => { insertColumn(m, c + 1); return [r, c + 1]; }],
        null,
        ['Align left', true, m => { m.aligns[c] = 'left'; return [r, c]; }],
        ['Align center', true, m => { m.aligns[c] = 'center'; return [r, c]; }],
        ['Align right', true, m => { m.aligns[c] = 'right'; return [r, c]; }],
        null,
        ['Delete row', r > 0, m => { m.rows.splice(r, 1); return [r, c]; }],
        ['Delete column', rows[0].length > 1, m => { m.rows.forEach(row => row.splice(c, 1)); m.aligns.splice(c, 1); return [r, c]; }],
        ['Delete table', true, m => { m.rows = []; return null; }]
      ];
      const menu = document.createElement('div');
      menu.className = 'cm-table-menu';
      menu.setAttribute('role', 'menu');
      for (const item of items) {
        if (!item) { menu.append(document.createElement('hr')); continue; }
        const [label, ok, change] = item;
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, disabled: !ok });
        b.setAttribute('role', 'menuitem');
        b.addEventListener('mousedown', ev => ev.preventDefault());
        b.addEventListener('click', () => { close(); edit(view, wrap, change); });
        menu.append(b);
      }
      const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
      const outside = ev => { if (!menu.contains(ev.target)) close(); };
      const esc = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', esc, true);
      document.body.append(menu);
      const w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - w - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - h - 4)) + 'px';
    }
    // The copy button on a code block's first line copies the code between its fences.
    class CopyWidget extends WidgetType {
      eq() { return true; }
      ignoreEvent() { return true; }
      toDOM(view) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cm-code-copy', textContent: 'Copy', title: 'Copy code' });
        b.tabIndex = -1;
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', async () => {
          const code = codeAt(view.state, view.posAtDOM(b));
          if (code == null) return;
          try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; }
          catch { b.textContent = 'Copy failed'; }
          setTimeout(() => { b.textContent = 'Copy'; }, 1500);
        });
        return b;
      }
    }
    const copy = new CopyWidget();
    function codeAt(state, pos) {
      let node = syntaxTree(state).resolveInner(pos, -1);
      while (node && node.name !== 'FencedCode') node = node.parent;
      if (!node) return null;
      const doc = state.doc, first = doc.lineAt(node.from), marks = [];
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') marks.push(c);
      const end = marks.length > 1 ? doc.lineAt(marks[marks.length - 1].from).from - 1 : node.to;
      return first.to + 1 > end ? '' : doc.sliceString(first.to + 1, end);
    }
    class Simple extends WidgetType {
      constructor(make, key) { super(); this.make = make; this.key = key; }
      eq(o) { return o.key === this.key; }
      ignoreEvent() { return false; }
      toDOM() { return this.make(); }
    }
    const el = (tag, props) => () => Object.assign(document.createElement(tag), props);
    const bullet = new Simple(el('span', { className: 'cm-bullet', textContent: '•' }), 'bullet');
    const hr = new Simple(el('span', { className: 'cm-hr cm-reveal' }), 'hr');
    const box = done => new Simple(el('input', { type: 'checkbox', className: 'cm-task', checked: done }), 'task' + done);
    const indent = cols => new Simple(() => { const s = document.createElement('span'); s.className = 'cm-indent'; s.style.width = cols * 0.75 + 'em'; return s; }, 'indent' + cols);

    /* ---------- live preview decorations ---------- */
    function build(state) {
      const doc = state.doc, out = [], focus = state.field(focused);
      const touches = (from, to) => revealSyntax && focus && state.selection.ranges.some(r => r.from <= to && r.to >= from);
      const onLine = pos => { const l = doc.lineAt(pos); return touches(l.from, l.to); };
      const hide = (from, to) => { if (from < to) out.push(Decoration.replace({}).range(from, to)); };
      const swap = (from, to, widget, block) => out.push(Decoration.replace({ widget, block }).range(from, to));
      const after = (pos, widget) => out.push(Decoration.widget({ widget, side: 1 }).range(pos));
      const mark = (from, to, cls, attributes) => { if (from < to) out.push(Decoration.mark({ class: cls, attributes }).range(from, to)); };
      const line = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
      const lines = (from, to, cls) => { for (let p = from; p <= to;) { const l = doc.lineAt(p); line(l.from, cls); p = l.to + 1; } };
      const text = (from, to) => doc.sliceString(from, to);
      const kids = (node, name) => { const r = []; for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) r.push(c); return r; };
      const link = (target, heading) => {
        const att = hooks.isImage(target) && hooks.resolveImage(target);
        return att ? { cls: 'wikilink', attrs: { 'data-att': att } }
          : { cls: !target || hooks.noteExists(target) ? 'wikilink' : 'wikilink missing', attrs: { 'data-target': target, ...(heading ? { 'data-heading': heading } : {}) } };
      };
      // [[target#heading|alias]] shows its alias, or else its target and heading, as a link.
      const wikilink = (node, open) => {
        const m = WIKI.exec(text(node.from, node.to)), target = m[2].trim(), heading = m[3]?.slice(1).trim();
        if (touches(node.from, node.to)) { mark(node.from, node.from + open, 'cm-md-mark'); mark(node.to - 2, node.to, 'cm-md-mark'); return; }
        const shown = m[4] ? [node.to - 2 - m[4].length, node.to - 2] : [node.from + open, node.from + open + m[2].length + (heading ? m[3].length : 0)];
        const { cls, attrs } = link(target, heading);
        hide(node.from, shown[0]); mark(shown[0], shown[1], cls, attrs); hide(shown[1], node.to);
      };
      const sel = state.field(picked);
      const image = (node, src, alt, size, name) => {
        const on = !!sel && sel.from === node.from && sel.to === node.to, widget = new ImageWidget(src, alt, size, name, on);
        // While editing an embed its source shows, with the image kept under it. A picked image stays rendered.
        if (!on && touches(node.from, node.to)) after(node.to, widget); else swap(node.from, node.to, widget);
      };

      const tree = ensureSyntaxTree(state, doc.length, 200) || syntaxTree(state);
      tree.iterate({
        enter(ref) {
          const node = ref.node, name = node.name, parent = node.parent?.name;
          if (/^ATXHeading\d$/.test(name)) line(node.from, 'cm-h cm-h' + name.slice(-1));
          else if (/^SetextHeading\d$/.test(name)) lines(node.from, node.lastChild.from - 1, 'cm-h cm-h' + name.slice(-1));
          else if (name === 'HeaderMark' && /^ATXHeading/.test(parent) && !onLine(node.from)) {
            const h = node.parent;
            if (node.from === h.from) { let e = node.to; while (e < h.to && text(e, e + 1) === ' ') e++; hide(node.from, e); }
            else { let s = node.from; while (s > h.from && text(s - 1, s) === ' ') s--; hide(s, node.to); }
          }
          else if ((name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark' && parent === 'InlineCode') && !touches(node.parent.from, node.parent.to)) hide(node.from, node.to);
          else if (name === 'Escape' && !touches(node.from, node.to)) hide(node.from, node.from + 1);
          else if (name === 'QuoteMark') {
            line(node.from, 'cm-quote');
            if (!onLine(node.from)) hide(node.from, node.to + (text(node.to, node.to + 1) === ' ' ? 1 : 0));
          }
          else if (name === 'ListMark' && parent === 'ListItem') {
            const l = doc.lineAt(node.from), lead = text(l.from, node.from);
            const task = node.nextSibling?.name === 'Task' ? node.nextSibling.firstChild : null;
            const end = task?.name === 'TaskMarker' ? task.to : node.to;
            if (touches(l.from, end)) return;
            if (lead && !lead.trim()) swap(l.from, node.from, indent(lead.replace(/\t/g, '    ').length));
            if (task?.name === 'TaskMarker') {
              const done = /x/i.test(text(task.from, task.to));
              let from = task.to; while (text(from, from + 1) === ' ') from++;
              swap(node.from, Math.min(from, task.to + 1), box(done));
              if (done) mark(from, Math.min(node.nextSibling.to, l.to), 'cm-done');
            } else if (/[-*+]/.test(text(node.from, node.to))) swap(node.from, node.to, bullet);
          }
          else if (name === 'HorizontalRule') { if (!onLine(node.from)) swap(node.from, node.to, hr); }
          else if (name === 'FencedCode' || name === 'CodeBlock') {
            lines(node.from, node.to, 'cm-codeblock');
            line(node.from, 'cm-codeblock-begin'); line(node.to, 'cm-codeblock-end');
            if (name === 'FencedCode') {
              // The opening fence line becomes the block's header: its language as a label, and a copy button.
              // The language stays real text, so it can still be edited there.
              const marks = kids(node, 'CodeMark');
              if (!touches(node.from, node.to)) {
                for (const m of marks) hide(m.from, m.to);
                line(node.from, 'cm-code-head');
                if (marks.length > 1 && doc.lineAt(marks[marks.length - 1].from).from > node.from) line(marks[marks.length - 1].from, 'cm-code-foot');
              }
              for (const m of kids(node, 'CodeInfo')) mark(m.from, m.to, 'cm-code-info');
              after(doc.lineAt(node.from).to, copy);
            }
            return false;
          }
          else if (name === 'Table') {
            const from = doc.lineAt(node.from).from, to = doc.lineAt(node.to).to;
            if (touches(from, to)) lines(from, to, 'cm-table-src');
            else swap(from, to, new TableWidget(text(from, to)), true);
            return false;
          }
          else if (name === 'WikiLink') wikilink(node, 2);
          else if (name === 'Hashtag') mark(node.from, node.to, 'cm-tag', { 'data-tag': text(node.from + 1, node.to) });
          else if (name === 'Embed') {
            const m = WIKI.exec(text(node.from, node.to)), target = m[2].trim(), alias = (m[4] || '').trim();
            if (!hooks.isImage(target)) return wikilink(node, 3);
            const path = hooks.resolveImage(target), { alt, size } = splitSize(alias);
            image(node, path && { path }, alt || hooks.fileName(target), size, target);
          }
          else if (name === 'Image') {
            const marks = kids(node, 'LinkMark'), url = node.getChild('URL');
            if (!url || marks.length < 2) return;
            const href = text(url.from, url.to).replace(/^<(.*)>$/, '$1'), { alt, size } = splitSize(text(marks[0].to, marks[1].from));
            const path = !WEB.test(href) && hooks.resolveImage(href);
            if (WEB.test(href) || path || hooks.isImage(href)) image(node, WEB.test(href) ? { url: href } : path ? { path } : null, alt, size, alt || href);
            return false;
          }
          else if (name === 'Link') {
            // [text](url): only the text shows, as a link. Reference links stay as typed.
            const marks = kids(node, 'LinkMark'), url = node.getChild('URL');
            if (!url || marks.length < 3 || touches(node.from, node.to)) return;
            hide(node.from, marks[0].to); hide(marks[1].from, node.to);
            mark(marks[0].to, marks[1].from, 'cm-link', { 'data-href': text(url.from, url.to).replace(/^<(.*)>$/, '$1') });
          }
          else if (name === 'Autolink') {
            const url = node.getChild('URL');
            if (url && !touches(node.from, node.to)) { hide(node.from, url.from); mark(url.from, url.to, 'cm-link', { 'data-href': text(url.from, url.to) }); hide(url.to, node.to); }
            return false;
          }
          else if (name === 'URL' && parent !== 'Link' && parent !== 'Image' && parent !== 'LinkReference' && !touches(node.from, node.to)) {
            const href = text(node.from, node.to);
            mark(node.from, node.to, 'cm-link', { 'data-href': /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : /@/.test(href) && !/\//.test(href) ? 'mailto:' + href : 'https://' + href });
          }
        }
      });
      return Decoration.set(out, true);
    }
    const live = StateField.define({
      create: build,
      update(deco, tr) {
        const redo = tr.docChanged || tr.selection || tr.effects.some(e => e.is(setFocus) || e.is(refresh) || e.is(pick)) || syntaxTree(tr.state) !== syntaxTree(tr.startState);
        return redo ? build(tr.state) : deco;
      },
      provide: f => EditorView.decorations.from(f)
    });

    /* ---------- picking, deleting and resizing images ---------- */
    function pickImage(view, at) {
      view.focus();
      view.dispatch({ selection: { anchor: at.from, head: at.to }, effects: pick.of(at) });
    }
    // Del or Backspace removes a picked image from the note (its file stays in attachments/), with its line if it was alone there.
    function deletePicked(view) {
      const p = view.state.field(picked); if (!p) return false;
      const doc = view.state.doc, l = doc.lineAt(p.from);
      let { from, to } = p;
      if (doc.lineAt(to).number === l.number && l.text.trim() === doc.sliceString(from, to)) {
        if (l.to < doc.length) { from = l.from; to = l.to + 1; } else if (l.from > 0) { from = l.from - 1; to = l.to; }
      }
      view.dispatch({ changes: { from, to }, selection: { anchor: from }, scrollIntoView: true, userEvent: 'delete' });
      return true;
    }
    function unpick(view) {
      const p = view.state.field(picked); if (!p) return false;
      view.dispatch({ selection: { anchor: p.to } });
      return true;
    }
    // Dragging a handle resizes freely (no aspect ratio lock) and saves the size in the Markdown as widthxheight.
    function resize(view, e, img, dir) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const handle = e.currentTarget, r = img.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      const line = img.closest('.cm-line') || view.contentDOM;
      const maxW = Math.max(16, line.getBoundingClientRect().right - parseFloat(getComputedStyle(line).paddingRight) - r.left);
      let w = r.width, h = r.height;
      handle.setPointerCapture(e.pointerId);
      const move = ev => {
        if (dir !== 's') w = Math.min(maxW, Math.max(16, r.width + ev.clientX - x0));
        if (dir !== 'e') h = Math.max(16, r.height + ev.clientY - y0);
        img.style.width = w + 'px'; img.style.height = h + 'px';
      };
      const end = ev => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
        const p = view.state.field(picked);
        if (!p || ev.type === 'pointercancel') { view.dispatch({ effects: refresh.of(null) }); return; }
        const src = view.state.sliceDoc(p.from, p.to), next = sized(src, Math.round(w), Math.round(h));
        if (next === src) return;
        const at = { from: p.from, to: p.from + next.length };
        view.dispatch({ changes: { from: p.from, to: p.to, insert: next }, selection: { anchor: at.from, head: at.to }, effects: pick.of(at), userEvent: 'input' });
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    }

    /* ---------- events ---------- */
    function toggleTask(view, pos) {
      const l = view.state.doc.lineAt(pos), i = l.text.indexOf('[', pos - l.from);
      if (i < 0 || !/^\[[ xX]\]/.test(l.text.slice(i))) return;
      const at = l.from + i + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: l.text[i + 1] === ' ' ? 'x' : ' ' } });
    }
    function follow(a) {
      if (a.dataset.att) hooks.openAttachment(a.dataset.att);
      else if ('target' in a.dataset) hooks.follow(a.dataset.target, a.dataset.heading);
      else if (a.dataset.href && /^(https?:|mailto:)/i.test(a.dataset.href)) window.open(a.dataset.href, '_blank', 'noopener,noreferrer');
    }
    const events = EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0) return false;
        const t = e.target instanceof Element ? e.target : null; if (!t) return false;
        const task = t.closest('.cm-task');
        if (task) { e.preventDefault(); toggleTask(view, view.posAtDOM(task)); return true; }
        // Rendered links open on click, like Obsidian. Tables handle their own clicks (see tableDOM).
        const tag = t.closest('.cm-tag[data-tag]');
        if (tag && !e.shiftKey) { e.preventDefault(); hooks.tag(tag.dataset.tag); return true; }
        const a = t.closest('.wikilink[data-target], .wikilink[data-att], .cm-link[data-href]');
        if (a && !e.shiftKey) { e.preventDefault(); follow(a); return true; }
        if (t.closest('.cm-handle')) { e.preventDefault(); return true; }
        // Clicking an image picks it; a double click shows its Markdown to edit.
        const img = t.closest('.cm-img'), at = img && imageAt(view.state, view.posAtDOM(img));
        if (at) {
          e.preventDefault();
          if (e.detail > 1) { view.focus(); view.dispatch({ selection: { anchor: at.to - (view.state.sliceDoc(at.to - 2, at.to) === ']]' ? 2 : 1) } }); }
          else pickImage(view, at);
          return true;
        }
        // Clicking a rendered rule puts the cursor there.
        const r = t.closest('.cm-reveal');
        if (r) { e.preventDefault(); view.focus(); view.dispatch({ selection: { anchor: view.posAtDOM(r) } }); return true; }
        return false;
      },
      paste: e => hooks.paste(e),
      dragover(e) { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); return true; } return false; },
      drop(e, view) {
        if (!e.dataTransfer.files.length) return false;
        // Never let the browser navigate away to a dropped file.
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null) view.dispatch({ selection: { anchor: pos } });
        hooks.drop(e);
        return true;
      }
    });
    // Tab indents list items and selections, and otherwise types two spaces as before.
    const tab = view => {
      const { state } = view, r = state.selection.main;
      if (!r.empty || /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s/.test(state.doc.lineAt(r.head).text)) return indentMore(view);
      view.dispatch(state.replaceSelection('  '), { scrollIntoView: true, userEvent: 'input' });
      return true;
    };

    /* ---------- editor ---------- */
    const mode = new Compartment();
    let source = false;
    const modeExt = () => source ? EditorView.editorAttributes.of({ class: 'cm-source' }) : live;
    const extensions = () => [
      history(), language, styles, codeStyles, indentUnit.of('  '), EditorView.lineWrapping, focused, picked,
      EditorView.focusChangeEffect.of((state, focusing) => setFocus.of(focusing)),
      placeholder('Start writing… use [[Note name]] to link notes.'),
      EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'Note' }),
      Prec.highest(EditorView.domEventHandlers({ keydown: e => hooks.keydown(e) })),
      Prec.highest(keymap.of([{ key: 'Backspace', run: deletePicked }, { key: 'Delete', run: deletePicked }, { key: 'Escape', run: unpick }])),
      Prec.high(keymap.of([
        { key: 'Enter', run: insertNewlineContinueMarkup }, { key: 'Backspace', run: deleteMarkupBackward },
        { key: 'Tab', run: tab, shift: indentLess }
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      events, mode.of(modeExt()),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !u.transactions.some(tr => tr.annotation(external))) hooks.change(u.state.doc.toString());
        if (u.docChanged || u.selectionSet) hooks.cursor(u.docChanged);
      })
    ];
    const view = new EditorView({ parent, state: EditorState.create({ extensions: extensions() }) });

    return {
      view,
      get text() { return view.state.doc.toString(); },
      get pos() { return view.state.selection.main.head; },
      get source() { return source; },
      // A fresh document per note, so undo never crosses into another note.
      load(text) { view.setState(EditorState.create({ doc: text, extensions: extensions() })); },
      // Replace all text without an undo step or change event, keeping the cursor (pulled from sync).
      replace(text) {
        const { anchor, head } = view.state.selection.main;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: Math.min(anchor, text.length), head: Math.min(head, text.length) },
          annotations: [external.of(true), Transaction.addToHistory.of(false)]
        });
      },
      insert(text, from = view.state.selection.main.from, to = view.state.selection.main.to) {
        view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), scrollIntoView: true, userEvent: 'input' });
      },
      // An empty rows × cols table (the first row is the header) on its own lines at pos, with the first cell focused.
      insertTable(rows, cols, pos = this.pos) {
        const doc = view.state.doc, line = doc.lineAt(pos), filled = n => n >= 1 && n <= doc.lines && !!doc.line(n).text.trim();
        const src = tableSource({ rows: Array.from({ length: rows }, () => Array(cols).fill('')), aligns: Array(cols).fill('') });
        // Blank lines around it, so the table neither joins the paragraph above nor swallows the line below,
        // and always a line after it to keep typing on.
        const [at, before, after] = line.text.trim() ? [line.to, '\n\n', '\n'] :
          [line.from, filled(line.number - 1) ? '\n' : '', filled(line.number + 1) || line.number === doc.lines ? '\n' : ''];
        const from = at + before.length;
        view.dispatch({ changes: { from: at, insert: before + src + after }, selection: EditorSelection.cursor(from + src.length + 1), scrollIntoView: true, userEvent: 'input' });
        view.focus();
        // Source mode shows no grid; the caret then goes in the first cell's text.
        if (!focusCell(view, from, 0, 0)) view.dispatch({ selection: EditorSelection.cursor(from + 2) });
      },
      // Put the cursor at pos and scroll its line to the top (a heading picked in the outline).
      goto(pos) {
        view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }) });
        view.focus();
      },
      lineBefore() { const p = this.pos, l = view.state.doc.lineAt(p); return view.state.doc.sliceString(l.from, p); },
      coords(pos) { return view.coordsAtPos(pos); },
      focus(atEnd) {
        view.focus();
        if (atEnd) view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      },
      // Re-resolve links and images after notes or attachments change.
      refresh() { view.dispatch({ effects: refresh.of(null) }); },
      setRevealSyntax(on) { revealSyntax = !!on; view.dispatch({ effects: refresh.of(null) }); },
      setSource(on) { source = !!on; view.dispatch({ effects: mode.reconfigure(modeExt()) }); }
    };
  }
  return { create };
})();
