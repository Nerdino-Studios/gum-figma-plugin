import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/transport/bridge-client.ts';

test('connection on open uses only fixed loopback workspace route without credentials', async () => {
  const calls = [];
  const client = new BridgeClient(async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ schemaVersion: { major: 1, minor: 0 }, workspaces: [] }) };
  });
  assert.deepEqual((await client.workspaces()).workspaces, []);
  assert.deepEqual(calls, [['http://localhost:48931/v1/workspaces', undefined]]);
});
test('offline connection can be retried and still rejects unsafe workspace projection', async () => {
  let online = false;
  const entries = [{ id: 'a'.repeat(32), label: 'Sample workspace', kind: 'sample', capability: 'native-gum-placeholder', ready: true }];
  const client = new BridgeClient(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ schemaVersion: { major: 1, minor: 0 }, workspaces: entries }) };
  });
  await assert.rejects(client.workspaces());
  online = true;
  assert.deepEqual((await client.workspaces()).workspaces, entries);
  entries[0] = { ...entries[0], root: '/private/secrets' };
  await assert.rejects(client.workspaces(), /unsupported format/);
});
