'use strict';
// Obsidian-style live preview on CodeMirror 6 (vendor/codemirror.min.js exposes it as CM).
// Notes stay plain Markdown, but outside the element being edited the syntax is hidden and the note looks
// rendered: headings, emphasis, links, images, task boxes, quotes, code and tables. Ctrl/Cmd+E shows the source.
const LiveEditor = (() => {
  const {
    EditorView, Decoration, WidgetType, keymap, placeholder, EditorState, EditorSelection, StateField, StateEffect,
    Annotation, Compartment, Prec, Transaction, Language, syntaxTree, ensureSyntaxTree, indentUnit, HighlightStyle,
    syntaxHighlighting, commonmarkLanguage, insertNewlineContinueMarkup, deleteMarkupBackward, history,
    historyKeymap, defaultKeymap, indentMore, indentLess, GFM, tags
  } = CM;

  // [[Note]], [[Note#Heading|alias]] and ![[image.png|300]], matching the app's marked extensions.
  const WIKI = /^(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/;
  const WikiLinks = {
    defineNodes: ['WikiLink', 'Embed'],
    parseInline: [{
      name: 'WikiLink', before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 && next !== 33) return -1;
        const m = WIKI.exec(cx.slice(pos, Math.min(cx.end, pos + 1000)));
        return m ? cx.addElement(cx.elt(m[1] ? 'Embed' : 'WikiLink', pos, pos + m[0].length)) : -1;
      }
    }]
  };
  // GFM like the preview (tables, task lists, strikethrough, bare URLs), keeping lang-markdown's list commands.
  const language = new Language(commonmarkLanguage.data, commonmarkLanguage.parser.configure([GFM, WikiLinks]), [], 'markdown');
  const styles = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.processingInstruction, class: 'cm-md-mark' },
    { tag: tags.emphasis, class: 'cm-md-em' },
    { tag: tags.strong, class: 'cm-md-strong' },
    { tag: tags.strikethrough, class: 'cm-md-strike' },
    { tag: tags.monospace, class: 'cm-md-code' },
    { tag: tags.url, class: 'cm-md-url' }
  ]));

  const external = Annotation.define();     // text set by the app (sync pulls), not typed
  const setFocus = StateEffect.define(), refresh = StateEffect.define();
  const focused = StateField.define({
    create: () => false,
    update(v, tr) { for (const e of tr.effects) if (e.is(setFocus)) v = e.value; return v; }
  });
  const WEB = /^(https?:|data:image\/)/i;

  function create(parent, hooks) {
    /* ---------- widgets ---------- */
    const missing = name => Object.assign(document.createElement('span'), { className: 'att missing', title: 'Image not found', textContent: name });
    class ImageWidget extends WidgetType {
      // src: {url} for web images, {path} for an attachment, or null when the image can't be found
      constructor(src, alt, size, name) { super(); Object.assign(this, { src, alt, size, name }); this.key = JSON.stringify([src, alt, size, name]); }
      eq(o) { return o.key === this.key; }
      ignoreEvent() { return false; }
      toDOM(view) {
        if (!this.src) return Object.assign(missing(this.name), { className: 'att missing cm-reveal' });
        const img = Object.assign(document.createElement('img'), { className: 'att cm-reveal', alt: this.alt });
        if (this.size) { img.width = +this.size[0]; if (this.size[1]) img.height = +this.size[1]; }
        img.onload = () => view.requestMeasure();
        if (this.src.url) img.src = this.src.url;
        else {
          img.dataset.att = this.src.path;
          hooks.imageURL(this.src.path).then(u => { img.src = u; }, () => img.replaceWith(missing(this.name)));
        }
        return img;
      }
    }
    class TableWidget extends WidgetType {
      constructor(src) { super(); this.src = src; }
      eq(o) { return o.src === this.src; }
      ignoreEvent() { return false; }
      toDOM() { const div = document.createElement('div'); div.className = 'cm-table cm-reveal'; hooks.renderInto(div, this.src); return div; }
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
      const touches = (from, to) => focus && state.selection.ranges.some(r => r.from <= to && r.to >= from);
      const onLine = pos => { const l = doc.lineAt(pos); return touches(l.from, l.to); };
      const hide = (from, to) => { if (from < to) out.push(Decoration.replace({}).range(from, to)); };
      const swap = (from, to, widget, block) => out.push(Decoration.replace({ widget, block }).range(from, to));
      const after = (pos, widget) => out.push(Decoration.widget({ widget, side: 1 }).range(pos));
      const mark = (from, to, cls, attributes) => { if (from < to) out.push(Decoration.mark({ class: cls, attributes }).range(from, to)); };
      const line = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
      const lines = (from, to, cls) => { for (let p = from; p <= to;) { const l = doc.lineAt(p); line(l.from, cls); p = l.to + 1; } };
      const text = (from, to) => doc.sliceString(from, to);
      const kids = (node, name) => { const r = []; for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) r.push(c); return r; };
      const link = (target, alias) => {
        const att = hooks.isImage(target) && hooks.resolveImage(target);
        return att ? { cls: 'wikilink', attrs: { 'data-att': att } }
          : { cls: hooks.noteExists(target) ? 'wikilink' : 'wikilink missing', attrs: { 'data-target': target } };
      };
      // [[target#heading|alias]] shows its alias, or else its target, as a link.
      const wikilink = (node, open) => {
        const m = WIKI.exec(text(node.from, node.to)), target = m[2].trim();
        if (touches(node.from, node.to)) { mark(node.from, node.from + open, 'cm-md-mark'); mark(node.to - 2, node.to, 'cm-md-mark'); return; }
        const shown = m[4] ? [node.to - 2 - m[4].length, node.to - 2] : [node.from + open, node.from + open + m[2].length];
        const { cls, attrs } = link(target);
        hide(node.from, shown[0]); mark(shown[0], shown[1], cls, attrs); hide(shown[1], node.to);
      };
      const image = (node, src, alt, size, name) => {
        const widget = new ImageWidget(src, alt, size, name);
        // While editing an embed its source shows, with the image kept under it.
        if (touches(node.from, node.to)) after(node.to, widget); else swap(node.from, node.to, widget);
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
            if (name === 'FencedCode' && !touches(node.from, node.to)) {
              for (const m of kids(node, 'CodeMark')) hide(m.from, m.to);
              for (const m of kids(node, 'CodeInfo')) mark(m.from, m.to, 'cm-code-info');
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
          else if (name === 'Embed') {
            const m = WIKI.exec(text(node.from, node.to)), target = m[2].trim(), alias = (m[4] || '').trim();
            if (!hooks.isImage(target)) return wikilink(node, 3);
            const path = hooks.resolveImage(target), size = /^(\d+)(?:x(\d+))?$/.exec(alias);
            image(node, path && { path }, size ? hooks.fileName(target) : alias || hooks.fileName(target), size && [size[1], size[2]], target);
          }
          else if (name === 'Image') {
            const marks = kids(node, 'LinkMark'), url = node.getChild('URL');
            if (!url || marks.length < 2) return;
            const href = text(url.from, url.to).replace(/^<(.*)>$/, '$1'), alt = text(marks[0].to, marks[1].from);
            const path = !WEB.test(href) && hooks.resolveImage(href);
            if (WEB.test(href) || path || hooks.isImage(href)) image(node, WEB.test(href) ? { url: href } : path ? { path } : null, alt, null, alt || href);
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
        const redo = tr.docChanged || tr.selection || tr.effects.some(e => e.is(setFocus) || e.is(refresh)) || syntaxTree(tr.state) !== syntaxTree(tr.startState);
        return redo ? build(tr.state) : deco;
      },
      provide: f => EditorView.decorations.from(f)
    });

    /* ---------- events ---------- */
    function toggleTask(view, pos) {
      const l = view.state.doc.lineAt(pos), i = l.text.indexOf('[', pos - l.from);
      if (i < 0 || !/^\[[ xX]\]/.test(l.text.slice(i))) return;
      const at = l.from + i + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: l.text[i + 1] === ' ' ? 'x' : ' ' } });
    }
    function follow(a) {
      if (a.dataset.att) hooks.openAttachment(a.dataset.att);
      else if (a.dataset.target) hooks.follow(a.dataset.target);
      else if (a.dataset.href && /^(https?:|mailto:)/i.test(a.dataset.href)) window.open(a.dataset.href, '_blank', 'noopener,noreferrer');
    }
    const events = EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0) return false;
        const t = e.target instanceof Element ? e.target : null; if (!t) return false;
        const task = t.closest('.cm-task');
        if (task) { e.preventDefault(); toggleTask(view, view.posAtDOM(task)); return true; }
        // Rendered links open on click, like Obsidian; inside a rendered table too. Web links open natively.
        const a = t.closest('.wikilink[data-target], .wikilink[data-att], .cm-link[data-href]');
        if (a && !e.shiftKey) { e.preventDefault(); follow(a); return true; }
        // Web links in rendered tables open natively on click.
        if (t.closest('a[href]')) return true;
        // Clicking a rendered image, rule or table puts the cursor there, which shows its Markdown.
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
      history(), language, styles, indentUnit.of('  '), EditorView.lineWrapping, focused,
      EditorView.focusChangeEffect.of((state, focusing) => setFocus.of(focusing)),
      placeholder('Start writing… use [[Note name]] to link notes.'),
      EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'Note' }),
      Prec.highest(EditorView.domEventHandlers({ keydown: e => hooks.keydown(e) })),
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
      lineBefore() { const p = this.pos, l = view.state.doc.lineAt(p); return view.state.doc.sliceString(l.from, p); },
      coords(pos) { return view.coordsAtPos(pos); },
      focus(atEnd) {
        view.focus();
        if (atEnd) view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      },
      // Re-resolve links and images after notes or attachments change.
      refresh() { view.dispatch({ effects: refresh.of(null) }); },
      setSource(on) { source = !!on; view.dispatch({ effects: mode.reconfigure(modeExt()) }); }
    };
  }
  return { create };
})();
