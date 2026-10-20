const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let server, browser, base;
const password = 'test password with plenty of entropy';
const url = 'https://sync.example';

before(async () => {
  const root = path.join(__dirname, '..');
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, name === '/' ? 'index.html' : name);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'text/plain');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function unlocked(options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...options });
  await context.route(url + '/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Content-Type': 'application/json' };
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    let body = {}, status = 200;
    if (pathname === '/login') { const exp = Date.now() + 86400000; body = { session: exp + '.fake-session', exp }; }
    else status = 404;
    await route.fulfill({ status, headers, body: JSON.stringify(body) }).catch(() => {});
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('unlock-submit').disabled);
  await page.locator('#unlock-url').fill(url);
  await page.locator('#unlock-password').fill(password);
  await page.locator('#unlock-submit').click();
  await page.waitForFunction(() => Auth.active);
  await page.evaluate(async () => {
    await createNote('Alpha', 'First line of alpha');
    await createNote('Beta', 'Beta links [[Alpha]]');
  });
  await page.waitForFunction(() => document.querySelector('#list .item[data-p="Alpha.md"]'));
  await page.evaluate(() => openNote('Beta.md'));
  return { context, page, errors };
}
const menuText = page => page.locator('#ctx button').allTextContents();

test('right click opens a placeholder menu that names the context and closes again', async () => {
  const { context, page, errors } = await unlocked();
  try {
    await page.locator('#list .item[data-p="Alpha.md"]').click({ button: 'right' });
    assert.deepEqual(await menuText(page), ['Note: Alpha', 'More options coming soon']);
    const box = await page.locator('#ctx').boundingBox(), vp = page.viewportSize();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height, 'inside the viewport');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#ctx').count(), 0);

    await page.locator('#ed .cm-content').click({ button: 'right', position: { x: 40, y: 10 } });
    assert.deepEqual(await menuText(page), ['Insert table…', 'Insert code block']);
    await page.locator('#list .item[data-p="Beta.md"]').click({ button: 'right' });
    assert.equal((await menuText(page))[0], 'Note: Beta', 'a new menu replaces the open one');
    await page.keyboard.press('Escape');
    await page.locator('#ed .wikilink').click({ button: 'right' });
    assert.equal((await menuText(page))[0], 'Link');
    assert.equal(await page.locator('#ctx').count(), 1);
    await page.mouse.click(5, 300);
    assert.equal(await page.locator('#ctx').count(), 0, 'clicking elsewhere closes it');

    // Providers replace the placeholder for their context, and inputs keep the browser menu.
    await page.evaluate(() => ContextMenu.provide('note', ctx => [{ label: 'Open ' + ctx.path, run: () => { window.ran = ctx.path; } }]));
    await page.locator('#list .item[data-p="Alpha.md"]').click({ button: 'right' });
    await page.locator('#ctx button', { hasText: 'Open Alpha.md' }).click();
    assert.equal(await page.evaluate(() => window.ran), 'Alpha.md');
    assert.equal(await page.locator('#ctx').count(), 0);
    await page.locator('#q').click({ button: 'right' });
    assert.equal(await page.locator('#ctx').count(), 0);

    // Elements with their own menu (like table cells) keep it.
    await page.evaluate(() => {
      const own = Object.assign(document.createElement('div'), { id: 'own', textContent: 'own menu' });
      own.addEventListener('contextmenu', e => { e.preventDefault(); window.ownHits = (window.ownHits || 0) + 1; });
      document.getElementById('ed').querySelector('.cm-content').before(own);
    });
    await page.locator('#own').click({ button: 'right' });
    assert.equal(await page.evaluate(() => window.ownHits), 1);
    assert.equal(await page.locator('#ctx').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a touch long press over 700 ms opens the menu; shorter presses and drags do not', async () => {
  const { context, page, errors } = await unlocked({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 760 } });
  try {
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const press = async (x, y, ms, dx = 0) => {
      await touch('touchStart', x, y);
      if (dx) await touch('touchMove', x + dx, y);
      await page.waitForTimeout(ms);
      await touch('touchEnd');
    };
    const b = await page.locator('#ed .cm-content').boundingBox(), x = b.x + 40, y = b.y + 10;
    await press(x, y, 400);
    assert.equal(await page.locator('#ctx').count(), 0, 'a short press is a tap');
    await press(x, y, 900, 40);
    assert.equal(await page.locator('#ctx').count(), 0, 'moving cancels the press');
    await press(x, y, 900);
    assert.deepEqual(await menuText(page), ['Insert table…', 'Insert code block']);
    await page.touchscreen.tap(5, 700);
    assert.equal(await page.locator('#ctx').count(), 0);

    // A long press reaches elements with their own contextmenu handler instead of opening this menu.
    await page.evaluate(() => {
      const own = Object.assign(document.createElement('div'), { id: 'own', textContent: 'own menu' });
      own.addEventListener('contextmenu', e => { e.preventDefault(); window.ownHits = (window.ownHits || 0) + 1; });
      document.getElementById('ed').querySelector('.cm-content').before(own);
    });
    const o = await page.locator('#own').boundingBox();
    await press(o.x + 10, o.y + 5, 900);
    assert.equal(await page.evaluate(() => window.ownHits), 1);
    assert.equal(await page.locator('#ctx').count(), 0);

    // Long pressing a note in the drawer shows its menu without opening the note.
    await page.locator('#menu').tap();
    await page.waitForFunction(() => document.getElementById('side').getBoundingClientRect().left === 0);
    const item = await page.locator('#list .item[data-p="Alpha.md"]').boundingBox();
    await press(item.x + 20, item.y + 10, 900);
    assert.equal((await menuText(page))[0], 'Note: Alpha');
    assert.equal(await page.evaluate(() => cur), 'Beta.md');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('insert table: hovering the grid picks the size and a click inserts an empty table at the right-click', async () => {
  const { context, page, errors } = await unlocked();
  try {
    const line = page.locator('#ed .cm-line').first();
    const b = await line.boundingBox();
    await page.mouse.click(b.x + 5, b.y + b.height / 2, { button: 'right' });
    await page.locator('#ctx button', { hasText: 'Insert table' }).click();
    assert.equal(await page.locator('#ctx').count(), 0);
    const cell = (r, c) => page.locator(`#tpick .grid span[data-r="${r}"][data-c="${c}"]`);
    await cell(3, 4).hover();
    assert.equal(await page.locator('#tpick .size').textContent(), '3 rows × 4 columns');
    assert.equal(await page.locator('#tpick .grid span.on').count(), 12);
    await cell(2, 3).hover();
    assert.equal(await page.locator('#tpick .size').textContent(), '2 rows × 3 columns');
    await cell(2, 3).click();
    assert.equal(await page.locator('#tpick').count(), 0);
    const empty = '|     |     |     |\n';
    assert.equal(await page.evaluate(() => editor.text), 'Beta links [[Alpha]]\n\n' + empty + '| --- | --- | --- |\n' + empty);
    assert.equal(await page.locator('#ed .cm-table th').count(), 3);
    assert.equal(await page.locator('#ed .cm-table td').count(), 3);
    assert.equal(await page.evaluate(() => document.activeElement.matches('#ed .cm-table th[data-r="0"][data-c="0"]')), true, 'the first header cell has focus');
    await page.keyboard.type('Name');
    assert.match(await page.evaluate(() => editor.text), /^Beta links \[\[Alpha\]\]\n\n\| Name \|/);

    // Keyboard: arrows resize, Enter inserts; Escape closes without inserting.
    await page.evaluate(() => TablePicker.open(50, 50, (r, c) => { window.picked = [r, c]; }));
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown']) await page.keyboard.press(key);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.picked), [4, 3]);
    await page.evaluate(() => TablePicker.open(50, 50, () => { window.picked = 'no'; }));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tpick').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.picked), [4, 3]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the gear menu holds rarely used actions; the toolbar fits on one row on a phone', async () => {
  const { context, page, errors } = await unlocked({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 700 } });
  try {
    const visible = await page.locator('#bar > button:visible, #bar > div > button:visible').evaluateAll(els => els.map(e => e.id));
    assert.deepEqual(visible, ['menu', 'tbl', 'img', 'code', 'ol-btn', 'switch', 'gear']);
    const tops = await page.locator('#bar button:visible').evaluateAll(els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size);
    assert.equal(tops, 1, 'one row of buttons');

    await page.locator('#gear').tap();
    assert.equal(await page.locator('#gear').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.locator('#gear-menu button span').allTextContents(),
      ['Sync now', 'Note history', 'All commands', 'Sync settings', 'Move note to trash', 'Lock Vault']);
    const m = await page.locator('#gear-menu').boundingBox();
    assert.ok(m.x >= 0 && m.x + m.width <= 375, 'menu stays on screen');
    // Tapping outside closes it; picking an item closes it and runs the action.
    await page.touchscreen.tap(150, 500);
    assert.equal(await page.locator('#gear-menu').isHidden(), true);
    await page.locator('#gear').tap(); await page.locator('#hist').tap();
    assert.equal(await page.locator('#gear-menu').isHidden(), true);
    await page.locator('#dlg-hist[open]').waitFor();
    await page.locator('#h-close').tap();

    // Escape closes it and returns focus to the gear; note actions are off without an open note.
    await page.locator('#gear').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#gear-menu').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'gear');
    await page.evaluate(() => { cur = null; });
    await page.locator('#gear').click();
    assert.equal(await page.locator('#hist').isDisabled(), true);
    assert.equal(await page.locator('#del').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
