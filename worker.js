// Keyless E2EE transport. No user password or decryption key is accepted here.
import './e2ee.js';
const IP_LIMIT = 10, IP_WINDOW = 15 * 60000;
export class LoginLimiter {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch() {
    const result = await this.storage.transaction(async tx => {
      const now = Date.now(); let window = await tx.get('window');
      if (!window || window.reset <= now) window = { count: 0, reset: now + IP_WINDOW };
      const allowed = window.count < IP_LIMIT;
      if (allowed) { window.count++; await tx.put('window', window); }
      return { allowed, retryAfter: allowed ? 0 : Math.max(1, Math.ceil((window.reset - now) / 1000)) };
    });
    return Response.json(result);
  }
}

export function createWorker(transport = (...args) => fetch(...args)) {
const C = globalThis.VaultCrypto, API = 'https://api.github.com', enc = new TextEncoder();
const HEAD = 'e2ee/head.json', MAX_BODY = 29 * 1024 * 1024;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const reject = (status, message) => { throw new HttpError(status, message); };
async function safeEqual(a, b) {
  const x = C.decode(await C.digest(String(a))), y = C.decode(await C.digest(String(b)));
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
async function signingKey(env) {
  return crypto.subtle.importKey('raw', enc.encode('vault/session/e2ee/v1\n' + env.REPO + '\n' + env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function makeSession(env, h) {
  const hours = Number(env.SESSION_HOURS) > 0 ? Math.min(Number(env.SESSION_HOURS), 8) : 8;
  const exp = Date.now() + hours * 3600000;
  const payload = { version: 1, vaultId: h.vaultId, epoch: h.epoch, authDigest: h.authDigest, exp, nonce: C.encode(C.bytes(16)) };
  const body = C.encode(C.json(payload));
  return { session: body + '.' + C.encode(await crypto.subtle.sign('HMAC', await signingKey(env), enc.encode(body))), exp };
}
async function session(req, env) {
  try {
    const token = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(req.headers.get('Authorization') || '');
    if (!token || token[1].length > 1024 || !await crypto.subtle.verify('HMAC', await signingKey(env), C.decode(token[2], 32), enc.encode(token[1]))) return null;
    const p = C.parse(C.decode(token[1], 768));
    if (p.version !== 1 || !Number.isSafeInteger(p.exp) || p.exp <= Date.now() || p.exp > Date.now() + 8 * 3600000) return null;
    return p;
  } catch { return null; }
}
async function admitLogin(req, env, scope = 'login') {
  const ip = req.headers.get('CF-Connecting-IP');
  if (!ip || !env.LOGIN_LIMITER) reject(503, 'Sign-in protection is unavailable.');
  try {
    const name = await C.digest('vault-login-e2ee-v1\n' + env.REPO + '\n' + scope + '\n' + ip);
    const response = await env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName(name)).fetch('https://limiter.internal/admit', { method: 'POST' });
    if (!response.ok) throw new Error();
    const r = await response.json();
    if (typeof r.allowed !== 'boolean' || !Number.isInteger(r.retryAfter) || r.retryAfter < 0 || r.retryAfter > 900 || (!r.allowed && !r.retryAfter)) throw new Error();
    return r;
  } catch { reject(503, 'Sign-in protection is unavailable.'); }
}
function standard64(bytes) {
  const s = C.encode(bytes).replace(/-/g, '+').replace(/_/g, '/'); return s + '='.repeat((4 - s.length % 4) % 4);
}
function githubBytes(s) {
  if (typeof s !== 'string') reject(502, 'Invalid storage response.');
  return Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
}
async function github(env, path, options = {}) {
  let response;
  try { response = await transport(API + '/repos/' + env.REPO + path, { ...options, headers: {
    Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GH_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vault-e2ee-worker',
    'Content-Type': 'application/json', 'Cache-Control': 'no-cache'
  }, redirect: 'error' }); }
  catch { reject(502, 'Encrypted storage is unavailable.'); }
  if (response.status === 404) return null;
  if (response.status === 409 || response.status === 422) reject(409, 'Storage changed. Pull and retry.');
  if (!response.ok) reject(502, 'Encrypted storage is unavailable.');
  return response.json();
}
const branch = env => env.BRANCH || 'main';
async function getFile(env, path) {
  const file = await github(env, '/contents/' + path + '?ref=' + encodeURIComponent(branch(env)));
  if (!file) return null;
  if (!/^[0-9a-f]{40}$/.test(file.sha)) reject(502, 'Invalid storage reference.');
  // Contents omits large payloads; blob reads support the 20 MB attachment limit.
  const data = file.content ? githubBytes(file.content) : githubBytes((await github(env, '/git/blobs/' + file.sha))?.content);
  return { sha: file.sha, value: C.parse(data) };
}
async function readHead(env) {
  const file = await getFile(env, HEAD); if (file) C.head(file.value); return file;
}
function objectPath(e) { return 'e2ee/objects/' + e.objectId + '/' + e.revisionId + '.enc'; }
async function putFile(env, path, value, sha) {
  const r = await github(env, '/contents/' + path, { method: 'PUT', body: JSON.stringify({
    message: 'Sync encrypted vault', content: standard64(C.json(value)), branch: branch(env), ...(sha ? { sha } : {})
  }) });
  if (!r || !/^[0-9a-f]{40}$/.test(r.content?.sha)) reject(502, 'Invalid storage response.');
  return r.content.sha;
}
async function body(req, limit = 16384) {
  if (Number(req.headers.get('Content-Length')) > limit) reject(413, 'Request is too large.');
  if (!req.body) reject(400, 'A JSON body is required.');
  const reader = req.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > limit) { await reader.cancel(); reject(413, 'Request is too large.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return C.parse(bytes);
  } catch (e) { if (e instanceof HttpError) throw e; reject(400, 'Invalid JSON request.'); }
}
async function setupAuthorized(req, env) {
  const token = /^Setup ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') || '');
  return !!(env.SETUP_TOKEN && token && await safeEqual(token[1], env.SETUP_TOKEN));
}
return {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const ok = allowed.includes(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
      ...(ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Expose-Headers': 'Retry-After', 'Access-Control-Max-Age': '86400' } : {}) };
    const reply = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers });
    if (!ok) return reply({ message: 'Origin not allowed.' }, 403);
    if (!env.GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.REPO || '') || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) return reply({ message: 'Server not configured.' }, 503);
    const url = new URL(req.url);
    try {
      if (url.search) reject(400, 'Query parameters are not supported.');
      if (url.pathname === '/vault/bootstrap' && req.method === 'GET') {
        const admission = await admitLogin(req, env, 'bootstrap');
        if (!admission.allowed) return reply({ message: 'Too many unlock requests. Try later.' }, 429, { 'Retry-After': String(admission.retryAfter) });
        const current = await readHead(env);
        return reply({ head: current?.value || null, sha: current?.sha || null });
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const admission = await admitLogin(req, env);
        if (!admission.allowed) return reply({ message: 'Too many sign-in attempts. Try later.' }, 429, { 'Retry-After': String(admission.retryAfter) });
        const data = await body(req, 512), current = await readHead(env);
        let digest;
        try { if (C.decode(data.accessSecret, 32).length === 32) digest = await C.digest(C.decode(data.accessSecret)); } catch {}
        if (!current || !digest || !await safeEqual(digest, current.value.authDigest)) return reply({ message: 'Cloud credentials changed. Unlock with the current password.' }, 401);
        return reply(await makeSession(env, current.value));
      }
      const isSetup = url.pathname === '/vault/setup' && req.method === 'POST';
      const objectMatch = /^\/vault\/objects\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(url.pathname);
      const isObject = objectMatch && ['GET', 'PUT'].includes(req.method);
      const isCommit = url.pathname === '/vault/commit' && req.method === 'POST';
      const isHead = url.pathname === '/vault/head' && req.method === 'GET';
      if (!isSetup && !isObject && !isCommit && !isHead) reject(404, 'Not found.');
      const proof = await session(req, env);
      const setup = !proof && await setupAuthorized(req, env);
      if (!proof && !setup) reject(401, 'Signed out.');
      const current = await readHead(env);
      if (setup && current) reject(409, 'Vault is already initialized.');
      if (proof && (!current || proof.vaultId !== current.value.vaultId || proof.epoch !== current.value.epoch || proof.authDigest !== current.value.authDigest)) reject(401, 'Cloud credentials changed. Unlock with the current password.');
      if (isHead) { if (setup) reject(403, 'Not initialized.'); return reply({ head: current.value, sha: current.sha }); }
      if (isObject) {
        const [, objectId, revisionId] = objectMatch, identity = { objectId, revisionId };
        C.ref({ ...identity, sha: '0'.repeat(40), kind: 'file' }, 'file');
        if (req.method === 'GET') {
          if (setup) reject(403, 'Setup cannot read vault data.');
          const file = await getFile(env, objectPath(identity));
          if (!file) reject(404, 'Encrypted object is missing.');
          C.record(file.value, null, current.value);
          return reply({ record: file.value, sha: file.sha });
        }
        const record = await body(req, MAX_BODY);
        if (current && ![current.value.epoch, current.value.epoch + 1].includes(record.epoch)) reject(400, 'Invalid key epoch.');
        C.record(record, { ...identity, kind: record.kind }, current ? { ...current.value, epoch: record.epoch } : { vaultId: record.vaultId, epoch: 1 });
        if (setup && record.kind !== 'manifest') reject(403, 'Setup can only upload an empty-vault manifest.');
        let sha;
        try { sha = await putFile(env, objectPath(identity), record); }
        catch (e) {
          if (e.status !== 409) throw e;
          const old = await getFile(env, objectPath(identity));
          if (!old || JSON.stringify(old.value) !== JSON.stringify(record)) throw e;
          sha = old.sha;
        }
        return reply({ sha });
      }
      if (isSetup && !setup) reject(403, 'A setup link is required.');
      if (isCommit && setup) reject(403, 'Setup cannot update a vault.');
      const data = await body(req), next = C.head(data.head);
      if (isSetup) {
        if (next.epoch !== 1 || next.generation !== 1 || data.expectedHeadSha !== null) reject(400, 'Invalid initial checkpoint.');
      } else {
        const old = current.value;
        if (data.expectedHeadSha !== current.sha) reject(409, 'Vault changed. Pull and retry.');
        if (next.vaultId !== old.vaultId || next.generation !== old.generation + 1 || ![old.epoch, old.epoch + 1].includes(next.epoch)) reject(400, 'Invalid checkpoint transition.');
        if (next.epoch === old.epoch && (next.authDigest !== old.authDigest || JSON.stringify(next.unlock) !== JSON.stringify(old.unlock) || JSON.stringify(next.recovery) !== JSON.stringify(old.recovery))) reject(400, 'Key changes require a new epoch.');
        if (next.epoch !== old.epoch && next.authDigest === old.authDigest) reject(400, 'Rotation requires new cloud credentials.');
      }
      const manifest = await getFile(env, objectPath(next.manifest));
      if (!manifest || manifest.sha !== next.manifest.sha || manifest.value.kind !== 'manifest') reject(400, 'Manifest was not uploaded.');
      C.record(manifest.value, next.manifest, next);
      const sha = await putFile(env, HEAD, next, current?.sha);
      return reply({ head: next, sha });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      return reply({ message: e instanceof HttpError ? e.message : 'Invalid encrypted vault request.' }, status, status === 503 ? { 'Retry-After': '60' } : {});
    }
  }
};

}
export default createWorker();
