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
      const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]);
      const file = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
      // Confine to ROOT: path.join alone let "/../../etc/passwd" escape and
      // serve any file the test runner could read.
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  // Surface a busy port as a clear failure instead of a promise that never
  // settles and a suite that appears to hang.
  return new Promise((resolve, reject) => {
    server.once('error', err => reject(
      err.code === 'EADDRINUSE'
        ? new Error(`port ${port} is already in use — another test run may still be going`)
        : err
    ));
    server.listen(port, () => resolve(server));
  });
}

/**
 * Waits for `fn()` to return truthy, polling instead of sleeping a fixed
 * interval. Fixed waits were both slower than needed and flaky under CI load.
 */
export async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise(r => setTimeout(r, interval));
  }
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
