import catalog from './builtin-v1.json' with { type: 'json' };

export const builtinCatalog = catalog;
export type Mapping = { nodeId: string; alias: string; mode: 'generate' | 'reference'; catalogId: string; revision: string; controlId: string; pageId?: string };
type Root = { getPluginData(key: string): string; setPluginData(key: string, value: string): void };
const key = 'gumbridge.mappings.v1';
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sourceId = /^[A-Za-z0-9:_-]{1,100}$/;
const namespaceId = /^[A-Za-z0-9_-]{1,100}$/;
const own = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(root: Root): { version: number; namespace: string; entries: Mapping[] } | null {
  const raw = root.getPluginData(key);
  if (!raw) return null;
  if (raw.length > 16000) throw new Error('AMBIGUOUS_MAPPING: document mapping metadata exceeds budget');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('AMBIGUOUS_MAPPING: corrupt document mapping metadata'); }
  if (!own(value) || Object.keys(value).sort().join(',') !== 'entries,namespace,version' || value.version !== 1 ||
    typeof value.namespace !== 'string' || !namespaceId.test(value.namespace) || !Array.isArray(value.entries) || value.entries.length > 64 ||
    !value.entries.every(entry => own(entry) && ['alias,catalogId,controlId,mode,nodeId,revision', 'alias,catalogId,controlId,mode,nodeId,pageId,revision'].includes(Object.keys(entry).sort().join(',')) &&
      (entry.pageId === undefined || typeof entry.pageId === 'string' && sourceId.test(entry.pageId) && entry.mode === 'generate' && entry.controlId === 'native.frame') &&
      typeof entry.nodeId === 'string' && sourceId.test(entry.nodeId) && typeof entry.alias === 'string' && identifier.test(entry.alias) &&
      (entry.mode === 'generate' || entry.mode === 'reference') && ['catalogId', 'controlId', 'revision'].every(k => typeof entry[k] === 'string' && entry[k].length > 0 && entry[k].length <= 100)))
    throw new Error('AMBIGUOUS_MAPPING: invalid document mapping metadata');
  const entries = value.entries as Mapping[];
  if (new Set(entries.map(e => e.nodeId)).size !== entries.length ||
    new Set(entries.map(e => e.alias.toLowerCase())).size !== entries.length ||
    new Set(entries.filter(e => e.pageId).map(e => e.pageId)).size !== entries.filter(e => e.pageId).length)
    throw new Error('AMBIGUOUS_MAPPING: duplicate source or case-insensitive alias');
  return { version: 1, namespace: value.namespace, entries };
}

export function loadMappings(root: Root, namespace: string): Mapping[] {
  const stored = parse(root);
  if (stored && stored.namespace !== namespace) return []; // copied metadata needs explicit new association
  return stored?.entries ?? [];
}

export function saveMapping(root: Root, namespace: string, nodeId: string, mapping: Omit<Mapping, 'nodeId'>): Mapping[] {
  if (!namespaceId.test(namespace) || !sourceId.test(nodeId)) throw new Error('AMBIGUOUS_MAPPING: invalid source identity');
  if (!identifier.test(mapping.alias)) throw new Error('INVALID_ALIAS: use a public identifier without paths or spaces');
  const existing = loadMappings(root, namespace);
  if (existing.some(entry => entry.nodeId !== nodeId && entry.alias.toLowerCase() === mapping.alias.toLowerCase()))
    throw new Error('ALIAS_COLLISION: another source already owns this public alias');
  const pageId = mapping.pageId ?? existing.find(item => item.nodeId === nodeId)?.pageId;
  const entry = { ...mapping, nodeId, ...(pageId ? { pageId } : {}) };
  const candidate = { version: 1, namespace, entries: [...existing.filter(item => item.nodeId !== nodeId), entry].sort((a, b) => a.nodeId.localeCompare(b.nodeId)) };
  // Verify the same bounded representation before writing; no credentials or design assets belong here.
  const raw = JSON.stringify(candidate);
  if (raw.length > 16000) throw new Error('AMBIGUOUS_MAPPING: mapping metadata budget exceeded');
  const check = { getPluginData: () => raw, setPluginData: () => {} };
  parse(check);
  root.setPluginData(key, raw);
  return candidate.entries;
}

export function aliasesForSelection(mappings: readonly Mapping[], ids: readonly string[]): Record<string, string> {
  return Object.fromEntries(mappings.filter(item => ids.includes(item.nodeId)).map(item => [item.nodeId, item.alias]));
}

export function resolveMapping(mapping: Mapping, active: typeof builtinCatalog): string[] {
  if (mapping.catalogId !== active.catalogId || mapping.revision !== active.revision)
    return [`CATALOG_MISMATCH: ${mapping.catalogId}@${mapping.revision} is not ${active.catalogId}@${active.revision}; reconnect to the matching target catalog or remap explicitly`];
  const control = active.controls.find(item => item.id === mapping.controlId);
  if (!control) return [`UNRESOLVED_COMPONENT: ${mapping.controlId} is not in the active catalog`];
  if (!control.available || !control.modes.includes(mapping.mode as never))
    return [`INVALID_CONTROL_CONTRACT: ${mapping.controlId} has no verified ${mapping.mode} adapter`];
  return [];
}
