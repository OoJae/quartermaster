// Code that runs INSIDE the credential-proxy VM. Real provider secrets exist only in this process's env.
// Routes are enabled per capability; anything else is denied and logged.

export const PROXY_JS = String.raw`
const http = require('http');
const E = process.env;
const has = (k) => E[k] && E[k] !== 'placeholder';
const caps = { database: has('NEON_CONN'), email: has('RESEND_KEY'), payments: has('STRIPE_KEY') };
const HOP = ['host','connection','keep-alive','transfer-encoding','content-length','accept-encoding','upgrade','proxy-connection'];
const secrets = [E.NEON_CONN, E.RESEND_KEY, E.STRIPE_KEY].filter((s) => s && s !== 'placeholder');
const scrub = (t) => secrets.reduce((acc, s) => acc.split(s).join('[redacted]'), t);
const log = (o) => console.log(JSON.stringify({ t: Date.now(), ...o }));

function route(url) {
  if (url.startsWith('/neon/sql')) return { cap: 'database', target: 'https://' + E.NEON_API_HOST + '/sql', set: (h) => { h['neon-connection-string'] = E.NEON_CONN; } };
  if (url.startsWith('/resend/')) return { cap: 'email', target: 'https://api.resend.com/' + url.slice(8), set: (h) => { h['authorization'] = 'Bearer ' + E.RESEND_KEY; } };
  if (url.startsWith('/v1/')) return { cap: 'payments', target: 'https://api.stripe.com' + url, set: (h) => { h['authorization'] = 'Bearer ' + E.STRIPE_KEY; } };
  return null;
}

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.url === '/_qm/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, caps })); }
  const r = route(req.url);
  if (!r) { log({ decision: 'DENY', reason: 'unknown_route', method: req.method, url: req.url }); res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'denied', reason: 'route not on the site allowlist' })); }
  if (!caps[r.cap]) { log({ decision: 'DENY', reason: 'no_capability', cap: r.cap, method: req.method, url: req.url }); res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'no_capability', capability: r.cap, hint: 'call the requisition tool for capability "' + r.cap + '"' })); }
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) headers[k] = v;
  r.set(headers);
  try {
    const up = await fetch(r.target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const text = scrub(await up.text());
    log({ decision: 'ALLOW', cap: r.cap, method: req.method, url: req.url.split('?')[0], status: up.status });
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'text/plain' });
    res.end(text);
  } catch (e) {
    log({ decision: 'ERROR', cap: r.cap, url: req.url, error: String(e && e.message) });
    res.writeHead(502); res.end('upstream error');
  }
}).listen(8080, '0.0.0.0', () => log({ decision: 'START', caps }));
`;

export const VERDACCIO_YAML = `
storage: /opt/qm/verdaccio/storage
auth:
  htpasswd:
    file: /opt/qm/verdaccio/htpasswd
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '**':
    access: $all
    proxy: npmjs
listen: 0.0.0.0:4873
log: { type: stdout, format: pretty, level: warn }
`;
