import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createThemeStore } from './themes.mjs';
import { createAbletonApp } from './ableton-app.mjs';

export const STUDIO_PORT = 7666;

export async function startServer(control, themes = createThemeStore(), { port = STUDIO_PORT, abletonApp = createAbletonApp() } = {}) {
  const token = randomBytes(32).toString('hex');
  // Read per request so edits (and extension reloads) are picked up without restarting the server.
  const asset = name => readFile(new URL(name, import.meta.url), 'utf8');
  const backgroundImage = await readFile(new URL('background.png', import.meta.url)).catch(() => null);
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'");
    const reply = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      if (req.headers.host !== new URL(origin).host) return reply(403, { error: 'Invalid host.' });
      if (req.method === 'GET') {
        if (req.url === '/' || req.url === '/track' || /^\/track\/-?\d+$/.test(req.url)) return reply(200, (await asset('creative.html')).replace('__TOKEN__', token), 'text/html');
        if (req.url === '/classic') return reply(200, (await asset('index.html')).replace('__TOKEN__', token), 'text/html');
        if (req.url === '/creative-client.js') return reply(200, await asset('creative-client.js'), 'text/javascript');
        if (req.url === '/creative.css') return reply(200, await asset('creative.css'), 'text/css');
        if (req.url === '/client.js') return reply(200, await asset('client.js'), 'text/javascript');
        if (req.url === '/style.css') return reply(200, await asset('style.css'), 'text/css');
        if (req.url === '/background.png' && backgroundImage) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(backgroundImage);
        }
        return reply(404, { error: 'Not found.' });
      }
      const supplied = Buffer.from(req.headers['x-livepilot-token'] || '');
      const expected = Buffer.from(token);
      if (req.method !== 'POST' || req.headers.origin !== origin ||
          req.headers['content-type'] !== 'application/json' ||
          supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return reply(403, { error: 'Request must originate from the LivePilot panel.' });
      }
      if (!['/refresh', '/inspect', '/command', '/catalog', '/query', '/themes', '/theme', '/creative', '/creative-state',
        '/ableton-status', '/ableton-launch'].includes(req.url)) return reply(404, { error: 'Not found.' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16384) return reply(413, { error: 'Request too large.' });
      }
      let input;
      try { input = JSON.parse(raw); }
      catch { return reply(400, { error: 'Invalid JSON.' }); }
      const data = req.url === '/ableton-status' ? await abletonApp.status() :
        req.url === '/ableton-launch' ? await abletonApp.launch(input) :
        req.url === '/creative' ? await control.creative(input) :
        req.url === '/creative-state' ? control.creativeSnapshot() :
        req.url === '/themes' ? await themes.catalog() :
        req.url === '/theme' ? await themes.select(input.id) :
        req.url === '/catalog' ? control.catalog() :
        req.url === '/query' ? await control.query(input) :
        req.url === '/refresh' ? await control.refresh() :
        req.url === '/inspect' ? await control.inspect(input) : await control.command(input);
      reply(200, data);
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    const failed = error => {
      const reason = error.code === 'EADDRINUSE' ?
        'Port is already in use. Close the other interface before retrying; no alternate port will be selected.' :
        error.message;
      reject(new Error(`Cannot start Countryside Creative Studio on http://127.0.0.1:${port}/: ${reason}`, { cause: error }));
    };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
