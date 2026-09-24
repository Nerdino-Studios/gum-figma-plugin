// Wire shape validation only. Domain semantics and content hashing belong to later use cases.
export type ContractKind = 'request' | 'snapshot' | 'catalog' | 'diagnostic';

const fields: Record<ContractKind, readonly string[]> = {
  request: ['operation'],
  snapshot: ['snapshotId', 'documentNamespace', 'selectedRootIds', 'rootAliases', 'nodes'],
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

function validNode(value: unknown): boolean {
  if (!record(value)) return false;
  const required = ['id', 'parentId', 'type', 'name', 'x', 'y', 'width', 'height', 'visible'];
  const optional = ['layoutMode', 'clipsContent', 'characters', 'fontSize', 'fontFamily', 'fontStyle', 'color', 'imageHash', 'scaleMode',
    'horizontalSizing', 'verticalSizing', 'horizontalAnchor', 'verticalAnchor', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
    'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'counterAxisAlignItems', 'layoutAlign', 'rotation', 'imageTransform'];
  if (!required.every(key => Object.hasOwn(value, key)) || !Object.keys(value).every(key => [...required, ...optional].includes(key))) return false;
  if (!text(value.id) || !(value.parentId === null || text(value.parentId)) || !text(value.name) || typeof value.visible !== 'boolean' ||
      !['FRAME', 'TEXT', 'IMAGE'].includes(value.type as string) ||
      !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && (key === 'x' || key === 'y' || (value[key] as number) >= 0))) return false;
  if (Object.hasOwn(value, 'color') && (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/.test(value.color))) return false;
  for (const [key, allowed] of Object.entries({ horizontalSizing: ['FIXED', 'FILL', 'HUG'], verticalSizing: ['FIXED', 'FILL', 'HUG'],
    horizontalAnchor: ['MIN', 'MAX', 'CENTER', 'STRETCH'], verticalAnchor: ['MIN', 'MAX', 'CENTER', 'STRETCH'] })) {
    if (Object.hasOwn(value, key) && !allowed.includes(value[key] as string)) return false;
  }
  if (Object.hasOwn(value, 'imageTransform') && (!Array.isArray(value.imageTransform) || value.imageTransform.length !== 2 ||
    !value.imageTransform.every(row => Array.isArray(row) && row.length === 3 && row.every(n => typeof n === 'number' && Number.isFinite(n))))) return false;
  if (Object.hasOwn(value, 'rotation') && (typeof value.rotation !== 'number' || !Number.isFinite(value.rotation))) return false;
  for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'])
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) < 0)) return false;
  for (const key of ['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'])
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) < 0)) return false;
  for (const [key, allowed] of Object.entries({ counterAxisAlignItems: ['MIN', 'CENTER', 'MAX'], layoutAlign: ['INHERIT', 'MIN', 'CENTER', 'MAX'] }))
    if (Object.hasOwn(value, key) && !allowed.includes(value[key] as string)) return false;
  switch (value.type) {
    case 'FRAME': return !['characters', 'fontSize', 'fontFamily', 'fontStyle', 'imageHash', 'scaleMode', 'imageTransform'].some(key => Object.hasOwn(value, key)) &&
      ['NONE', 'HORIZONTAL', 'VERTICAL'].includes(value.layoutMode as string) && typeof value.clipsContent === 'boolean';
    case 'TEXT': return !['layoutMode', 'clipsContent', 'imageHash', 'scaleMode', 'imageTransform', 'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'counterAxisAlignItems'].some(key => Object.hasOwn(value, key)) &&
      typeof value.characters === 'string' && text(value.fontFamily) && text(value.fontStyle) && typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) && value.fontSize > 0;
    case 'IMAGE': return !['layoutMode', 'clipsContent', 'characters', 'fontSize', 'fontFamily', 'fontStyle', 'color', 'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'counterAxisAlignItems'].some(key => Object.hasOwn(value, key)) &&
      typeof value.imageHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.imageHash) && ['FIT', 'FILL', 'CROP'].includes(value.scaleMode as string) &&
      Object.hasOwn(value, 'imageTransform') === (value.scaleMode === 'CROP');
    default: return false;
  }
}

function aliasesValid(value: unknown): boolean {
  return Array.isArray(value) && value.every(entry => record(entry) && exact(entry, ['rootId', 'alias']) && text(entry.rootId) && text(entry.alias)) &&
    new Set(value.map(entry => entry.rootId)).size === value.length;
}

function textArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(text);
}

export function validateContract(kind: string, value: unknown): boolean {
  if (!Object.hasOwn(fields, kind) || !record(value)) return false;
  const required = fields[kind as ContractKind];
  const allowed = ['schemaVersion', ...required, 'extensions', ...(kind === 'snapshot' ? ['extractionDiagnostics'] : [])];
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
    case 'snapshot': return (!Object.hasOwn(value, 'extractionDiagnostics') ||
      Array.isArray(value.extractionDiagnostics) && value.extractionDiagnostics.length > 0 &&
      value.extractionDiagnostics.every(d => validateContract('diagnostic', d) && d.severity === 'error' && d.code === 'UNSUPPORTED_FEATURE')) &&
      text(value.snapshotId) && text(value.documentNamespace) &&
      textArray(value.selectedRootIds) && aliasesValid(value.rootAliases) &&
      (value.rootAliases as { rootId: string }[]).every(entry => (value.selectedRootIds as string[]).includes(entry.rootId)) &&
      Array.isArray(value.nodes) && value.nodes.every(validNode) && ((version.minor as number) >= 1 ||
        value.nodes.every(node => record(node) && !['horizontalSizing', 'verticalSizing', 'horizontalAnchor', 'verticalAnchor', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'].some(key => Object.hasOwn(node, key)))) &&
      ((version.minor as number) >= 2 || value.nodes.every(node => record(node) &&
        !['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'counterAxisAlignItems', 'layoutAlign'].some(key => Object.hasOwn(node, key)) &&
        node.horizontalSizing !== 'HUG' && node.verticalSizing !== 'HUG')) &&
      ((version.minor as number) >= 3 || value.nodes.every(node => record(node) &&
        !Object.hasOwn(node, 'rotation') && !Object.hasOwn(node, 'imageTransform')));
    case 'catalog': return text(value.catalogId) && text(value.revision) &&
      Array.isArray(value.controls) && value.controls.length === 0;
    case 'diagnostic': return text(value.code) && text(value.message) &&
      ['info', 'warning', 'error'].includes(value.severity as string);
    default: return false;
  }
}
