#!/usr/bin/env node
// Countryside Creative Studio — standalone launcher.
// Spawns the LivePilot MCP server directly over stdio (plain JSON-RPC) and
// serves the exact same Creative Studio UI. No Copilot session, no Claude
// credits: every button click is a direct local MCP tool call.
//
// IMPORTANT: the Ableton Remote Script accepts ONE TCP client on port 9878.
// Do not run this while a Copilot session has the LivePilot MCP server
// connected — one of the two will get "Another client is already connected".

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createControl } from './control.mjs';
import { startServer } from './server.mjs';
import { createThemeStore } from './themes.mjs';

const PROTOCOL_VERSION = '2025-06-18';

export function createMcpClient({ command, args = [], env = {}, cwd, timeoutMs = 120000, onExit, onStderr }) {
  if (typeof command !== 'string' || !command) throw new Error('MCP server command is required.');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let exited = false;
  let exitInfo = '';
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; } // Ignore stray non-JSON stdout lines.
      dispatch(message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (onStderr) onStderr(chunk); });
  child.on('error', error => fail(`Failed to start LivePilot MCP server: ${error.message}`));
  child.on('exit', (code, signal) => {
    fail(`LivePilot MCP server exited (${signal || `code ${code}`}).`);
    if (onExit) onExit(code, signal);
  });

  function fail(reason) {
    if (exited) return;
    exited = true;
    exitInfo = reason;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function send(message) {
    if (exited) throw new Error(exitInfo || 'LivePilot MCP server is not running.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function dispatch(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message || `MCP error ${message.error.code}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      // Server-to-client request. Answer ping; refuse anything that would
      // require a model (sampling, elicitation) — that is the whole point.
      if (message.method === 'ping') {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else {
        send({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: `Standalone client does not support ${message.method}.` },
        });
      }
    }
    // Notifications (logging, progress) are ignored.
  }

  function request(method, params, requestTimeout = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (exited) return reject(new Error(exitInfo || 'LivePilot MCP server is not running.'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${requestTimeout / 1000}s.`));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return {
    async connect() {
      const result = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'livepilot-studio-standalone', version: '1.0.0' },
      }, Math.min(timeoutMs, 30000));
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result;
    },
    async listTools() {
      const tools = [];
      let cursor;
      do {
        const page = await request('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(page.tools)) throw new Error('Unexpected tools/list response.');
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    callTool(name, args = {}) {
      return request('tools/call', { name, arguments: args });
    },
    alive: () => !exited,
    close() {
      fail('LivePilot MCP server stopped.');
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
  };
}

// Mimics the subset of the Copilot SDK session that control.mjs uses, backed
// by the direct MCP client instead of session.rpc.tools.execute().
export function createSessionShim(client, cacheMs = 60000) {
  let cache = null;
  let cachedAt = 0;
  return {
    rpc: {
      tools: {
        async getCurrentMetadata() {
          if (!cache || Date.now() - cachedAt > cacheMs) {
            cache = (await client.listTools()).map(tool => ({
              name: `LivePilot-${tool.name}`,
              namespacedName: `LivePilot-${tool.name}`,
              mcpToolName: tool.name,
              mcpServerName: 'livepilot',
              description: tool.description,
            }));
            cachedAt = Date.now();
          }
          return { tools: cache };
        },
        async execute({ name, arguments: args }) {
          const result = await client.callTool(name.replace(/^LivePilot-/, ''), args ?? {});
          if (result?.isError) {
            const text = Array.isArray(result.content)
              ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
              : '';
            return { resultType: 'failure', error: text || 'LivePilot command failed.' };
          }
          return result;
        },
      },
    },
  };
}

export async function resolveServerConfig({ configPath, serverName } = {}) {
  const file = configPath
    || process.env.LIVEPILOT_MCP_CONFIG
    || path.resolve(process.cwd(), '.mcp.json');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    throw new Error(`Cannot read MCP config ${file}: ${error.message}. ` +
      'Run from a directory with .mcp.json, or pass --config <path>.');
  }
  const servers = parsed.mcpServers || {};
  const name = serverName
    || (servers.LivePilot ? 'LivePilot' : Object.keys(servers).find(key => /livepilot/i.test(key)))
    || Object.keys(servers)[0];
  const entry = servers[name];
  if (!entry) throw new Error(`No MCP server entry found in ${file}.`);
  if (entry.type && entry.type !== 'stdio') {
    throw new Error(`Server "${name}" uses transport "${entry.type}"; standalone mode needs stdio.`);
  }
  if (typeof entry.command !== 'string') throw new Error(`Server "${name}" has no command.`);
  return {
    name,
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env: entry.env && typeof entry.env === 'object' ? entry.env : {},
    cwd: path.dirname(path.resolve(file)),
  };
}

function parseArgv(argv) {
  const options = { open: process.platform === 'darwin' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--server') options.serverName = argv[++i];
    else if (arg === '--themes') options.themes = argv[++i]?.split(',').map(dir => dir.trim()).filter(Boolean);
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const USAGE = `Countryside Creative Studio — standalone (no Copilot session, no per-action credits)

Usage: node standalone.mjs [options]

Options:
  --config <path>   MCP config file (default: ./.mcp.json or $LIVEPILOT_MCP_CONFIG)
  --server <name>   Server entry in the config (default: LivePilot)
  --themes <dirs>   Comma-separated Ableton theme directories
  --no-open         Print the URL instead of opening the browser
  -h, --help        Show this help

Requires Ableton Live running with the LivePilot Remote Script. Do not run
while a Copilot session is also connected to LivePilot (single TCP client).`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgv(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = await resolveServerConfig(options);
  console.log(`Starting LivePilot MCP server (${config.name}): ${config.command}`);
  const client = createMcpClient({
    ...config,
    onStderr: chunk => process.stderr.write(chunk),
    onExit: () => {
      console.error('LivePilot MCP server exited; shutting down.');
      process.exitCode = 1;
      shutdown();
    },
  });
  await client.connect();
  const toolCount = (await client.listTools()).length;
  console.log(`Connected. ${toolCount} tools available — zero Claude credits per action.`);

  const themes = createThemeStore();
  if (options.themes) await themes.configure(options.themes);
  await themes.catalog().catch(() => {});

  const control = createControl(createSessionShim(client));
  const server = await startServer(control, themes);
  console.log(`Countryside Creative Studio: ${server.url}`);
  console.log('Press Ctrl+C to stop.');
  if (options.open) spawn('open', [server.url], { stdio: 'ignore', detached: true }).unref();

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    try { await server.close(); } catch { /* already closed */ }
    client.close();
  }
  process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
