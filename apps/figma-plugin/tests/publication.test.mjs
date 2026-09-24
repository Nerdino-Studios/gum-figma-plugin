import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/transport/bridge-client.ts';

const version = { major: 1, minor: 0 };
const workspaceId = 'a'.repeat(32);
const transferId = 'b'.repeat(32);
const snapshotId = 'sha256:' + 'c'.repeat(64);
const hash = 'sha256:' + 'd'.repeat(64);
const snapshot = { schemaVersion: version, snapshotId };
test('publication uses fixed loopback routes and base64 bytes before confirmed finalize', async () => {
  const calls = [];
  const client = new BridgeClient(async (url, options) => {
    calls.push([url, options]);
    const value = url.endsWith('/begin') ? { transferId, missing: [hash] } : url.endsWith('/blobs') ? { accepted: true } : { snapshotId, status: 'published' };
    return { ok: true, json: async () => ({ schemaVersion: version, ...value }) };
  });
  assert.deepEqual(await client.publish(workspaceId, { snapshot, assets: [{ hash, bytes: new Uint8Array([0, 255, 1, 2]) }] }), { snapshotId, status: 'published' });
  assert.deepEqual(calls.map(([url]) => url.split('/').pop()), ['begin', 'blobs', 'finalize']);
  assert.equal(JSON.parse(calls[1][1].body).bytes, 'AP8BAg==');
  assert.ok(calls.every(([, options]) => !('Authorization' in options.headers)));
});
test('missing asset or failed finalize never reports publication', async () => {
  const client = new BridgeClient(async (url) => ({ ok: true, json: async () => ({ schemaVersion: version, transferId, missing: [hash] }) }));
  await assert.rejects(client.publish(workspaceId, { snapshot, assets: [] }), /Missing captured asset/);
});
