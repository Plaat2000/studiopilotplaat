import test from 'node:test';
import assert from 'node:assert/strict';
import { createAbletonApp } from './ableton-app.mjs';

test('native status checks the Ableton bundle without launching or requesting UI automation', async () => {
  const calls = [];
  const app = createAbletonApp({ platform: 'darwin', execute: async (...args) => {
    calls.push(args);
    return { stdout: '{"running":true,"installed":true}' };
  } });
  assert.deepEqual(await app.status(), { supported: true, running: true, installed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.match(calls[0][1][3], /NSWorkspace/);
  assert.match(calls[0][1][3], /com\.ableton\.live/);
  assert.doesNotMatch(calls[0][1][3], /System Events/);
  assert.equal(calls[0][2].timeout, 10000);
});

test('launch needs explicit approval and never launches a second running application', async () => {
  const calls = [];
  const app = createAbletonApp({ platform: 'darwin', execute: async (...args) => {
    calls.push(args);
    return { stdout: '{"running":true,"installed":true}' };
  } });
  await assert.rejects(app.launch({}), /confirm starting Ableton/);
  assert.equal(calls.length, 0);
  const result = await app.launch({ confirmed: true });
  assert.equal(result.running, true);
  assert.equal(result.launch_requested, false);
  assert.equal(calls.length, 1);
});

test('stopped Ableton launches only the fixed bundle with no shell or user-provided executable', async () => {
  const calls = [];
  const app = createAbletonApp({ platform: 'darwin', execute: async (...args) => {
    calls.push(args);
    return { stdout: args[0] === '/usr/bin/osascript' ? '{"running":false,"installed":true}' : '' };
  } });
  const result = await app.launch({ confirmed: true, executable: '/bin/sh', arguments: ['unexpected'] });
  assert.equal(result.running, false, 'An accepted launch request is not proof of readiness');
  assert.equal(result.launch_requested, true);
  assert.deepEqual(calls[1].slice(0, 2), ['/usr/bin/open', ['-b', 'com.ableton.live']]);
  assert.equal(calls[1][2].shell, undefined);
});

test('missing applications, detection failures, malformed status and launch failures surface explicitly', async () => {
  const missing = createAbletonApp({ platform: 'darwin', execute: async () => ({ stdout: '{"running":false,"installed":false}' }) });
  await assert.rejects(missing.launch({ confirmed: true }), /not registered as an installed application/);
  for (const stdout of ['invalid json', '{}', '{"running":"false","installed":true}']) {
    const app = createAbletonApp({ platform: 'darwin', execute: async () => ({ stdout }) });
    await assert.rejects(app.status(), /Could not check|invalid status/);
  }
  const failed = createAbletonApp({ platform: 'darwin', execute: async () => { throw new Error('Native check failed'); } });
  await assert.rejects(failed.status(), /Could not check.*Native check failed/);
  const launchFailure = createAbletonApp({ platform: 'darwin', execute: async command => {
    if (command === '/usr/bin/osascript') return { stdout: '{"running":false,"installed":true}' };
    throw new Error('Launch Services failed');
  } });
  await assert.rejects(launchFailure.launch({ confirmed: true }), /Could not start.*Launch Services failed/);
});

test('unsupported platforms are reported as unknown, not mistaken for stopped Ableton', async () => {
  const app = createAbletonApp({ platform: 'linux', execute: async () => { throw new Error('Must not execute'); } });
  const result = await app.status();
  assert.equal(result.supported, false);
  assert.equal(result.running, null);
  await assert.rejects(app.launch({ confirmed: true }), /macOS only/);
});
