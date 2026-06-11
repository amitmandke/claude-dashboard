#!/usr/bin/env node
'use strict';

/**
 * Claude Dashboard server — see ../../DESIGN.md.
 * Run: node server/src/index.js   then open http://localhost:7777
 */

const http = require('http');

const config = require('./config');
const api = require('./routes/api');
const staticFiles = require('./routes/static');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${config.HOST}:${config.PORT}`);
  try {
    if (await api.handle(req, res, url)) return;
    if (staticFiles.handle(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(config.PORT, config.HOST, () => {
  console.log(`Claude Dashboard → http://localhost:${config.PORT}`);
});
