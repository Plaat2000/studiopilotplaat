import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMcpClient, createSessionShim, resolveServerConfig } from './standalone.mjs';
import { decodeResult } from './control.mjs';

// Minimal MCP stdio server used as the spawn target: supports initialize,
// paginated tools/list, tools/call (echo + failure), and a ping request back.
const FAKE_SERVER = `
let buffer = '';
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-livepilot', version: '0.0.0' },
      } });
    } else if (message.method === 'notifications/initialized') {
      send({ jsonrpc: '2.0', id: 999, method: 'ping' });
    } else if (message.method === 'tools/list') {
      if (!message.params || !message.params.cursor) {
        send({ jsonrpc: '2.0', id: message.id, result: {
          tools: [{ name: 'get_session_info', description: 'Session state.' }],
          nextCursor: 'page2',
        } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: {
          tools: [{ name: 'fail_tool', description: 'Always fails.' }],
        } });
      }
    } else if (message.method === 'tools/call') {
      if (message.params.name === 'fail_tool') {
        send({ jsonrpc: '2.0', id: message.id, result: {
          isError: true, content: [{ type: 'text', text: 'boom' }],
        } });
      } else if (message.params.name === 'rpc_error') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'tool missing' } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: message.params.name, echo: message.params.arguments }) }],
        } });
      }
    }
  }
});
`;

function startFakeClient(overrides = {}) {
  return createMcpClient({
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
    ...overrides,
  });
}

test('connects, paginates tools/list, and answers server pings', async () => {
  const client = startFakeClient();
  try {
    const init = await client.connect();
    assert.equal(init.serverInfo.name, 'fake-livepilot');
    const tools = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['get_session_info', 'fail_tool']);
    assert.ok(client.alive());
  } finally {
    client.close();
  }
});

test('session shim exposes LivePilot-prefixed metadata that control.mjs recognizes', async () => {
  const client = startFakeClient();
  try {
    await client.connect();
    const shim = createSessionShim(client);
    const metadata = await shim.rpc.tools.getCurrentMetadata();
    const tool = metadata.tools.find(entry => entry.mcpToolName === 'get_session_info');
    assert.equal(tool.name, 'LivePilot-get_session_info');
    assert.equal(tool.mcpServerName, 'livepilot');
    // Second read within the cache window returns the same array.
    assert.equal((await shim.rpc.tools.getCurrentMetadata()).tools, metadata.tools);
  } finally {
    client.close();
  }
});

test('execute round-trips through decodeResult like the Copilot path', async () => {
  const client = startFakeClient();
  try {
    await client.connect();
    const shim = createSessionShim(client);
    const raw = await shim.rpc.tools.execute({
      name: 'LivePilot-get_session_info',
      arguments: { detail: 'full' },
    });
    const decoded = decodeResult(raw);
    assert.deepEqual(decoded, { ok: true, tool: 'get_session_info', echo: { detail: 'full' } });
  } finally {
    client.close();
  }
});

test('tool-level failures surface as thrown errors, not fake data', async () => {
  const client = startFakeClient();
  try {
    await client.connect();
    const shim = createSessionShim(client);
    const raw = await shim.rpc.tools.execute({ name: 'LivePilot-fail_tool', arguments: {} });
    assert.throws(() => decodeResult(raw), /boom/);
    await assert.rejects(client.callTool('rpc_error'), /tool missing/);
  } finally {
    client.close();
  }
});

test('requests reject with a clear error once the server exits', async () => {
  const client = startFakeClient();
  await client.connect();
  client.close();
  await assert.rejects(client.callTool('get_session_info'), /stopped|not running|exited/);
});

test('request timeouts reject instead of hanging', async () => {
  const client = createMcpClient({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'], // never answers
    timeoutMs: 200,
  });
  try {
    await assert.rejects(client.connect(), /timed out/);
  } finally {
    client.close();
  }
});

test('resolveServerConfig reads a stdio entry from .mcp.json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'livepilot-standalone-'));
  try {
    const file = path.join(dir, '.mcp.json');
    await writeFile(file, JSON.stringify({
      mcpServers: {
        LivePilot: { type: 'stdio', command: '/usr/bin/python3', args: ['-m', 'mcp_server'], env: { A: '1' } },
      },
    }));
    const config = await resolveServerConfig({ configPath: file });
    assert.equal(config.name, 'LivePilot');
    assert.equal(config.command, '/usr/bin/python3');
    assert.deepEqual(config.args, ['-m', 'mcp_server']);
    assert.deepEqual(config.env, { A: '1' });
    assert.equal(config.cwd, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServerConfig rejects non-stdio transports', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'livepilot-standalone-'));
  try {
    const file = path.join(dir, '.mcp.json');
    await writeFile(file, JSON.stringify({
      mcpServers: { LivePilot: { type: 'http', url: 'http://x' } },
    }));
    await assert.rejects(resolveServerConfig({ configPath: file }), /stdio/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
