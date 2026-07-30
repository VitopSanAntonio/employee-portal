// Shared helpers for the browser test suites: a static file server for the
// repo root and a Chromium launcher that works both locally and in CI.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.json': 'application/json'
};

export function startServer(port) {
  const server = http.createServer((req, res) => {
    try {
      const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

export function launchBrowser() {
  // CI installs Playwright's own Chromium; some local environments provide a
  // system binary instead (via CHROMIUM_PATH or the /opt/pw-browsers mount).
  const local = '/opt/pw-browsers/chromium';
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync(local) ? local : undefined);
  return chromium.launch({ executablePath });
}

export function report(results) {
  console.table(results);
  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? `FAILED: ${failed.length}` : 'ALL PASS');
  process.exit(failed.length ? 1 : 0);
}
