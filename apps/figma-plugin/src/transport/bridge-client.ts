// The sole plugin network client. Fixed loopback routes; no credentials in Figma metadata.
export type Version = { major: 1; minor: 0 };
export type Workspace = { id: string; label: string; kind: 'sample' | 'existing'; capability: 'native-gum-placeholder'; ready: boolean };
export type WorkspaceList = { schemaVersion: Version; workspaces: Workspace[] };
export type Publication = { snapshotId: string; status: 'published' | 'blocked' };
export type Bundle = { snapshot: { snapshotId: string; schemaVersion: Version }; assets: readonly { hash: string; bytes: Uint8Array }[] };
const endpoint = 'http://localhost:48931';
function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]) +
      (c === undefined ? '=' : alphabet[c & 63]);
  }
  return output;
}

export class BridgeClient {
  private readonly fetcher: typeof fetch;
  // Chromium's Window.fetch requires its Window receiver; injected fetchers remain untouched.
  constructor(fetcher: typeof fetch = fetch.bind(globalThis)) { this.fetcher = fetcher; }
  async workspaces(): Promise<WorkspaceList> {
    const response = await this.fetcher(`${endpoint}/v1/workspaces`);
    if (!response.ok) throw new Error(`Workspace request failed (${response.status}).`);
    const value: unknown = await response.json();
    if (!isWorkspaceList(value)) throw new Error('Bridge workspace response has an unsupported format.');
    return value;
  }
  private async publication(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${endpoint}/v1/publications/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Publication ${path} failed (${response.status}); no new snapshot was reported published.`);
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('schemaVersion' in value) || !isVersion(value.schemaVersion)) throw new Error('Unsupported publication response.');
    return value as Record<string, unknown>;
  }
  async publish(workspaceId: string, bundle: Bundle): Promise<Publication> {
    if (!/^[0-9a-f]{32}$/.test(workspaceId) || !/^sha256:[0-9a-f]{64}$/.test(bundle.snapshot.snapshotId)) throw new Error('Invalid workspace or snapshot ID.');
    const begun = await this.publication('begin', { schemaVersion: { major: 1, minor: 0 }, workspaceId, snapshot: bundle.snapshot });
    if (typeof begun.transferId !== 'string' || !/^[0-9a-f]{32}$/.test(begun.transferId) || !Array.isArray(begun.missing) ||
      !begun.missing.every(hash => typeof hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(hash))) throw new Error('Invalid transfer response.');
    for (const hash of begun.missing as string[]) {
      const asset = bundle.assets.find(item => item.hash === hash);
      if (!asset) throw new Error(`Missing captured asset ${hash}; snapshot remains unpublished.`);
      await this.publication('blobs', { schemaVersion: { major: 1, minor: 0 }, workspaceId, transferId: begun.transferId, hash, bytes: base64(asset.bytes) });
    }
    const result = await this.publication('finalize', { schemaVersion: { major: 1, minor: 0 }, workspaceId, transferId: begun.transferId });
    if (result.snapshotId !== bundle.snapshot.snapshotId || (result.status !== 'published' && result.status !== 'blocked')) throw new Error('Unexpected finalization identity; publication not confirmed.');
    return { snapshotId: result.snapshotId, status: result.status };
  }
  async preview(workspaceId: string, snapshotId: string): Promise<{ targetHash: string; outputHash: string; artifactId: string; png: Uint8Array }> {
    if (!/^[0-9a-f]{32}$/.test(workspaceId) || !/^sha256:[0-9a-f]{64}$/.test(snapshotId)) throw new Error('Invalid preview identity.');
    const targetResponse = await this.fetcher(`${endpoint}/v1/preview-target?workspaceId=${workspaceId}`);
    if (!targetResponse.ok) throw new Error(`Preview target unavailable (${targetResponse.status}).`);
    const target: unknown = await targetResponse.json();
    if (!isRecord(target) || target.workspaceId !== workspaceId || !isVersion(target.schemaVersion) || !isHash(target.targetHash)) throw new Error('Invalid preview target identity.');
    const response = await this.fetcher(`${endpoint}/v1/previews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: { major: 1, minor: 0 }, workspaceId, snapshotId, targetHash: target.targetHash }),
    });
    if (!response.ok) {
      // Only structured conflicts carry local diagnostics. Never display arbitrary response bodies.
      if (response.status === 409) {
        let failure: unknown;
        try { failure = await response.json(); } catch { /* Older hosts have no structured body. */ }
        if (isRecord(failure) && typeof failure.code === 'string' && /^[A-Z_]{1,40}$/.test(failure.code) &&
          typeof failure.stage === 'string' && failure.stage.length <= 80 &&
          typeof failure.details === 'string' && failure.details.length <= 2200) {
          throw new Error(`Preview failed (${response.status}) ${failure.code} at ${failure.stage}: ${failure.details}`);
        }
      }
      throw new Error(`Preview failed (${response.status}); the published snapshot or target may have changed.`);
    }
    const result: unknown = await response.json();
    if (!isRecord(result) || !isVersion(result.schemaVersion) || result.workspaceId !== workspaceId || result.snapshotId !== snapshotId ||
      result.targetHash !== target.targetHash || !isHash(result.outputHash) || !isHash(result.artifactId)) throw new Error('Mismatched preview provenance.');
    const query = Object.entries({ workspaceId, snapshotId, targetHash: result.targetHash, artifactId: result.artifactId })
      .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`).join('&');
    const artifact = await this.fetcher(`${endpoint}/v1/artifacts?${query}`);
    if (!artifact.ok) throw new Error(`Preview artifact missing or stale (${artifact.status}).`);
    const bytes = new Uint8Array(await artifact.arrayBuffer());
    if (bytes.byteLength > 4 * 1024 * 1024 || bytes.byteLength < 24) throw new Error('Invalid preview artifact size.');
    return { targetHash: target.targetHash, outputHash: result.outputHash, artifactId: result.artifactId, png: bytes };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isHash(value: unknown): value is string { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value); }
function isVersion(value: unknown): value is Version {
  return typeof value === 'object' && value !== null && 'major' in value && value.major === 1 &&
    'minor' in value && value.minor === 0;
}
function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === 5 && keys.every(key => ['id', 'label', 'kind', 'capability', 'ready'].includes(key)) &&
    'id' in value && typeof value.id === 'string' && /^[0-9a-f]{32}$/.test(value.id) &&
    'label' in value && typeof value.label === 'string' && value.label.length <= 100 &&
    'kind' in value && (value.kind === 'sample' || value.kind === 'existing') &&
    'capability' in value && value.capability === 'native-gum-placeholder' &&
    'ready' in value && typeof value.ready === 'boolean';
}
function isWorkspaceList(value: unknown): value is WorkspaceList {
  return typeof value === 'object' && value !== null && 'schemaVersion' in value && isVersion(value.schemaVersion) &&
    'workspaces' in value && Array.isArray(value.workspaces) && value.workspaces.every(isWorkspace);
}
