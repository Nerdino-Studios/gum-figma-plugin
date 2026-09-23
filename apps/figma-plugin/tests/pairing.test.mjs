import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/transport/bridge-client.ts';
import { readFile } from 'node:fs/promises';

const challenge = 'A'.repeat(64);
const token = 'B'.repeat(64);
test('pairing keeps credentials in client memory and uses only fixed loopback routes', async () => {
  const calls = [];
  const client = new BridgeClient(async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/pair')) return { ok: true, json: async () => ({ token, schemaVersion: { major: 1, minor: 0 } }) };
    return { ok: true, json: async () => ({ schemaVersion: { major: 1, minor: 0 }, workspaces: [] }) };
  });
  await assert.rejects(client.workspaces(), /pair locally/i);
  await assert.rejects(client.pair('bad'), /64-character/);
  await client.pair(challenge);
  assert.deepEqual((await client.workspaces()).workspaces, []);
  assert.equal(calls[0][0], 'http://localhost:48931/v1/pair');
  assert.equal(calls[1][1].headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[1][0], 'http://localhost:48931/v1/workspaces');
  assert.equal(calls[0][1].body, JSON.stringify({ challenge }));
});
test('authenticated workspace list accepts safe labels and rejects path disclosures', async () => {
  const entries = [{ id: 'a'.repeat(32), label: 'Sample workspace', kind: 'sample', capability: 'native-gum-placeholder', ready: true }];
  const client = new BridgeClient(async (url) => ({ ok: true, json: async () => url.endsWith('/pair')
    ? { token, schemaVersion: { major: 1, minor: 0 } }
    : { schemaVersion: { major: 1, minor: 0 }, workspaces: entries } }));
  await client.pair(challenge);
  assert.deepEqual((await client.workspaces()).workspaces, entries);
  entries[0] = { ...entries[0], root: '/private/secrets' };
  await assert.rejects(client.workspaces(), /unsupported format/);
});
test('default fetch retains its Window receiver for pair, workspaces, and revoke', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function (url, options) {
    if (this !== globalThis) throw new TypeError('Failed to execute fetch on Window: Illegal invocation');
    calls.push([url, options]);
    if (url.endsWith('/pair')) return { ok: true, json: async () => ({ token, schemaVersion: { major: 1, minor: 0 } }) };
    return { ok: true, json: async () => ({ schemaVersion: { major: 1, minor: 0 }, workspaces: [] }) };
  };
  try {
    const client = new BridgeClient();
    await client.pair(challenge);
    await client.workspaces();
    await client.revoke();
    assert.deepEqual(calls.map(([url]) => url), [
      'http://localhost:48931/v1/pair',
      'http://localhost:48931/v1/workspaces',
      'http://localhost:48931/v1/session',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('denied requests do not create sessions or persist credentials in scene code', async () => {
  const client = new BridgeClient(async () => ({ ok: false, status: 401 }));
  await assert.rejects(client.pair(challenge), /denied \(401\)/);
  await assert.rejects(client.workspaces(), /pair locally/i);
  const scene = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(scene, /challenge|token|BridgeClient|fetch\(/i);
});
