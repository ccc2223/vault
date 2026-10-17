'use strict';
// Right-click menu, also opened by a 700 ms long press on touch screens. What the press landed on decides the
// context (editor text, image, link, note in the sidebar, ...), and each context's items come from a provider:
//   ContextMenu.provide('image', ctx => [{ label: 'Delete image', run: () => ... }, { separator: true }, ...]);
// Items take { label, run, disabled, danger }. Contexts without a provider get placeholder items.
// Inputs, dialogs and Shift+right-click keep the browser's own menu (paste, spellcheck). Elements with their own
// contextmenu handler that calls preventDefault (table cells) keep their menu, and get the long press too.
const ContextMenu = (() => {
  const LONG_PRESS = 700, SLOP = 10;
  // Most specific first: the first match names the context.
  const CONTEXTS = [
    ['image', '#ed .cm-img'],
    ['link', '#ed .wikilink, #ed .cm-link, #ed .cm-table a'],
    ['table', '#ed .cm-table'],
    ['editor', '#ed .cm-content'],
    ['note', '#list .item[data-p]'],
    ['backlink', '#bl-body .b[data-p]'],
    ['sidebar', '#side'],
    ['toolbar', '#bar']
  ];
  const LABELS = { image: 'Image', link: 'Link', table: 'Table', editor: 'Editor', note: 'Note', backlink: 'Backlink', sidebar: 'Notes list', toolbar: 'Toolbar', app: 'Vault' };
  const providers = new Map();
  let menu = null, press = null, swallowClick = false, synthetic = false;

  function describe(target) {
    for (const [type, sel] of CONTEXTS) {
      const el = target.closest(sel);
      if (el) return { type, el, target, path: el.dataset?.p };
    }
    return { type: 'app', el: document.body, target };
  }
  const placeholder = ctx => [
    { label: LABELS[ctx.type] + (ctx.path ? ': ' + ctx.path.replace(/^.*\//, '').replace(/\.md$/i, '') : ''), disabled: true },
    { separator: true },
    { label: 'More options coming soon', disabled: true }
  ];

  function close() {
    if (!menu) return;
    menu.remove(); menu = null;
    removeEventListener('resize', close); removeEventListener('blur', close);
    document.removeEventListener('scroll', close, true);
  }
  function open(x, y, target) {
    close();
    const ctx = describe(target);
    const items = (providers.get(ctx.type) || placeholder)(ctx) || [];
    if (!items.length) return;
    menu = document.createElement('div');
    menu.id = 'ctx'; menu.setAttribute('role', 'menu');
    for (const item of items) {
      const row = document.createElement(item.separator ? 'hr' : 'button');
      if (!item.separator) {
        row.type = 'button'; row.textContent = item.label; row.setAttribute('role', 'menuitem');
        row.disabled = !!item.disabled || !item.run;
        if (item.danger) row.className = 'danger';
        row.addEventListener('click', () => { close(); item.run(ctx); });
      }
      menu.append(row);
    }
    document.body.append(menu);
    // Open at the pointer, flipped back inside the viewport near the edges.
    const r = menu.getBoundingClientRect(), pad = 6;
    menu.style.left = Math.max(pad, Math.min(x, innerWidth - r.width - pad)) + 'px';
    menu.style.top = Math.max(pad, y + r.height + pad > innerHeight ? y - r.height : y) + 'px';
    addEventListener('resize', close); addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  const native = (e, target) => e.shiftKey || !!target.closest('input, textarea, select, dialog, #ctx');

  document.addEventListener('contextmenu', e => {
    if (synthetic || native(e, e.target)) return;
    // An element with its own menu (table cells) already handled it.
    if (e.defaultPrevented) { stopPress(); return; }
    e.preventDefault();
    // Touch browsers that fire contextmenu on their own (Android, ~500 ms) wait for the long press instead.
    // Some of them cancel the pointer once they have shown it, so the pending press stops listening for that.
    if (press) { press.nativeMenu = true; return; }
    if (e.pointerType === 'touch') return;
    open(e.clientX, e.clientY, e.target);
  });
  document.addEventListener('pointerdown', e => {
    swallowClick = false;
    if (menu && !menu.contains(e.target)) close();
    if (e.pointerType !== 'touch' || !e.isPrimary || native(e, e.target)) return;
    const { pointerId, clientX: x, clientY: y, target } = e;
    press = { pointerId, x, y, timer: setTimeout(() => {
      press = null; swallowClick = true;
      // Elements with their own contextmenu handler get the long press too (iOS never fires contextmenu).
      synthetic = true;
      const handled = !target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      synthetic = false;
      if (!handled) open(x, y, target);
    }, LONG_PRESS) };
  }, true);
  const stopPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  const cancel = e => { if (press && e.pointerId === press.pointerId && !(e.type === 'pointercancel' && press.nativeMenu)) stopPress(); };
  document.addEventListener('pointermove', e => {
    if (press && e.pointerId === press.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel(e);
  }, true);
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  // Lifting the finger after a long press must not also open the note or link under it.
  document.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    if (!menu?.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', e => {
    if (!menu) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
  }, true);

  return {
    provide(type, items) { providers.set(type, items); },
    open, close, describe,
    get isOpen() { return !!menu; }
  };
})();
