import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/transport/bridge-client.ts';

const version = { major: 1, minor: 0 };
const workspaceId = 'a'.repeat(32);
const transferId = 'b'.repeat(32);
const snapshotId = 'sha256:' + 'c'.repeat(64);
const hash = 'sha256:' + 'd'.repeat(64);
const snapshot = { schemaVersion: version, snapshotId };
test('publication uses authenticated fixed routes and base64 bytes before confirmed finalize', async () => {
  const calls = [];
  const client = new BridgeClient(async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/pair')) return { ok: true, json: async () => ({ token: 'F'.repeat(64), schemaVersion: version }) };
    const value = url.endsWith('/begin') ? { transferId, missing: [hash] } : url.endsWith('/blobs') ? { accepted: true } : { snapshotId, status: 'published' };
    return { ok: true, json: async () => ({ schemaVersion: version, ...value }) };
  });
  await client.pair('E'.repeat(64));
  assert.deepEqual(await client.publish(workspaceId, { snapshot, assets: [{ hash, bytes: new Uint8Array([0, 255, 1, 2]) }] }), { snapshotId, status: 'published' });
  assert.deepEqual(calls.slice(1).map(([url]) => url.split('/').pop()), ['begin', 'blobs', 'finalize']);
  assert.equal(JSON.parse(calls[2][1].body).bytes, 'AP8BAg==');
  assert.ok(calls.slice(1).every(([, options]) => options.headers.Authorization === 'Bearer ' + 'F'.repeat(64)));
});
test('missing asset or failed finalize never reports publication', async () => {
  const client = new BridgeClient(async (url) => ({ ok: true, json: async () => url.endsWith('/pair')
    ? { token: 'F'.repeat(64), schemaVersion: version } : { schemaVersion: version, transferId, missing: [hash] } }));
  await client.pair('E'.repeat(64));
  await assert.rejects(client.publish(workspaceId, { snapshot, assets: [] }), /Missing captured asset/);
});
