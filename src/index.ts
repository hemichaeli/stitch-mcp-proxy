import http from 'http';
import https from 'https';

const STITCH_HOST = 'stitch.googleapis.com';
const STITCH_PATH = '/mcp';
const PROXY_URL = (process.env.PROXY_URL || 'https://stitch-mcp-proxy-production.up.railway.app').replace(/\/$/, '');
const API_KEY = process.env.STITCH_API_KEY || '';
const PORT = Number(process.env.PORT) || 3000;

if (!API_KEY) {
  console.error('ERROR: STITCH_API_KEY environment variable is not set');
  process.exit(1);
}

// Rewrite any stitch.googleapis.com references to point at this proxy. Broad on purpose:
// covers the /mcp URL, the bare origin, and the host token (in bodies AND headers).
const PROXY_HOST = PROXY_URL.replace(/^https?:\/\//, '');
function rewrite(s: string): string {
  return s
    .replace(/https:\/\/stitch\.googleapis\.com\/mcp/g, PROXY_URL)
    .replace(/https:\/\/stitch\.googleapis\.com/g, PROXY_URL)
    .replace(/stitch\.googleapis\.com/g, PROXY_HOST);
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', PROXY_URL);
  const path = url.pathname;

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // ── OAuth surface (entirely on this proxy's origin) ──────────────────────
  // The proxy authenticates to Stitch with an API key, so the client's bearer is
  // irrelevant. We expose a complete, always-approve OAuth 2.1 surface so MCP
  // clients that insist on OAuth can complete the flow against us, never Google.

  if (path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/mcp') {
    sendJson(res, 200, {
      resource: PROXY_URL,
      authorization_servers: [PROXY_URL],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
    return;
  }

  if (path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/openid-configuration') {
    sendJson(res, 200, {
      issuer: PROXY_URL,
      authorization_endpoint: `${PROXY_URL}/authorize`,
      token_endpoint: `${PROXY_URL}/token`,
      registration_endpoint: `${PROXY_URL}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
    return;
  }

  // Dynamic client registration — accept anything, echo a client_id.
  if (path === '/register') {
    let meta: any = {};
    try { meta = JSON.parse(await readBody(req) || '{}'); } catch { /* ignore */ }
    sendJson(res, 201, {
      client_id: 'stitch-mcp-proxy-client',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
    });
    return;
  }

  // Authorize — auto-approve: bounce straight back to the client's redirect_uri
  // with a dummy code (PKCE is accepted but not verified; the proxy is the trust
  // boundary and uses its own API key upstream).
  if (path === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') || '';
    if (!redirectUri) { sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri required' }); return; }
    const loc = new URL(redirectUri);
    loc.searchParams.set('code', 'stitch-proxy-auth-code');
    if (state) loc.searchParams.set('state', state);
    res.writeHead(302, { Location: loc.toString(), 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // Token — issue a bearer (ignored upstream; the API key does the real auth).
  if (path === '/token') {
    await readBody(req); // drain
    sendJson(res, 200, {
      access_token: 'stitch-proxy-token',
      token_type: 'Bearer',
      // Long-lived on purpose: the proxy is always-approve and real auth is the
      // injected API key, so a short TTL only forces pointless hourly re-auth in
      // MCP clients that don't silently refresh. 10 years.
      expires_in: 315360000,
      refresh_token: 'stitch-proxy-refresh',
      scope: 'mcp',
    });
    return;
  }

  // CORS preflight for any browser-driven OAuth step.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // ── Transparent forward of everything else to Stitch ─────────────────────
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'transfer-encoding' ||
      lower === 'keep-alive' ||
      lower === 'upgrade' ||
      lower === 'proxy-authorization' ||
      lower === 'authorization' || // client bearer is irrelevant; key is injected
      lower === 'accept-encoding' || // force identity upstream — we buffer+rewrite text, so we cannot relay compressed bodies
      lower === 'te' ||
      lower === 'trailers'
    ) continue;
    if (value !== undefined) headers[key] = value;
  }

  headers['host'] = STITCH_HOST;
  headers['x-goog-api-key'] = API_KEY;
  headers['accept-encoding'] = 'identity'; // never let Stitch gzip: the text path decodes as utf8 and would corrupt a compressed body

  const options: https.RequestOptions = {
    hostname: STITCH_HOST,
    port: 443,
    path: STITCH_PATH,
    method: req.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    console.log(`[${new Date().toISOString()}] Response: ${proxyRes.statusCode}`);

    // Rewrite any leaked stitch.googleapis.com references in response HEADERS.
    const baseHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue;
      if (key.toLowerCase() === 'content-length') continue; // recalculated when buffered
      baseHeaders[key] = Array.isArray(value) ? value.map(rewrite) : rewrite(value);
    }
    baseHeaders['access-control-allow-origin'] = '*';

    const contentType = String(proxyRes.headers['content-type'] || '');
    const isText = contentType.includes('application/json') ||
                   contentType.includes('text/') ||
                   contentType.includes('application/x-ndjson') ||
                   contentType.includes('event-stream');

    if (isText) {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', (chunk) => { body += chunk; });
      proxyRes.on('end', () => {
        const out = rewrite(body);
        // We decoded the body as utf8 text, so any upstream content-encoding no longer applies.
        delete baseHeaders['content-encoding'];
        delete baseHeaders['Content-Encoding'];
        baseHeaders['content-length'] = Buffer.byteLength(out).toString();
        res.writeHead(proxyRes.statusCode || 502, baseHeaders);
        res.end(out);
      });
      proxyRes.on('error', (err) => {
        console.error('Response read error:', err.message);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    } else {
      res.writeHead(proxyRes.statusCode || 502, baseHeaders);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`Stitch MCP Proxy running on port ${PORT}`);
  console.log(`Proxy URL: ${PROXY_URL}`);
  console.log(`Forwarding to https://${STITCH_HOST}${STITCH_PATH}`);
});
