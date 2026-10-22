const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('real workerd + SQLite Durable Objects serialize concurrent production login admission', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vault-runtime-'));
  const child = spawn('wrangler', ['dev', '--local', '--ip', '127.0.0.1', '--port', '8799', '--config', 'tests/wrangler.runtime.jsonc', '--persist-to', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' } });
  let output = '', failed;
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; }); child.on('error', e => { failed = e; });
  const url = 'http://127.0.0.1:8799/';
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      if (failed) throw failed;
      try { ready = (await fetch(url + '?ip=readiness', { signal: AbortSignal.timeout(500) })).status === 401; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, output);
    const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(url + '?ip=192.0.2.99')));
    assert.equal(responses.filter(r => r.status === 401).length, 10, output);
    assert.equal(responses.filter(r => r.status === 429).length, 40, output);
    assert.ok(Number(responses.find(r => r.status === 429).headers.get('Retry-After')) > 0);
    assert.equal((await fetch(url + '?ip=192.0.2.100')).status, 401);
  } finally {
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
