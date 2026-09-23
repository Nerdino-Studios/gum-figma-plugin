import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { readSelectedRoots, type ExtractionDiagnostic } from './selection.ts';

export interface SourceNode {
  id: string; name: string; type: string; x: number; y: number; width: number; height: number; visible: boolean;
  children?: readonly SourceNode[]; layoutMode?: string; clipsContent?: boolean;
  cornerRadius?: number | symbol; rectangleCornerRadii?: readonly number[]; isMask?: boolean; blendMode?: string;
  textAlignHorizontal?: string; textAlignVertical?: string; lineHeight?: unknown; letterSpacing?: unknown;
  textCase?: string; textDecoration?: string; paragraphSpacing?: number; textAutoResize?: string;
  textTruncation?: string; maxLines?: number; fontWeight?: number; textStyleId?: string; fillStyleId?: string;
  boundVariables?: unknown;
  characters?: string; fontSize?: number | symbol; fills?: readonly { type: string; imageHash?: string; scaleMode?: string; color?: { r: number; g: number; b: number }; opacity?: number; visible?: boolean; imageTransform?: unknown; rotation?: number; filters?: Readonly<Record<string, number>>; blendMode?: string; boundVariables?: unknown }[] | symbol;
  fontName?: unknown; effects?: readonly unknown[]; strokes?: readonly unknown[];
  itemSpacing?: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  rotation?: number; opacity?: number; layoutSizingHorizontal?: string; layoutSizingVertical?: string;
  constraints?: { horizontal: string; vertical: string };
  minWidth?: number | null; maxWidth?: number | null; minHeight?: number | null; maxHeight?: number | null;
}
export interface DesignNode {
  id: string; parentId: string | null; type: 'FRAME' | 'TEXT' | 'IMAGE'; name: string;
  x: number; y: number; width: number; height: number; visible: boolean;
  layoutMode?: string; clipsContent?: boolean; characters?: string; fontSize?: number; fontFamily?: string; fontStyle?: string; color?: string; imageHash?: string; scaleMode?: string;
}
export function hashBytes(bytes: Uint8Array): string { return `sha256:${bytesToHex(sha256(bytes))}`; }

// JSON keys sorted recursively. Reject non-finite numbers before hashing; normalize -0 and CRLF.
export function canonicalize(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical numbers must be finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value.replace(/\r\n?/g, '\n'));
  if (typeof value === 'boolean' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${canonicalize(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Unsupported canonical value');
}
const hash = (value: unknown) => hashBytes(utf8ToBytes(canonicalize(value)));
const limits = { maxNodes: 256, maxDepth: 16, maxAssetBytes: 4 * 1024 * 1024 };

// Scene-only adapter: callers supply their persisted namespace; never use fileKey or a local path.
export function captureCurrentSelection(documentNamespace: string, aliases: Readonly<Record<string, string>> = {}) {
  return captureSelection(figma.currentPage.selection as unknown as SourceNode[], documentNamespace, figma, {}, aliases);
}

export async function captureSelection(
  selection: readonly SourceNode[], documentNamespace: string,
  images: { getImageByHash(hash: string): { getBytesAsync(): Promise<Uint8Array> } | null },
  budget: Partial<typeof limits> = {}, aliases: Readonly<Record<string, string>> = {},
) {
  if (!documentNamespace || /[/\\]/.test(documentNamespace)) throw new Error('Document namespace must be a path-free identity');
  const bound = { ...limits, ...budget };
  // An oversized selection is incomplete: reject it before inspecting any root identity,
  // sorting, or emitting one diagnostic per root. The node budget applies to roots too.
  if (selection.length > bound.maxNodes) return {
    snapshot: null, assets: [], diagnostics: [{ code: 'UNSUPPORTED_FEATURE', severity: 'error' as const,
      nodeId: '', property: 'selection', message: 'Selected root count exceeds node budget' }],
  };
  const roots = readSelectedRoots(selection, aliases);
  const diagnostics: ExtractionDiagnostic[] = [...roots.diagnostics];
  const nodes: DesignNode[] = [];
  const assets: { hash: string; bytes: Uint8Array }[] = [];
  const pending: { node: DesignNode; sourceHash: string }[] = [];
  const selected = selection.filter(root => root.type === 'FRAME').sort((a, b) => a.id.localeCompare(b.id));
  const observed: { node: SourceNode; fingerprint: string; childIds?: string[]; childCount?: number }[] = [];
  const mixed = (value: unknown) => typeof value === 'symbol' ? 'MIXED' : value ?? null;
  const propertySnapshot = (node: SourceNode) => ({
    id: node.id, name: node.name, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height, visible: node.visible,
    layoutMode: node.layoutMode ?? null, clipsContent: node.clipsContent ?? null, characters: node.characters ?? null,
    fontSize: typeof node.fontSize === 'symbol' ? 'MIXED' : node.fontSize ?? null,
    fontName: typeof node.fontName === 'symbol' ? 'MIXED' : node.fontName ?? null,
    fills: typeof node.fills === 'symbol' ? 'MIXED' : (node.fills ?? []).map(p => ({ type: p.type, imageHash: p.imageHash ?? null,
      scaleMode: p.scaleMode ?? null, color: p.color ?? null, opacity: p.opacity ?? null, visible: p.visible ?? null,
      imageTransform: p.imageTransform ?? null, rotation: p.rotation ?? null, filters: p.filters ?? null,
      blendMode: p.blendMode ?? null, boundVariables: p.boundVariables ?? null })),
    effects: node.effects?.length ?? 0, strokes: node.strokes?.length ?? 0,
    itemSpacing: node.itemSpacing ?? null, paddingLeft: node.paddingLeft ?? null, paddingRight: node.paddingRight ?? null,
    paddingTop: node.paddingTop ?? null, paddingBottom: node.paddingBottom ?? null, rotation: node.rotation ?? null,
    opacity: node.opacity ?? null, layoutSizingHorizontal: node.layoutSizingHorizontal ?? null,
    layoutSizingVertical: node.layoutSizingVertical ?? null,
    constraints: node.constraints ?? null, minWidth: node.minWidth ?? null, maxWidth: node.maxWidth ?? null,
    minHeight: node.minHeight ?? null, maxHeight: node.maxHeight ?? null,
    cornerRadius: typeof node.cornerRadius === 'symbol' ? 'MIXED' : node.cornerRadius ?? null,
    rectangleCornerRadii: node.rectangleCornerRadii ?? null, isMask: node.isMask ?? null, blendMode: node.blendMode ?? null,
    textAlignHorizontal: node.textAlignHorizontal ?? null, textAlignVertical: node.textAlignVertical ?? null,
    lineHeight: mixed(node.lineHeight), letterSpacing: mixed(node.letterSpacing), textCase: node.textCase ?? null,
    textDecoration: node.textDecoration ?? null, paragraphSpacing: node.paragraphSpacing ?? null,
    textAutoResize: node.textAutoResize ?? null, textTruncation: node.textTruncation ?? null,
    maxLines: node.maxLines ?? null, fontWeight: node.fontWeight ?? null, textStyleId: node.textStyleId ?? null,
    fillStyleId: node.fillStyleId ?? null, boundVariables: mixed(node.boundVariables),
  });
  function fail(node: SourceNode, property: string, message: string, code = 'UNSUPPORTED_FEATURE') {
    diagnostics.push({ code, severity: 'error', nodeId: node.id, property, message });
  }
  function visit(node: SourceNode, parentId: string | null, depth: number) {
    if (depth > bound.maxDepth || nodes.length >= bound.maxNodes) { fail(node, 'children', 'Capture depth/node budget exceeded'); return; }
    const observation: (typeof observed)[number] = { node, fingerprint: hash(propertySnapshot(node)) };
    observed.push(observation);
    if (!node.id || !node.name) { fail(node, 'identity', 'Source ID and display name are required'); return; }
    if (!['FRAME', 'TEXT', 'RECTANGLE'].includes(node.type)) { fail(node, 'type', `Unsupported node: ${node.type}`); return; }
    if ((node.effects?.length ?? 0) > 0 || (node.strokes?.length ?? 0) > 0) fail(node, 'effects/strokes', 'Effects and strokes are not supported');
    if (node.rotation && node.rotation !== 0) fail(node, 'rotation', 'Rotated nodes are not supported');
    if (node.opacity !== undefined && node.opacity !== 1) fail(node, 'opacity', 'Non-opaque nodes are not supported');
    if (node.cornerRadius !== undefined && node.cornerRadius !== 0) fail(node, 'cornerRadius', 'Rounded corners are not captured');
    if (node.rectangleCornerRadii?.some(radius => radius !== 0)) fail(node, 'rectangleCornerRadii', 'Rounded corners are not captured');
    if (node.isMask) fail(node, 'isMask', 'Masks are not captured');
    if (node.blendMode && node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') fail(node, 'blendMode', 'Blend mode is not captured');
    if (node.boundVariables && Object.keys(node.boundVariables).length) fail(node, 'boundVariables', 'Variables are not resolved');
    if (node.fillStyleId) fail(node, 'fillStyleId', 'Paint style provenance is not captured');
    if (node.type === 'TEXT') {
      const unsupportedText: [string, unknown, unknown][] = [
        ['textAlignHorizontal', node.textAlignHorizontal, 'LEFT'], ['textAlignVertical', node.textAlignVertical, 'TOP'],
        ['textCase', node.textCase, 'ORIGINAL'], ['textDecoration', node.textDecoration, 'NONE'],
        ['paragraphSpacing', node.paragraphSpacing, 0], ['textAutoResize', node.textAutoResize, 'NONE'],
        ['textTruncation', node.textTruncation, 'DISABLED'], ['textStyleId', node.textStyleId, ''],
      ];
      for (const [property, value, defaultValue] of unsupportedText) {
        if (value !== undefined && value !== defaultValue) fail(node, property, 'Text property is not captured');
      }
      if (node.lineHeight !== undefined && !(typeof node.lineHeight === 'object' && node.lineHeight !== null &&
        'unit' in node.lineHeight && node.lineHeight.unit === 'AUTO')) fail(node, 'lineHeight', 'Non-auto line height is not captured');
      if (node.letterSpacing !== undefined && !(typeof node.letterSpacing === 'object' && node.letterSpacing !== null &&
        'unit' in node.letterSpacing && node.letterSpacing.unit === 'PIXELS' && 'value' in node.letterSpacing && node.letterSpacing.value === 0)) {
        fail(node, 'letterSpacing', 'Nonzero or non-pixel letter spacing is not captured');
      }
      if (node.maxLines != null) fail(node, 'maxLines', 'Line limit is not captured');
      // The thin slice supports only plain Regular text; font style is captured on the node.
      if (node.fontWeight !== undefined && node.fontWeight !== 400) fail(node, 'fontWeight', 'Non-regular font weight is not captured');
    }
    if (node.constraints && (node.constraints.horizontal !== 'MIN' || node.constraints.vertical !== 'MIN')) {
      fail(node, 'constraints', 'Non-default constraints are not yet captured');
    }
    for (const property of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      if (node[property] != null) fail(node, property, 'Sizing limit is not yet captured');
    }
    for (const property of ['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'] as const) {
      if (node[property] !== undefined && node[property] !== 0) fail(node, property, 'Layout spacing/padding is not yet captured');
    }
    for (const property of ['layoutSizingHorizontal', 'layoutSizingVertical'] as const) {
      if (node[property] && node[property] !== 'FIXED') fail(node, property, 'Non-fixed sizing is not yet captured');
    }
    if (![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width < 0 || node.height < 0) {
      fail(node, 'bounds', 'Bounds must be finite and nonnegative in size'); return;
    }
    if (typeof node.fills === 'symbol') { fail(node, 'fills', 'Mixed fills are not supported'); return; }
    const fill = node.fills ?? [];
    for (const paint of fill) {
      if (paint.type === 'IMAGE') {
        if (paint.rotation !== undefined && paint.rotation !== 0) fail(node, 'fills.rotation', 'Image paint rotation is not captured');
        if (paint.filters && Object.entries(paint.filters).some(([key, value]) =>
          !['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'].includes(key) || value !== 0)) {
          fail(node, 'fills.filters', 'Image paint filters are not captured');
        }
      }
      if ((paint.opacity !== undefined && paint.opacity !== 1) || paint.visible === false ||
        (paint.blendMode && paint.blendMode !== 'NORMAL') || paint.boundVariables && Object.keys(paint.boundVariables).length) {
        fail(node, 'fills', 'Paint opacity, visibility, blend or variables are not captured');
      }
    }
    if (fill.length > 1 || fill.some(p => p.type !== (node.type === 'RECTANGLE' ? 'IMAGE' : 'SOLID'))) fail(node, 'fills', 'Only one solid frame/text fill or raster image is supported');
    const solid = node.type !== 'RECTANGLE' ? fill[0] : undefined;
    if (solid && (solid.visible === false || solid.opacity !== undefined && solid.opacity !== 1 ||
      !solid.color || ![solid.color.r, solid.color.g, solid.color.b].every(v => Number.isFinite(v) && v >= 0 && v <= 1))) {
      fail(node, 'fills', 'Solid fill must have opaque finite RGB');
    }
    if (node.type === 'FRAME' && node.layoutMode && node.layoutMode !== 'NONE') fail(node, 'layoutMode', 'Auto layout requires further captured alignment and spacing');
    if (node.type === 'RECTANGLE' && (fill.length !== 1 || fill[0].type !== 'IMAGE' || !fill[0].imageHash || !['FIT', 'FILL'].includes(fill[0].scaleMode ?? ''))) {
      fail(node, 'fills', 'Rectangle requires a FIT/FILL raster image'); return;
    }
    if (node.type === 'RECTANGLE' && fill[0]?.imageTransform) fail(node, 'fills.imageTransform', 'Image crop/transform is not captured');
    if (node.type === 'TEXT' && (typeof node.fontSize !== 'number' || !Number.isFinite(node.fontSize) || node.fontSize <= 0 || typeof node.characters !== 'string' || !(typeof node.fontName === 'object' && node.fontName !== null && 'family' in node.fontName && 'style' in node.fontName && typeof node.fontName.family === 'string' && typeof node.fontName.style === 'string')))  {
      fail(node, 'text', 'Text requires uniform style and characters'); return;
    }
    if (node.type === 'FRAME' && !['NONE', 'HORIZONTAL', 'VERTICAL'].includes(node.layoutMode ?? 'NONE')) fail(node, 'layoutMode', 'Unsupported layout mode');
    const color = solid?.color && [solid.color.r, solid.color.g, solid.color.b].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
      ? `#${[solid.color.r, solid.color.g, solid.color.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : undefined;
    const output: DesignNode = {
      id: node.id, parentId, type: node.type === 'RECTANGLE' ? 'IMAGE' : node.type as 'FRAME' | 'TEXT', name: node.name,
      x: node.x, y: node.y, width: node.width, height: node.height, visible: node.visible,
      ...(color ? { color } : {}),
      ...(node.type === 'FRAME' ? { layoutMode: node.layoutMode ?? 'NONE', clipsContent: node.clipsContent ?? false } : {}),
      ...(node.type === 'TEXT' ? { characters: node.characters!, fontSize: node.fontSize as number, fontFamily: (node.fontName as { family: string }).family, fontStyle: (node.fontName as { style: string }).style } : {}),
      ...(node.type === 'RECTANGLE' && fill[0]?.imageHash ? { scaleMode: fill[0].scaleMode } : {}),
    };
    nodes.push(output);
    if (node.type === 'RECTANGLE' && fill[0]?.imageHash) pending.push({ node: output, sourceHash: fill[0].imageHash });
    // At the boundary, do not even touch the children getter. Block conservatively.
    if (depth >= bound.maxDepth || nodes.length >= bound.maxNodes) {
      fail(node, 'children', 'Capture stopped at depth/node budget'); return;
    }
    const children = node.children ?? [];
    observation.childCount = children.length;
    // Reject wide branches before reading any child IDs. Neither diagnostics nor freshness
    // may scale with a subtree that the capture budget cannot visit.
    if (children.length > bound.maxNodes - nodes.length) {
      fail(node, 'children', 'Capture stopped at node budget'); return;
    }
    observation.childIds = children.map(child => child.id);
    for (const child of children) visit(child, node.id, depth + 1);
  }
  for (const root of selected) visit(root, null, 0);
  for (const item of pending) {
    const image = images.getImageByHash(item.sourceHash);
    if (!image) { diagnostics.push({ code: 'UNRESOLVED_ASSET', severity: 'error', nodeId: item.node.id, property: 'fills', message: 'Image bytes are unavailable' }); continue; }
    const bytes = await image.getBytesAsync();
    if (bytes.length > bound.maxAssetBytes) { diagnostics.push({ code: 'UNSUPPORTED_FEATURE', severity: 'error', nodeId: item.node.id, property: 'fills', message: 'Asset byte budget exceeded' }); continue; }
    item.node.imageHash = hashBytes(bytes);
    if (!assets.some(asset => asset.hash === item.node.imageHash)) assets.push({ hash: item.node.imageHash, bytes });
  }
  if (observed.some(entry => hash(propertySnapshot(entry.node)) !== entry.fingerprint ||
      entry.childCount !== undefined && ((entry.node.children ?? []).length !== entry.childCount ||
        entry.childIds !== undefined && canonicalize((entry.node.children ?? []).map(child => child.id)) !== canonicalize(entry.childIds)))) {
    diagnostics.push({ code: 'SOURCE_CHANGED_DURING_CAPTURE', severity: 'error', nodeId: selected[0]?.id ?? '', property: 'selection', message: 'Selected source changed during capture' });
  }
  if (diagnostics.length) return { snapshot: null, assets: [], diagnostics };
  const selectedRootIds = selected.map(root => root.id);
  const rootAliases = roots.roots.filter(root => root.alias).sort((a, b) => a.id.localeCompare(b.id)).map(root => ({ rootId: root.id, alias: root.alias! }));
  const semantic = { documentNamespace, selectedRootIds, rootAliases, nodes };
  return { snapshot: { schemaVersion: { major: 1, minor: 0 }, snapshotId: hash(semantic), ...semantic }, assets, diagnostics };
}
