// Tiny static server for the CAD viewer. No dependencies.  Usage: node server.js  (PORT env optional)
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync } from 'node:fs';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const handler = (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (path === '/api/samples') {
    let files = [];
    try {
      files = readdirSync(join(ROOT, 'samples'), { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, size: statSync(join(ROOT, 'samples', e.name)).size }));
    } catch { /* no samples folder */ }
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(files));
    return;
  }

  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
};

// Starts the server and resolves with the port actually used (pass 0 for any free port).
export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Run directly: node server.js
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startServer().then((port) => console.log(`Norma running at http://localhost:${port}`));
}
