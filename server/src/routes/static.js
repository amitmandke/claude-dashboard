'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serve the web app from web/public. Returns true if the request was handled. */
function handle(req, res, url) {
  if (req.method !== 'GET') return false;
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.normalize(path.join(config.WEB_ROOT, rel));
  if (!filePath.startsWith(config.WEB_ROOT)) return false; // path traversal guard
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    // always revalidate so UI changes land on a plain refresh
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

module.exports = { handle };
