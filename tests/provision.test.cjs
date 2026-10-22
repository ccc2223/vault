const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, open } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { generateKeyPairSync, privateDecrypt, constants } = require('node:crypto');
async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vault-provision-'));
  await mkdir(path.join(dir, 'scripts')); await mkdir(path.join(dir, 'bin'));
  await copyFile(path.join(__dirname, '../scripts/provision.mjs'), path.join(dir, 'scripts/provision.mjs'));
  await writeFile(path.join(dir, 'wrangler.jsonc'), JSON.stringify({ vars: { ALLOWED_ORIGIN: 'https://app.example' } }));
  await writeFile(path.join(dir, 'index.html'), 'https://sync.example;');
  await writeFile(path.join(dir, 'app.js'), 'https://sync.example');
  await writeFile(path.join(dir, 'bin/wrangler'), `#!/usr/bin/env node
const fs=require('node:fs');const input=fs.readFileSync(0,'utf8').trim();fs.appendFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),input})+'\\n');
`, { mode: 0o755 });
  const calls = path.join(dir, 'calls.jsonl');
  const run = async extra => {
    const out = await open(path.join(dir, 'stdout'), 'w'), err = await open(path.join(dir, 'stderr'), 'w');
    const env = { ...process.env, GITHUB_ACTIONS: 'true', PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, CALLS: calls };
    delete env.NODE_TEST_CONTEXT;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/provision.mjs', '--worker-url', 'https://sync.example', '--app-url', 'https://app.example/vault/', ...extra], {
        cwd: dir, env, stdio: ['ignore', out.fd, err.fd]
      });
      child.on('error', reject); child.on('close', resolve);
    });
    await out.close(); await err.close();
    return { code, stdout: await readFile(path.join(dir, 'stdout'), 'utf8'), stderr: await readFile(path.join(dir, 'stderr'), 'utf8') };
  };
  return { dir, calls, run, close: () => rm(dir, { recursive: true, force: true }) };
}
test('CI provisioning encrypts its setup handoff, masks generated secrets and preserves the existing repository token', async () => {
  const f = await sandbox();
  try {
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    await writeFile(path.join(f.dir, 'handoff.pem'), pair.publicKey);
    const result = await f.run(['--handoff-public-key', 'handoff.pem']);
    assert.equal(result.code, 0, result.stderr);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(c => c.args), [['secret', 'put', 'SESSION_SECRET'], ['secret', 'put', 'SETUP_TOKEN'], ['deploy']]);
    assert.equal(calls[0].input.length, 43, JSON.stringify(calls.map(c=>({args:c.args,length:c.input.length})))); assert.notEqual(calls[0].input, calls[1].input);
    for (const c of calls.slice(0, 2)) assert.ok(result.stdout.includes('::add-mask::' + c.input), JSON.stringify({lines:result.stdout.split('\n').map(s=>({prefix:s.slice(0,10),length:s.length})),stderrLength:result.stderr.length}));
    const visible = result.stdout.replace(/^::add-mask::.*$/gm, '');
    for (const c of calls.slice(0, 2)) assert.equal(visible.includes(c.input), false);
    assert.equal(visible.includes('https://app.example/'), false);
    const encoded = /^VAULT_ENCRYPTED_SETUP=(.+)$/m.exec(visible)[1];
    const decoded = JSON.parse(privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from('vault/deployment-handoff/v1') }, Buffer.from(encoded, 'base64')));
    const url = new URL(decoded.setupURL), fragment = new URLSearchParams(url.hash.slice(1));
    assert.equal(decoded.version, 1); assert.equal(url.origin, 'https://app.example');
    assert.equal(fragment.get('setup'), calls[1].input); assert.equal(fragment.get('server'), 'https://sync.example');
  } finally { await f.close(); }
});
test('CI refuses a plaintext handoff before changing any Worker secret', async () => {
  const f = await sandbox();
  try {
    const result = await f.run([]); assert.notEqual(result.code, 0);
    assert.match(result.stderr, /encrypted setup handoff/);
    await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
  } finally { await f.close(); }
});
