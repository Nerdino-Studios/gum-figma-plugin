import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/transport/bridge-client.ts';

const schemaVersion = { major: 1, minor: 0 };
const workspace = 'a'.repeat(32);
const snapshot = 'sha256:' + 'b'.repeat(64);
const target = 'sha256:' + 'c'.repeat(64);
const output = 'sha256:' + 'd'.repeat(64);
const artifact = 'sha256:' + 'e'.repeat(64);

test('preview failure surfaces bounded tool stage and details', async () => {
  const client = new BridgeClient(async url => {
    if (url.includes('preview-target')) return { ok: true, json: async () => ({ schemaVersion, workspaceId: workspace, targetHash: target }) };
    return { ok: false, status: 409, json: async () => ({ code: 'VALIDATION_FAILED', stage: 'gumcli check', details: 'Missing screen /private/tmp/example.gusx' }) };
  });
  await assert.rejects(client.preview(workspace, snapshot), /gumcli check.*Missing screen \/private\/tmp\/example.gusx/);
});

test('non-tool preview failure preserves validated context', async () => {
  const client = new BridgeClient(async url => {
    if (url.includes('preview-target')) return { ok: true, json: async () => ({ schemaVersion, workspaceId: workspace, targetHash: target }) };
    return { ok: false, status: 409, json: async () => ({ code: 'VALIDATION_FAILED', stage: 'preview', details: 'Missing code generation settings' }) };
  });
  await assert.rejects(client.preview(workspace, snapshot), /VALIDATION_FAILED at preview: Missing code generation settings/);
});

test('preview denies missing, stale, invalid or mismatched provenance without an image', async () => {
  for (const [status, body] of [[404, null], [409, null], [401, null], [200, { schemaVersion, workspaceId: workspace, snapshotId: snapshot, targetHash: target, outputHash: output, artifactId: artifact }]]) {
    let artifactRequests = 0;
    const client = new BridgeClient(async (url) => {
        if (url.includes('preview-target')) return { ok: true, json: async () => ({ schemaVersion, workspaceId: workspace, targetHash: target }) };
      if (url.endsWith('/previews')) return { ok: status === 200, status, json: async () => body };
      artifactRequests++;
      return { ok: false, status: 404 };
    });
      await assert.rejects(client.preview(workspace, snapshot), /Preview (failed|artifact missing)/);
    assert.equal(artifactRequests, status === 200 ? 1 : 0);
  }
  const client = new BridgeClient(async (url) => ({ ok: true, json: async () => url.includes('preview-target') ? { schemaVersion, workspaceId: workspace, targetHash: target } :
      { schemaVersion, workspaceId: workspace, snapshotId: snapshot, targetHash: 'sha256:' + 'f'.repeat(64), outputHash: output, artifactId: artifact } }));
  await assert.rejects(client.preview(workspace, snapshot), /Mismatched preview provenance/);
});
