import test from 'node:test';
import assert from 'node:assert/strict';
import { createControl, decodeResult } from './control.mjs';
import { startServer, STUDIO_PORT } from './server.mjs';
import { Server } from 'node:http';
import { modules, validateToolInput } from './catalog.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function fixture() {
  const calls = [];
  let value = 0.5;
  let name = 'Track';
  const session = { rpc: { tools: {
    getCurrentMetadata: async () => ({ tools: [{ name: 'LivePilot-call_tool', mcpServerName: 'LivePilot', mcpToolName: 'call_tool' }] }),
    execute: async ({ arguments: args }) => {
      calls.push(args);
      let data;
      if (args.name === 'get_session_info') data = { tracks: [{ index: 0, name }], tempo: 120, session_instance_id: 'set-1' };
      else if (args.name === 'get_track_info') data = { index: 0, name, devices: [{ index: 0, name: 'Effect' }] };
      else if (args.name === 'get_device_parameters') data = { parameters: [{ index: 0, name: 'Wet', min: 0, max: 1, value }] };
      else { data = { ok: true }; if (args.name === 'set_device_parameter') value = args.arguments.value; }
      return { resultType: 'success', textResultForLlm: JSON.stringify(data) };
    },
  } } };
  return { control: createControl(session), calls, rename: () => { name = 'Different'; } };
}
test('decodes nested responses and surfaces failure', () => {
  assert.deepEqual(decodeResult({ content: [{ type: 'text', text: '{"tempo":120}' }] }), { tempo: 120 });
  assert.throws(() => decodeResult({ resultType: 'failure', error: 'Disconnected' }), /Disconnected/);
  assert.throws(() => decodeResult('not json'), /Unexpected/);
});
test('refresh resolves new metadata once after a catalog change before invocation', async () => {
  let metadataReads = 0;
  const calls = [];
  const session = { rpc: { tools: {
    getCurrentMetadata: async () => ({ tools: ++metadataReads === 1
      ? [{ name: 'LivePilot-get_session_info' }]
      : [{ name: 'LivePilot-call_tool' }] }),
    execute: async input => {
      calls.push(input);
      if (calls.length === 1) throw new Error('MCP tool catalog changed before tool "LivePilot-get_session_info" could be invoked');
      return { resultType: 'success', structuredContent: { tracks: [], tempo: 120 } };
    },
  } } };
  assert.equal((await createControl(session).refresh()).session.tempo, 120);
  assert.equal(metadataReads, 2);
  assert.deepEqual(calls[1], { name: 'LivePilot-call_tool', arguments: { name: 'get_session_info', arguments: {} } });
});
test('catalog retries are bounded and other execution failures are never retried', async () => {
  for (const message of [
    'MCP tool catalog changed before tool "LivePilot-get_session_info" could be invoked',
    'Connection reset after invocation',
  ]) {
    let calls = 0;
    const session = { rpc: { tools: {
      getCurrentMetadata: async () => ({ tools: [{ name: 'LivePilot-get_session_info' }] }),
      execute: async () => { calls++; return { resultType: 'failure', error: message }; },
    } } };
    await assert.rejects(createControl(session).refresh(), error => error.message === message);
    assert.equal(calls, message.startsWith('MCP tool catalog changed') ? 2 : 1);
  }
});
test('reads before parameter writes, validates range, and reads back', async () => {
  const { control, calls } = fixture();
  await control.refresh();
  await control.inspect({ track_index: 0, device_index: 0 });
  const input = { command: 'set_device_parameter', track_index: 0, track_name: 'Track', device_index: 0,
    device_name: 'Effect', parameter_index: 0, value: 2 };
  await assert.rejects(control.command(input), /between 0 and 1/);
  assert.equal(calls.some(c => c.name === 'set_device_parameter'), false);
  const result = await control.command({ ...input, value: 0.7 });
  assert.equal(result.parameters.items[0].value, 0.7);
  const write = calls.findIndex(c => c.name === 'set_device_parameter');
  assert.equal(calls[write - 1].name, 'get_device_parameters');
  assert.ok(calls.slice(write + 1).some(c => c.name === 'get_device_parameters'));
});
test('refuses stale track selection and unsupported commands', async () => {
  const { control, calls, rename } = fixture();
  await control.refresh();
  await control.inspect({ track_index: 0 });
  rename();
  await assert.rejects(control.command({ command: 'set_track_volume', track_index: 0, track_name: 'Track', value: 0.5 }), /Track changed/);
  await assert.rejects(control.command({ command: 'delete_track' }), /Unsupported/);
  assert.equal(calls.some(c => c.name === 'set_track_volume'), false);
});
test('rejects invalid tempo and continues processing after errors', async () => {
  const { control } = fixture();
  await assert.rejects(control.command({ command: 'set_tempo', value: 1000 }), /Tempo/);
  assert.equal((await control.refresh()).session.tempo, 120);
});
test('architecture covers all three pillars and seven modules', () => {
  assert.deepEqual([...new Set(modules.map(module => module.pillar))], ['knowledge', 'perception', 'memory']);
  assert.equal(modules.length, 7);
  assert.equal(new Set(modules.flatMap(module => module.tools.map(tool => tool.name))).size,
    modules.reduce((count, module) => count + module.tools.length, 0));
});
test('module queries validate arguments and require replay confirmation', async () => {
  const { control, calls } = fixture();
  await assert.rejects(control.query({ name: 'delete_track', arguments: {} }), /supported architecture/);
  await assert.rejects(control.query({ name: 'atlas_search', arguments: {} }), /required/);
  await assert.rejects(control.query({ name: 'atlas_search', arguments: { query: 'kit', limit: 500 } }), /between/);
  await assert.rejects(control.query({ name: 'memory_replay', arguments: { technique_id: 'test' } }), /Confirm/);
  await assert.rejects(control.query({ name: 'atlas_search', arguments: { query: 'kit', injected: true } }), /Unknown argument/);
  assert.equal(calls.length, 0);
  const result = await control.query({ name: 'atlas_search', arguments: { query: 'kit', limit: 3 } });
  assert.equal(result.tool, 'atlas_search');
  assert.equal(calls[0].name, 'atlas_search');
  assert.deepEqual(calls[0].arguments, { query: 'kit', limit: 3 });
  assert.ok(!Number.isNaN(Date.parse(result.timestamp)));
  assert.equal(validateToolInput({ name: 'memory_replay', arguments: { technique_id: 'test' }, confirmed: true }).spec.name, 'memory_replay');
});
test('tool discovery supports plain-text reference results and surfaces errors', async () => {
  const session = { rpc: { tools: {
    getCurrentMetadata: async () => ({ tools: [{ name: 'LivePilot-search_tools' }] }),
    execute: async () => ({ resultType: 'success', textResultForLlm: '### atlas_search\nSearch the atlas.' }),
  } } };
  const result = await createControl(session).query({ name: 'search_tools', arguments: { query: 'atlas' } });
  assert.match(result.data.documentation, /atlas_search/);
  session.rpc.tools.execute = async () => ({ resultType: 'success',
    structuredContent: { result: '### atlas_search\nSearch the atlas.' } });
  const nested = await createControl(session).query({ name: 'search_tools', arguments: { query: 'atlas' } });
  assert.match(nested.data.documentation, /atlas_search/);
  session.rpc.tools.execute = async () => ({ resultType: 'success', structuredContent: { error: 'Search unavailable' } });
  await assert.rejects(createControl(session).query({ name: 'search_tools', arguments: { query: 'atlas' } }), /Search unavailable/);
  session.rpc.tools.execute = async () => ({ resultType: 'failure', error: 'Offline' });
  await assert.rejects(createControl(session).query({ name: 'search_tools', arguments: { query: 'atlas' } }), /Offline/);
});
test('browser initializes architecture cards and preserves command forms on session refresh', async () => {
  const { control } = fixture();
  const nodes = new Map();
  const makeNode = () => ({
    value: '', disabled: false, hidden: false, textContent: '', isConnected: true, children: [],
    classList: { toggle() {} }, setAttribute() {}, scrollIntoView() {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
  });
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, makeNode());
  const document = {
    getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, makeNode());
      return nodes.get(id);
    },
    createElement: makeNode,
    querySelector: () => ({ content: 'token' }),
    querySelectorAll: () => [],
    documentElement: { style: { removeProperty() {}, setProperty() {} } },
  };
  const code = await readFile(new URL('client.js', import.meta.url), 'utf8');
  const context = vm.createContext({ document, fetch: async path => ({
    ok: true, json: async () => path === '/themes'
      ? { themes: [{ id: 'studio', name: 'Studio', scheme: 'dark', vars: {} }], selected: 'studio', warnings: [] }
      : path === '/catalog' ? control.catalog() : control.refresh(),
  }) });
  vm.runInContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext('initialize()', context);
  assert.equal(nodes.get('knowledge-modules').children.length, 2);
  assert.equal(nodes.get('perception-modules').children.length, 2);
  assert.equal(nodes.get('memory-modules').children.length, 3);
  assert.equal(nodes.get('module-command').value, 'atlas_search');
  assert.equal(nodes.get('command-fields').children.length, 3);
  assert.equal(nodes.get('status').textContent, 'Connected. Live values loaded.');
});
test('serves UI, rejects cross-origin commands, and supports authenticated reads', async () => {
  const { control } = fixture();
  const server = await startServer(control, undefined, { port: 0 });
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Countryside Creative Studio<\/title>/);
    assert.match(html, /<h1><button id="ableton-launch"[^>]+>Countryside<span class="accent"> Creative Studio<\/span><\/button><\/h1>/);
    const classic = await fetch(new URL('/classic', server.url));
    assert.equal(classic.status, 200);
    assert.match(await classic.text(), /<title>Countryside Creative Studio<\/title>/);
    const token = html.match(/name="livepilot-token" content="([^"]+)"/)[1];
    const rejected = await fetch(new URL('/command', server.url), { method: 'POST', body: '{}' });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(new URL('/refresh', server.url), { method: 'POST',
      headers: { Origin: new URL(server.url).origin, 'Content-Type': 'application/json', 'X-LivePilot-Token': token },
      body: '{}' });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).session.tempo, 120);
    const headers = { Origin: new URL(server.url).origin, 'Content-Type': 'application/json', 'X-LivePilot-Token': token };
    const catalog = await fetch(new URL('/catalog', server.url), { method: 'POST', headers, body: '{}' });
    assert.equal((await catalog.json()).modules.length, 7);
    const query = await fetch(new URL('/query', server.url), { method: 'POST', headers,
      body: JSON.stringify({ name: 'atlas_search', arguments: { query: 'kit' } }) });
    assert.equal((await query.json()).tool, 'atlas_search');
  } finally { await server.close(); }
});

test('native app status and launch use the same token/origin protection without requiring MCP', async () => {
  const { control, calls } = fixture();
  let launches = 0;
  const app = { status: async () => ({ supported: true, running: false, installed: true }),
    launch: async input => {
      if (input?.confirmed !== true) throw new Error('Explicit launch confirmation required');
      launches++;
      return { supported: true, running: false, installed: true, launch_requested: true };
    } };
  const server = await startServer(control, undefined, { port: 0, abletonApp: app });
  try {
    const html = await (await fetch(server.url)).text();
    const token = html.match(/name="livepilot-token" content="([^"]+)"/)[1];
    const headers = { Origin: new URL(server.url).origin, 'Content-Type': 'application/json', 'X-LivePilot-Token': token };
    for (const path of ['/ableton-status', '/ableton-launch']) {
      assert.equal((await fetch(new URL(path, server.url))).status, 404);
      assert.equal((await fetch(new URL(path, server.url), { method: 'POST', body: '{}' })).status, 403);
      assert.equal((await fetch(new URL(path, server.url), { method: 'POST',
        headers: { ...headers, Origin: 'https://example.test' }, body: '{}' })).status, 403);
    }
    const status = await fetch(new URL('/ableton-status', server.url), { method: 'POST', headers, body: '{}' });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).running, false);
    const unconfirmed = await fetch(new URL('/ableton-launch', server.url), { method: 'POST', headers, body: '{}' });
    assert.equal(unconfirmed.status, 400);
    const launched = await fetch(new URL('/ableton-launch', server.url), { method: 'POST', headers, body: '{"confirmed":true}' });
    assert.equal(launched.status, 200);
    assert.equal((await launched.json()).launch_requested, true);
    assert.equal(launches, 1);
    assert.equal(calls.length, 0, 'OS app detection and launch must not call Ableton over MCP');
  } finally { await server.close(); }
});

test('Studio always requests port 7666 by default and surfaces bind errors', async t => {
  assert.equal(STUDIO_PORT, 7666);
  const denied = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  let attempts = 0;
  t.mock.method(Server.prototype, 'listen', function (port, host) {
    attempts++;
    assert.equal(port, 7666);
    assert.equal(host, '127.0.0.1');
    this.emit('error', denied);
    return this;
  });
  await assert.rejects(startServer({}), error =>
    error.cause === denied && /127\.0\.0\.1:7666.*Permission denied/.test(error.message));
  assert.equal(attempts, 1, 'Bind failures must not trigger a fallback port');
});

test('occupied ports fail clearly without fallback and can be reopened after close', async () => {
  const server = await startServer({}, undefined, { port: 0 });
  const port = Number(new URL(server.url).port);
  try {
    await assert.rejects(startServer({}, undefined, { port }), error =>
      error.cause?.code === 'EADDRINUSE' && error.message.includes(`127.0.0.1:${port}`) &&
      /no alternate port/.test(error.message));
  } finally { await server.close(); }
  const reopened = await startServer({}, undefined, { port });
  try { assert.equal(Number(new URL(reopened.url).port), port); }
  finally { await reopened.close(); }
});
