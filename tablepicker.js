'use strict';
// "Insert table" in the editor's right-click menu opens a grid: hovering (or dragging a finger, or the arrow keys)
// fills cells from the top left to pick the size, and a click (lifting the finger, or Enter) inserts the table.
// The first row is the header row.
const TablePicker = (() => {
  const MAX_ROWS = 8, MAX_COLS = 8;
  let picker = null;

  function close() {
    if (!picker) return;
    picker.remove(); picker = null;
    document.removeEventListener('pointerdown', outside, true);
    removeEventListener('resize', close); removeEventListener('blur', close);
  }
  const outside = e => { if (picker && !picker.contains(e.target)) close(); };

  function open(x, y, insert) {
    close();
    let rows = 2, cols = 2;
    picker = document.createElement('div');
    picker.id = 'tpick';
    const grid = document.createElement('div'), size = document.createElement('div');
    grid.className = 'grid'; grid.tabIndex = 0;
    grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', 'Table size');
    grid.style.gridTemplateColumns = `repeat(${MAX_COLS}, auto)`;
    size.className = 'size'; size.setAttribute('aria-live', 'polite');
    for (let r = 1; r <= MAX_ROWS; r++) for (let c = 1; c <= MAX_COLS; c++) {
      const cell = document.createElement('span');
      Object.assign(cell.dataset, { r, c });
      grid.append(cell);
    }
    const show = (r, c) => {
      rows = Math.max(1, Math.min(MAX_ROWS, r)); cols = Math.max(1, Math.min(MAX_COLS, c));
      for (const cell of grid.children) cell.classList.toggle('on', +cell.dataset.r <= rows && +cell.dataset.c <= cols);
      size.textContent = `${rows} ${rows > 1 ? 'rows' : 'row'} × ${cols} ${cols > 1 ? 'columns' : 'column'}`;
    };
    const confirm = () => { const r = rows, c = cols; close(); insert(r, c); };
    // Pointer position, not the event target, so a finger dragging across the grid fills it too.
    const cellAt = e => document.elementFromPoint(e.clientX, e.clientY)?.closest('#tpick .grid span');
    grid.addEventListener('pointermove', e => { const cell = cellAt(e); if (cell) show(+cell.dataset.r, +cell.dataset.c); });
    grid.addEventListener('pointerdown', e => {
      e.preventDefault();
      const cell = cellAt(e); if (cell) show(+cell.dataset.r, +cell.dataset.c);
    });
    grid.addEventListener('pointerup', e => { if (cellAt(e)) confirm(); });
    grid.addEventListener('keydown', e => {
      const moves = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
      if (moves[e.key]) show(rows + moves[e.key][0], cols + moves[e.key][1]);
      else if (e.key === 'Enter' || e.key === ' ') confirm();
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    show(rows, cols);
    picker.append(grid, size);
    document.body.append(picker);
    // Open where the menu was, flipped back inside the viewport near the edges.
    const r = picker.getBoundingClientRect(), pad = 6;
    picker.style.left = Math.max(pad, Math.min(x, innerWidth - r.width - pad)) + 'px';
    picker.style.top = Math.max(pad, Math.min(y, innerHeight - r.height - pad)) + 'px';
    document.addEventListener('pointerdown', outside, true);
    addEventListener('resize', close); addEventListener('blur', close);
    grid.focus({ preventScroll: true });
  }

  ContextMenu.provide('editor', ctx => [{
    label: 'Insert table…',
    run: () => {
      // Insert where the menu was opened, not wherever the caret happened to be.
      const pos = editor.view.posAtCoords({ x: ctx.x, y: ctx.y }) ?? editor.pos;
      open(ctx.x, ctx.y, (rows, cols) => editor.insertTable(rows, cols, pos));
    }
  }]);

  return { open, close, get isOpen() { return !!picker; } };
})();
