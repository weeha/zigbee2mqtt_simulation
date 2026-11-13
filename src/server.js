// Web UI + REST API for the Zigbee2MQTT simulator.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulator } from './simulator.js';
import { ScenarioRunner } from './scenarios.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8099;
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const sim = new Simulator(process.env.DATA_DIR || path.join(ROOT, 'data'));
const scenarios = new ScenarioRunner(sim);
const snapshot = () => ({ ...sim.snapshot(), running: scenarios.status(), results: scenarios.resultsView() });

// ---------------------------------------------------------------- live updates (server-sent events)
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
let pending = null;
sim.on('change', () => {
  pending ??= setTimeout(() => {
    pending = null;
    const data = snapshot();
    for (const res of clients) send(res, 'state', data);
  }, 40);
});
sim.on('log', (entry) => {
  for (const res of clients) send(res, 'log', [entry]);
});

// ---------------------------------------------------------------- REST API
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, regex: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/state', () => snapshot());
route('PUT', '/api/config', async (p, body) => { await sim.setConfig(body); });
route('PUT', '/api/clock', (p, body) => sim.setClock(body));
route('PUT', '/api/rooms', (p, body) => sim.setRoom(body));
route('POST', '/api/demo', () => scenarios.createDemo());
route('POST', '/api/devices', (p, body) => sim.addDevice(body));
route('PATCH', '/api/devices/:id', (p, body) => sim.updateDevice(p.id, body));
route('DELETE', '/api/devices/:id', (p) => sim.removeDevice(p.id));
route('POST', '/api/devices/:id/action', (p, body) => sim.pressButton(p.id, body.action));
route('POST', '/api/scenarios', (p, body) => scenarios.save(null, body));
route('PUT', '/api/scenarios/:id', (p, body) => scenarios.save(p.id, body));
route('DELETE', '/api/scenarios/:id', (p) => scenarios.remove(p.id));
route('POST', '/api/scenarios/:id/run', (p, body, query) => {
  scenarios.get(p.id);
  if (scenarios.running.has(p.id)) throw Object.assign(new Error('This scenario is already running'), { status: 409 });
  const done = scenarios.run(p.id);
  // "wait" answers only when the scenario has finished - with its result.
  if (body.wait || query.has('wait')) return done;
  done.catch((err) => console.error(err));
});
route('POST', '/api/tests/run', () => scenarios.runTests());
route('POST', '/api/scenarios/:id/stop', (p) => scenarios.stop(p.id));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(Object.assign(new Error('Request too large'), { status: 413 }));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const body = JSON.parse(data);
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? { ok: true }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    send(res, 'state', snapshot());
    send(res, 'log', sim.log);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      for (const r of routes) {
        const m = r.method === req.method && r.regex.exec(pathname);
        if (!m) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        return json(res, 200, await r.handler(m.groups || {}, body, url.searchParams));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) console.error(err);
      return json(res, err.status || 500, { error: err.message });
    }
  }

  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, content) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  });
});

server.on('error', (err) => {
  console.error(`Could not start the web UI on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Zigbee2MQTT simulator UI:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`MQTT broker:               ${sim.config.mqtt_url}  (base topic '${sim.config.base_topic}')`);
  sim.connect();
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  scenarios.stopAll();
  await sim.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
