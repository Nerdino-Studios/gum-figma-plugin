// Wire shape validation only. Domain semantics and content hashing belong to later use cases.
export type ContractKind = 'request' | 'snapshot' | 'catalog' | 'diagnostic';

const fields: Record<ContractKind, readonly string[]> = {
  request: ['operation'],
  snapshot: ['snapshotId', 'documentNamespace', 'selectedRootIds', 'nodes'],
  catalog: ['catalogId', 'revision', 'controls'],
  diagnostic: ['code', 'severity', 'message'],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function textArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(text);
}

export function validateContract(kind: string, value: unknown): boolean {
  if (!Object.hasOwn(fields, kind) || !record(value)) return false;
  const required = fields[kind as ContractKind];
  const allowed = ['schemaVersion', ...required, 'extensions'];
  if (!required.every(key => Object.hasOwn(value, key)) || !Object.keys(value).every(key => allowed.includes(key))) return false;

  const version = value.schemaVersion;
  if (!record(version) || !exact(version, ['major', 'minor']) || version.major !== 1 ||
      !Number.isSafeInteger(version.minor) || (version.minor as number) < 0 || (version.minor as number) > 2147483647) return false;

  if (Object.hasOwn(value, 'extensions')) {
    if (!record(value.extensions) || !Object.entries(value.extensions).every(([key, entry]) =>
      /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(key) && text(entry))) return false;
  }

  switch (kind) {
    case 'request': return text(value.operation);
    case 'snapshot': return text(value.snapshotId) && text(value.documentNamespace) &&
      textArray(value.selectedRootIds) && Array.isArray(value.nodes) && value.nodes.length === 0;
    case 'catalog': return text(value.catalogId) && text(value.revision) &&
      Array.isArray(value.controls) && value.controls.length === 0;
    case 'diagnostic': return text(value.code) && text(value.message) &&
      ['info', 'warning', 'error'].includes(value.severity as string);
    default: return false;
  }
}
