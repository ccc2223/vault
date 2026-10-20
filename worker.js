// Vault sync server — a Cloudflare Worker.
// Holds your GitHub token as a secret; the app signs in with a password and gets a session.
//
// Variables (Worker → Settings → Variables and Secrets):
//   GH_TOKEN        secret  fine-grained token for the notes repo (Contents: read & write)
//   PASSWORD        secret  the password you type in the app
//   REPO            text    e.g. ccc2223/vault-files
//   ALLOWED_ORIGIN  text    e.g. https://ccc2223.github.io   (comma-separate several)
//   SESSION_HOURS   text    optional, default and maximum 8
//   SESSION_SECRET  secret  optional; change it to sign out every device without changing PASSWORD
//   LIMITS          KV      optional binding; limits wrong passwords to 10 per IP per 15 minutes and 100 per hour

const API = 'https://api.github.com';
const enc = new TextEncoder();

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(env, msg) {
  // Key depends on the token and password: changing either signs out every device.
  const secret = env.SESSION_SECRET ? '\n' + env.SESSION_SECRET : '';
  const key = await crypto.subtle.importKey('raw', enc.encode('vault-session-v3\n' + env.REPO + '\n' + env.GH_TOKEN + '\n' + env.PASSWORD + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

async function makeSession(env) {
  const configured = Number(env.SESSION_HOURS);
  const hours = configured > 0 ? Math.min(configured, 8) : 8;
  const exp = Date.now() + hours * 3600000;
  return { session: exp + '.' + await hmac(env, String(exp)), exp };
}

async function checkSession(env, s) {
  const m = /^(\d+)\.([\w-]+)$/.exec(s || '');
  if (!m || Number(m[1]) <= Date.now() || Number(m[1]) > Date.now() + 8 * 3600000) return false;
  return safeEqual(m[2], await hmac(env, m[1]));
}

// Wrong-password counters in Workers KV: one window per IP and one for everyone. KV is eventually consistent, so the
// limits are approximate. Without the LIMITS binding, or if KV fails, logins are not limited beyond the 1 s delay.
const IP_LIMIT = 10, IP_WINDOW = 15 * 60000, ALL_LIMIT = 100, ALL_WINDOW = 3600000;
function limitKeys(req) {
  const now = Date.now(), ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  return [
    { key: 'login:ip:' + ip + ':' + Math.floor(now / IP_WINDOW), limit: IP_LIMIT, ttl: 2 * IP_WINDOW / 1000 },
    { key: 'login:all:' + Math.floor(now / ALL_WINDOW), limit: ALL_LIMIT, ttl: 2 * ALL_WINDOW / 1000 }
  ];
}
async function limited(env, keys) {
  if (!env.LIMITS) return false;
  try {
    const counts = await Promise.all(keys.map(k => env.LIMITS.get(k.key)));
    return keys.some((k, i) => Number(counts[i]) >= k.limit);
  } catch { return false; }
}
async function recordFailure(env, keys) {
  if (!env.LIMITS) return;
  try {
    await Promise.all(keys.map(async k => {
      const n = Number(await env.LIMITS.get(k.key)) || 0;
      await env.LIMITS.put(k.key, String(n + 1), { expirationTtl: k.ttl });
    }));
  } catch {}
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    } : { 'Vary': 'Origin' };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

    if (req.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (!okOrigin) return json({ message: 'Origin not allowed' }, 403);
    if (!env.GH_TOKEN || !env.PASSWORD || !env.REPO) return json({ message: 'Server not configured' }, 500);

    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      const keys = limitKeys(req);
      if (await limited(env, keys)) {
        return new Response(JSON.stringify({ message: 'Too many wrong passwords. Try again later.' }), {
          status: 429, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '900' }
        });
      }
      let body;
      try { body = await req.json(); } catch { return json({ message: 'Bad request' }, 400); }
      if (typeof body?.password !== 'string' || !(await safeEqual(body.password, env.PASSWORD))) {
        await recordFailure(env, keys);
        await new Promise(r => setTimeout(r, 1000));
        return json({ message: 'Wrong password' }, 401);
      }
      return json(await makeSession(env));
    }

    if (url.pathname.startsWith('/gh/')) {
      const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!(await checkSession(env, auth))) return json({ message: 'Signed out' }, 401);

      const sub = url.pathname.slice(3); // e.g. /git/trees/main
      const allowedPath = /^\/(git\/trees|git\/blobs|contents)\//.test(sub) && !/\.\.|%2e%2e/i.test(sub);
      if (!allowedPath || !['GET', 'PUT', 'DELETE'].includes(req.method)) return json({ message: 'Not allowed' }, 403);

      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + env.GH_TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'vault-sync-worker'
      };
      if (req.method !== 'GET') headers['Content-Type'] = 'application/json';
      const r = await fetch(API + '/repos/' + env.REPO + sub + url.search, {
        method: req.method, headers, body: req.method === 'GET' ? undefined : await req.text()
      });
      return new Response(r.body, {
        status: r.status,
        headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    return json({ message: 'Not found' }, 404);
  }
};
