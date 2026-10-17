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
    assert.equal((await menuText(page))[0], 'Editor');
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
    assert.deepEqual(await menuText(page), ['Editor', 'More options coming soon']);
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
