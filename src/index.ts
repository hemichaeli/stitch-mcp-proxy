import http from 'http';
import https from 'https';

const STITCH_HOST = 'stitch.googleapis.com';
const STITCH_PATH = '/mcp';
const PROXY_URL = process.env.PROXY_URL || 'https://stitch-mcp-proxy-production.up.railway.app';
const API_KEY = process.env.STITCH_API_KEY || '';
const PORT = Number(process.env.PORT) || 3000;

if (!API_KEY) {
  console.error('ERROR: STITCH_API_KEY environment variable is not set');
  process.exit(1);
}

// Rewrite any stitch.googleapis.com URLs to point to our proxy
function rewriteBody(body: string): string {
  return body.replace(/https:\/\/stitch\.googleapis\.com\/mcp/g, PROXY_URL);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Serve our own OAuth protected resource metadata
  // This tells MCP clients that our proxy URL is the resource - no OAuth required
  if (req.url === '/.well-known/oauth-protected-resource') {
    const metadata = JSON.stringify({
      resource: PROXY_URL,
      bearer_methods_supported: ['header'],
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(metadata).toString(),
    });
    res.end(metadata);
    return;
  }

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Build forwarded headers - strip hop-by-hop headers
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
      lower === 'te' ||
      lower === 'trailers'
    ) continue;
    if (value !== undefined) headers[key] = value;
  }

  headers['host'] = STITCH_HOST;
  headers['x-goog-api-key'] = API_KEY;

  const options: https.RequestOptions = {
    hostname: STITCH_HOST,
    port: 443,
    path: STITCH_PATH,
    method: req.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    console.log(`[${new Date().toISOString()}] Response: ${proxyRes.statusCode}`);

    const contentType = proxyRes.headers['content-type'] || '';
    const isText = contentType.includes('application/json') ||
                   contentType.includes('text/') ||
                   contentType.includes('application/x-ndjson');

    if (isText) {
      // Buffer text responses to rewrite stitch.googleapis.com URLs
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', chunk => { body += chunk; });
      proxyRes.on('end', () => {
        const rewritten = rewriteBody(body);
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (key.toLowerCase() === 'content-length') continue; // recalculate
          if (value !== undefined) responseHeaders[key] = value;
        }
        responseHeaders['content-length'] = Buffer.byteLength(rewritten).toString();
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        res.end(rewritten);
      });
      proxyRes.on('error', (err) => {
        console.error('Response read error:', err.message);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    } else {
      // Stream binary responses directly
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) responseHeaders[key] = value;
      }
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`Stitch MCP Proxy running on port ${PORT}`);
  console.log(`Proxy URL: ${PROXY_URL}`);
  console.log(`Forwarding to https://${STITCH_HOST}${STITCH_PATH}`);
});
