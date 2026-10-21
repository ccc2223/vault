// Test-only harness: run the production login handler with real SQLite Durable Objects.
import { createWorker, LoginLimiter } from '../worker.js';
export { LoginLimiter };
const worker = createWorker(async () => new Response(null, { status: 404 }));
export default {
  fetch(request, env) {
    const ip = new URL(request.url).searchParams.get('ip') || '192.0.2.1';
    return worker.fetch(new Request('https://sync.example/login', {
      method: 'POST', headers: { Origin: 'https://app.example', 'CF-Connecting-IP': ip }, body: '{}'
    }), { ...env, GH_TOKEN: 'test-only', REPO: 'test/runtime', ALLOWED_ORIGIN: 'https://app.example', SESSION_SECRET: 'test-only-independent-session-secret-32' });
  }
};
