import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/transport/bridge-client.ts';
const workspaceId = 'a'.repeat(32), snapshotId = 'sha256:' + 'b'.repeat(64), targetHash = 'sha256:' + 'c'.repeat(64);
const receipt = { schemaVersion: { major: 1, minor: 0 }, workspaceId, snapshotId, targetHash,
  outputHash: 'sha256:' + 'd'.repeat(64), runtimeId: 'e'.repeat(32), status: 'running' };

test('runtime client uses fixed target/run routes and accepts only the exact published identity', async () => {
  const calls = [];
  const client = new BridgeClient(async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => options ? receipt : { schemaVersion: { major: 1, minor: 0 }, workspaceId, targetHash } };
  });
  assert.equal((await client.run(workspaceId, snapshotId)).runtimeId, receipt.runtimeId);
  assert.equal(calls[0][0], 'http://localhost:48931/v1/runtime-target?workspaceId=' + workspaceId);
  assert.equal(calls[1][0], 'http://localhost:48931/v1/runs');
  assert.deepEqual(JSON.parse(calls[1][1].body), { schemaVersion: { major: 1, minor: 0 }, workspaceId, snapshotId, targetHash });
  for (const mismatch of [{ snapshotId: 'sha256:' + 'f'.repeat(64) }, { targetHash: 'sha256:' + 'f'.repeat(64) }, { status: 'starting' }, { command: 'execute me' }]) {
    const broken = new BridgeClient(async (_, options) => ({ ok: true, json: async () => options ? { ...receipt, ...mismatch } : { schemaVersion: receipt.schemaVersion, workspaceId, targetHash } }));
    await assert.rejects(broken.run(workspaceId, snapshotId), /identity|provenance/i);
  }
});

test('runtime client exposes bounded host diagnostics and does not request a screenshot artifact', async () => {
  const client = new BridgeClient(async (url, options) => {
    assert.doesNotMatch(url, /previews|artifacts/);
    return options ? { ok: false, status: 409, json: async () => ({ code: 'FRB2_BUILD_FAILED', stage: 'FRB2 runtime', details: 'Generated C# did not compile' }) }
      : { ok: true, json: async () => ({ schemaVersion: receipt.schemaVersion, workspaceId, targetHash }) };
  });
  await assert.rejects(client.run(workspaceId, snapshotId), /FRB2_BUILD_FAILED.*Generated C#/);
});
