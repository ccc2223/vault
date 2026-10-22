const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./support/browser.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let server, browser, base, version = 'A';

before(async () => {
  const root = path.join(__dirname, '..');
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(root, name);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { res.writeHead(404).end(); return; }
    // Each deploy changes the shell and the cache name, like a real release.
    if (name === 'editor.js') body += `\nwindow.shellVersion = '${version}';`;
    if (name === 'sw.js') body = body.replace(/const CACHE = '[^']+'/, `const CACHE = 'vault-test-${version}'`);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'text/plain');
    res.setHeader('Cache-Control', 'max-age=600'); // what GitHub Pages sends
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

test('a new release replaces the cached shell even while the old files are still HTTP-fresh', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert.equal(await page.evaluate(() => window.shellVersion), 'A');

    version = 'B';
    await page.reload();
    // The new worker takes over and the locked page reloads itself onto the new code.
    await page.waitForFunction(() => window.shellVersion === 'B', null, { timeout: 10000 });
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const text = await (await (await caches.open(keys[0])).match('editor.js')).text();
      return { keys, version: text.match(/shellVersion = '(\w)'/)[1] };
    });
    assert.deepEqual(cached, { keys: ['vault-test-B'], version: 'B' });
  } finally { await context.close(); version = 'A'; }
});

