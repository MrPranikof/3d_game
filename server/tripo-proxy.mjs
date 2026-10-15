// Tripo3D API v2.5 proxy — keeps TRIPO_API_KEY on the server.
//   TRIPO_API_KEY=tsk_... node server/tripo-proxy.mjs      (Vite forwards /api/tripo → :8787)
// Routes:
//   GET  /api/tripo/health          → { ok, hasKey }
//   POST /api/tripo/task            → POST https://api.tripo3d.ai/v2/openapi/task
//   GET  /api/tripo/task/:id        → GET  https://api.tripo3d.ai/v2/openapi/task/:id
//   GET  /api/tripo/fetch?url=…     → streams a generated model (Tripo CDN hosts only)
import http from 'node:http';

const PORT = Number(process.env.TRIPO_PROXY_PORT ?? 8787);
const KEY = process.env.TRIPO_API_KEY ?? '';
const API = 'https://api.tripo3d.ai/v2/openapi';
const ALLOWED_TASKS = new Set(['text_to_model', 'animate_prerigcheck', 'animate_rig', 'convert_model']);

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/tripo/, '');
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, hasKey: KEY.length > 0 });
    if (!KEY) return send(res, 503, { code: -1, message: 'TRIPO_API_KEY not configured' });
    const auth = { Authorization: `Bearer ${KEY}` };

    if (req.method === 'POST' && path === '/task') {
      const body = JSON.parse(await readBody(req));
      if (!ALLOWED_TASKS.has(body.type)) return send(res, 400, { code: -1, message: `task type ${body.type} not allowed` });
      const r = await fetch(`${API}/task`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return send(res, r.status, await r.text());
    }
    const m = path.match(/^\/task\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const r = await fetch(`${API}/task/${m[1]}`, { headers: auth });
      return send(res, r.status, await r.text());
    }
    if (req.method === 'GET' && path === '/fetch') {
      const target = new URL(url.searchParams.get('url') ?? '');
      if (target.protocol !== 'https:' || !/(^|\.)tripo3d\.(ai|com)$|(^|\.)tripo-data\.|amazonaws\.com$|cloudfront\.net$/.test(target.hostname)) {
        return send(res, 400, { code: -1, message: 'host not allowed' });
      }
      const r = await fetch(target);
      if (!r.ok) return send(res, r.status, { code: -1, message: `upstream ${r.status}` });
      return send(res, 200, new Uint8Array(await r.arrayBuffer()), 'model/gltf-binary');
    }
    send(res, 404, { code: -1, message: 'not found' });
  } catch (e) {
    send(res, 500, { code: -1, message: String(e?.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`[tripo-proxy] :${PORT} key ${KEY ? 'configured' : 'MISSING'}`));
