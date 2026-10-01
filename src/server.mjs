import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ApiError, createEngine } from './engine.mjs';

const engine = createEngine();
const adminKey = process.env.ORCHESTRATOR_ADMIN_KEY ?? 'local-admin';
const digest = value => createHash('sha256').update(value).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

function bearer(request) {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
  if (!match) throw new ApiError(401, 'Bearer token required');
  return match[1];
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ApiError(413, 'JSON body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON body'); }
}

function send(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

export function createApp(store = engine) {
  return http.createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/health') return send(response, 200, { ok: true });
      const credential = /^\/admin\/tenants\/([^/]+)\/credential$/.exec(path);
      if (credential && request.method === 'PUT') {
        if (!same(bearer(request), adminKey)) throw new ApiError(403, 'Admin token rejected');
        return send(response, 200, store.setCredential(credential[1], (await body(request)).key));
      }
      const tenant = store.authenticate(bearer(request));
      const workflow = /^\/v1\/workflows\/([^/]+)$/.exec(path);
      if (workflow && request.method === 'PUT') return send(response, 200, store.publish(tenant, workflow[1], await body(request)));
      if (workflow && request.method === 'GET') return send(response, 200, store.getWorkflow(tenant, workflow[1]));
      const start = /^\/v1\/workflows\/([^/]+)\/runs$/.exec(path);
      if (start && request.method === 'POST') {
        const result = store.start(tenant, start[1], (await body(request)).input, request.headers['idempotency-key']);
        return send(response, result.replayed ? 200 : 201, result);
      }
      const run = /^\/v1\/runs\/([^/]+)$/.exec(path);
      if (run && request.method === 'GET') return send(response, 200, store.getRun(tenant, run[1]));
      const advance = /^\/v1\/runs\/([^/]+)\/advance$/.exec(path);
      if (advance && request.method === 'POST') return send(response, 200, store.advance(tenant, advance[1]));
      if (request.method === 'GET' && path === '/v1/audit') return send(response, 200, { events: store.getAudit(tenant) });
      throw new ApiError(404, 'Route not found');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      send(response, status, { error: status === 500 ? 'Internal error' : error.message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3008);
  createApp().listen(port, () => console.log(`Workflow orchestrator listening on http://localhost:${port}`));
}
