// The sole plugin network client. Tokens live only in this iframe instance, never in scene or plugin data.
export type Version = { major: 1; minor: 0 };
export type Workspace = { id: string; label: string; kind: 'sample' | 'existing'; capability: 'native-gum-placeholder'; ready: boolean };
export type WorkspaceList = { schemaVersion: Version; workspaces: Workspace[] };
export type PairResponse = { token: string; schemaVersion: Version };
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
  private token: string | undefined;
  private readonly fetcher: typeof fetch;
  // Chromium's Window.fetch requires its Window receiver; injected fetchers remain untouched.
  constructor(fetcher: typeof fetch = fetch.bind(globalThis)) { this.fetcher = fetcher; }
  async pair(challenge: string): Promise<void> {
    if (!/^[0-9A-Fa-f]{64}$/.test(challenge)) throw new Error('Enter the 64-character challenge displayed by the local host.');
    const response = await this.fetcher(`${endpoint}/v1/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }),
    });
    if (!response.ok) throw new Error(`Pairing denied (${response.status}); request a fresh local challenge.`);
    const value: unknown = await response.json();
    if (!isPairResponse(value)) throw new Error('Bridge pairing response has an unsupported format.');
    this.token = value.token;
  }
  async workspaces(): Promise<WorkspaceList> {
    if (!this.token) throw new Error('Pair locally before requesting workspaces.');
    const response = await this.fetcher(`${endpoint}/v1/workspaces`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) {
      if (response.status === 401) this.token = undefined;
      throw new Error(`Workspace request denied (${response.status}).`);
    }
    const value: unknown = await response.json();
    if (!isWorkspaceList(value)) throw new Error('Bridge workspace response has an unsupported format.');
    return value;
  }
  private async publication(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error('Pair before publishing.');
    const response = await this.fetcher(`${endpoint}/v1/publications/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
  async revoke(): Promise<void> {
    const token = this.token;
    this.token = undefined;
    if (token) await this.fetcher(`${endpoint}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  }
}
function isVersion(value: unknown): value is Version {
  return typeof value === 'object' && value !== null && 'major' in value && value.major === 1 &&
    'minor' in value && value.minor === 0;
}
function isPairResponse(value: unknown): value is PairResponse {
  return typeof value === 'object' && value !== null && 'schemaVersion' in value && isVersion(value.schemaVersion) &&
    'token' in value && typeof value.token === 'string' && /^[0-9A-F]{64}$/.test(value.token);
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
