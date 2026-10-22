#!/usr/bin/env node
// Run locally with your Cloudflare account. Vault passwords/keys are created only in the browser.
import { randomBytes, createPublicKey, publicEncrypt, constants } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const app = args.includes('--app-url') ? new URL(value('--app-url')) : new URL('https://ccc2223.github.io/vault/');
if (!args.includes('--worker-url')) throw new Error('Usage: npm run provision -- --worker-url https://YOUR-WORKER.workers.dev [--app-url https://YOUR-APP/]');
const worker = new URL(value('--worker-url'));
const encryptedHandoff = args.includes('--handoff-public-key');
if (process.env.GITHUB_ACTIONS === 'true' && !encryptedHandoff) throw new Error('GitHub Actions requires an encrypted setup handoff.');
let handoffKey;
if (encryptedHandoff) {
  handoffKey = createPublicKey(await readFile(value('--handoff-public-key'), 'utf8'));
  if (handoffKey.asymmetricKeyType !== 'rsa' || handoffKey.asymmetricKeyDetails.modulusLength < 3072) throw new Error('Use an RSA handoff key of at least 3072 bits.');
}
for (const url of [app, worker]) if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use HTTPS URLs without credentials, queries or fragments.');
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const origins = config.vars.ALLOWED_ORIGIN.split(',').map(s => s.trim());
if (!origins.includes(app.origin)) throw new Error('Set vars.ALLOWED_ORIGIN in wrangler.jsonc to the app origin first.');
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
if (!index.includes(worker.origin + ';') || !appSource.includes(worker.origin)) throw new Error('Update the CSP connect-src and app.js SYNC_URL to the Worker URL first.');
async function run(command, input) {
  await new Promise((resolve, reject) => {
    const child = spawn('wrangler', command, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], shell: false });
    if (input !== undefined) child.stdin.end(input + '\n');
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Wrangler exited with status ' + code)));
  });
}
const setup = randomBytes(32).toString('base64url'), session = randomBytes(32).toString('base64url');
app.hash = new URLSearchParams({ setup, server: worker.href.replace(/\/+$/, '') }).toString();
// Validate encryption before any account mutation. Only this ciphertext may enter public CI logs.
const handoff = handoffKey && publicEncrypt({ key: handoffKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: 'sha256', oaepLabel: Buffer.from('vault/deployment-handoff/v1') },
Buffer.from(JSON.stringify({ version: 1, setupURL: app.href }))).toString('base64');
if (process.env.GITHUB_ACTIONS === 'true') {
  process.stdout.write('::add-mask::' + setup + '\n::add-mask::' + session + '\n');
}
await run(['secret', 'put', 'SESSION_SECRET'], session);
await run(['secret', 'put', 'SETUP_TOKEN'], setup);
await run(['deploy']);
if (handoff) process.stdout.write('VAULT_ENCRYPTED_SETUP=' + handoff + '\n');
else process.stdout.write('\nOpen this private setup link locally; it is unusable once the vault has been initialized:\n' + app.href + '\n');
