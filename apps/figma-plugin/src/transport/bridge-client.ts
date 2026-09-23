// The sole plugin network client. Tokens live only in this iframe instance, never in scene or plugin data.
export type Version = { major: 1; minor: 0 };
export type WorkspaceList = { schemaVersion: Version; workspaces: unknown[] };
export type PairResponse = { token: string; schemaVersion: Version };
const endpoint = 'http://localhost:48931';

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
function isWorkspaceList(value: unknown): value is WorkspaceList {
  return typeof value === 'object' && value !== null && 'schemaVersion' in value && isVersion(value.schemaVersion) &&
    'workspaces' in value && Array.isArray(value.workspaces);
}
