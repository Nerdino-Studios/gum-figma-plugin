import { hashBytes } from '../hash.ts';
export { hashBytes } from '../hash.ts';
import { readSelectedRoots, type ExtractionDiagnostic } from './selection.ts';
import { encodeUtf8 } from './utf8.ts';
import { rasterFallbackPlan } from './raster-fallback.ts';

export interface SourceNode {
  id: string; name: string; type: string; x: number; y: number; width: number; height: number; visible: boolean;
  children?: readonly SourceNode[]; layoutMode?: string; clipsContent?: boolean;
  getMainComponentAsync?: () => Promise<SourceNode | null>;
  overrides?: readonly { id: string; overriddenFields: readonly string[] }[];
  exportAsync?: (settings: { format: 'PNG'; constraint: { type: 'SCALE'; value: 1 }; useAbsoluteBounds?: boolean; contentsOnly?: boolean }) => Promise<Uint8Array>;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  absoluteRenderBounds?: { x: number; y: number; width: number; height: number } | null;
  reactions?: readonly unknown[]; strokeWeight?: number; strokeAlign?: string;
  strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number;
  dashPattern?: readonly number[]; strokeDashes?: readonly number[]; strokeJoin?: string; strokeCap?: string; strokeMiterLimit?: number;
  pointCount?: number; cornerSmoothing?: number;
  cornerRadius?: number | symbol; rectangleCornerRadii?: readonly number[]; isMask?: boolean; blendMode?: string;
  textAlignHorizontal?: string; textAlignVertical?: string; lineHeight?: unknown; letterSpacing?: unknown;
  textCase?: string; textDecoration?: string; paragraphSpacing?: number; textAutoResize?: string;
  textTruncation?: string; maxLines?: number; fontWeight?: number; textStyleId?: string; fillStyleId?: string; strokeStyleId?: string; effectStyleId?: string;
  boundVariables?: unknown;
  characters?: string; fontSize?: number | symbol; fills?: readonly { type: string; imageHash?: string; scaleMode?: string; color?: { r: number; g: number; b: number }; opacity?: number; visible?: boolean; imageTransform?: unknown; rotation?: number; filters?: Readonly<Record<string, number>>; blendMode?: string; boundVariables?: unknown }[] | symbol;
  fontName?: unknown; effects?: readonly unknown[]; strokes?: readonly unknown[];
  itemSpacing?: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  counterAxisAlignItems?: string; primaryAxisAlignItems?: string; layoutWrap?: string; layoutAlign?: string; layoutPositioning?: string;
  rotation?: number; relativeTransform?: readonly (readonly number[])[]; opacity?: number; layoutSizingHorizontal?: string; layoutSizingVertical?: string;
  constraints?: { horizontal: string; vertical: string };
  minWidth?: number | null; maxWidth?: number | null; minHeight?: number | null; maxHeight?: number | null;
}
export interface DesignNode {
  id: string; parentId: string | null; type: 'FRAME' | 'TEXT' | 'IMAGE' | 'INSTANCE'; name: string;
  componentId?: string;
  x: number; y: number; width: number; height: number; visible: boolean;
  layoutMode?: string; clipsContent?: boolean; characters?: string; fontSize?: number; fontFamily?: string; fontStyle?: string; color?: string; imageHash?: string; scaleMode?: string;
  imageTransform?: readonly (readonly number[])[];
  fallback?: { feature: string; fingerprint: string };
  horizontalSizing?: 'FILL' | 'HUG'; verticalSizing?: 'FILL' | 'HUG'; horizontalAnchor?: 'MAX' | 'CENTER' | 'STRETCH'; verticalAnchor?: 'MAX' | 'CENTER' | 'STRETCH';
  minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number;
  itemSpacing?: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX'; layoutAlign?: 'INHERIT' | 'MIN' | 'CENTER' | 'MAX'; rotation?: number;
}
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
const hash = (value: unknown) => hashBytes(encodeUtf8(canonicalize(value)));
const limits = { maxNodes: 256, maxDepth: 16, maxAssetBytes: 4 * 1024 * 1024 };

// Scene-only adapter: callers supply their persisted namespace; never use fileKey or a local path.
export function captureCurrentSelection(documentNamespace: string, aliases: Readonly<Record<string, string>> = {}) {
  return captureSelection(figma.currentPage.selection as unknown as SourceNode[], documentNamespace, figma, {}, aliases);
}

export async function captureSelection(
  selection: readonly SourceNode[], documentNamespace: string,
  images: { getImageByHash(hash: string): { getBytesAsync(): Promise<Uint8Array> } | null },
  budget: Partial<typeof limits> = {}, aliases: Readonly<Record<string, string>> = {},
  approvals: readonly { nodeId: string; feature: string; fingerprint: string }[] = [],
  rootMappings: readonly { rootId: string; mode: 'generate'; catalogId: string; revision: string; controlId: 'native.frame' }[] = [],
  componentMappings: Readonly<Record<string, { alias: string; mode: 'generate' } | { alias: string; mode: 'reference'; controlId: string; targetWidth: number; targetHeight: number }>> = {},
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
  let totalNodes = 0;
  const assets: { hash: string; bytes: Uint8Array }[] = [];
  const pending: { node: DesignNode; sourceHash: string }[] = [];
  const fallbackExports: { node: DesignNode; source: SourceNode; useAbsoluteBounds: boolean }[] = [];
  const instances: { node: DesignNode; source: SourceNode }[] = [];
  const components: ({ id: string; alias: string; mode: 'generate'; nodes: DesignNode[] } |
    { id: string; alias: string; mode: 'reference'; controlId: string; width: number; height: number })[] = [];
  const componentSources = new Map<string, SourceNode>();
  const definitionObservations: { source: SourceNode; fingerprint: string; childIds: string[]; graph: string }[] = [];
  const selected = selection.filter(root => root.type === 'FRAME').sort((a, b) => a.id.localeCompare(b.id));
  const observed: { node: SourceNode; fingerprint: string; childIds?: string[]; childCount?: number }[] = [];
  const mixed = (value: unknown) => typeof value === 'symbol' ? 'MIXED' : value ?? null;
  const propertySnapshot = (node: SourceNode) => ({
    id: node.id, name: node.name, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height, visible: node.visible,
    layoutMode: node.layoutMode ?? null, clipsContent: node.clipsContent ?? null, characters: node.characters ?? null,
    fontSize: typeof node.fontSize === 'symbol' ? 'MIXED' : node.fontSize ?? null,
    fontName: typeof node.fontName === 'symbol' ? 'MIXED' : node.fontName ?? null,
    // Hash the complete Figma paint data: gradients and future paint fields affect raster output.
    // Exclude absent optional properties, not material stop/color/transform values.
    fills: typeof node.fills === 'symbol' ? 'MIXED' : (node.fills ?? []).map(p =>
      Object.fromEntries(Object.entries(p).filter(([, value]) => value !== undefined))),
    effects: node.effects ?? [], strokes: node.strokes ?? [], strokeWeight: node.strokeWeight ?? null,
    strokeAlign: node.strokeAlign ?? null, strokeTopWeight: node.strokeTopWeight ?? null,
    strokeRightWeight: node.strokeRightWeight ?? null, strokeBottomWeight: node.strokeBottomWeight ?? null,
    strokeLeftWeight: node.strokeLeftWeight ?? null, dashPattern: node.dashPattern ?? null,
    strokeDashes: node.strokeDashes ?? null, strokeJoin: node.strokeJoin ?? null,
    strokeCap: node.strokeCap ?? null, strokeMiterLimit: node.strokeMiterLimit ?? null,
    strokeStyleId: node.strokeStyleId ?? null, effectStyleId: node.effectStyleId ?? null,
    reactions: node.reactions ?? null, absoluteBoundingBox: node.absoluteBoundingBox ?? null,
    absoluteRenderBounds: node.absoluteRenderBounds ?? null,
    itemSpacing: node.itemSpacing ?? null, paddingLeft: node.paddingLeft ?? null, paddingRight: node.paddingRight ?? null,
    paddingTop: node.paddingTop ?? null, paddingBottom: node.paddingBottom ?? null,
    counterAxisAlignItems: node.counterAxisAlignItems ?? null, primaryAxisAlignItems: node.primaryAxisAlignItems ?? null,
    layoutWrap: node.layoutWrap ?? null, layoutAlign: node.layoutAlign ?? null,
    layoutPositioning: node.layoutPositioning ?? null, rotation: node.rotation ?? null, relativeTransform: node.relativeTransform ?? null,
    opacity: node.opacity ?? null, layoutSizingHorizontal: node.layoutSizingHorizontal ?? null,
    layoutSizingVertical: node.layoutSizingVertical ?? null,
    constraints: node.constraints ?? null, minWidth: node.minWidth ?? null, maxWidth: node.maxWidth ?? null,
    minHeight: node.minHeight ?? null, maxHeight: node.maxHeight ?? null,
    cornerRadius: typeof node.cornerRadius === 'symbol' ? 'MIXED' : node.cornerRadius ?? null,
    pointCount: node.pointCount ?? null, cornerSmoothing: node.cornerSmoothing ?? null,
    rectangleCornerRadii: node.rectangleCornerRadii ?? null, isMask: node.isMask ?? null, blendMode: node.blendMode ?? null,
    textAlignHorizontal: node.textAlignHorizontal ?? null, textAlignVertical: node.textAlignVertical ?? null,
    lineHeight: mixed(node.lineHeight), letterSpacing: mixed(node.letterSpacing), textCase: node.textCase ?? null,
    textDecoration: node.textDecoration ?? null, paragraphSpacing: node.paragraphSpacing ?? null,
    textAutoResize: node.textAutoResize ?? null, textTruncation: node.textTruncation ?? null,
    maxLines: node.maxLines ?? null, fontWeight: node.fontWeight ?? null, textStyleId: node.textStyleId ?? null,
    fillStyleId: node.fillStyleId ?? null, boundVariables: mixed(node.boundVariables),
    overrides: node.overrides ?? null,
  });
  function definitionGraph(source: SourceNode): string {
    const graph: unknown[] = [];
    const stack = [{ node: source, depth: 0 }];
    while (stack.length && graph.length <= bound.maxNodes) {
      const { node, depth } = stack.pop()!;
      if (depth > bound.maxDepth) return 'over-depth';
      const children = node.children ?? [];
      if (children.length > bound.maxNodes) return 'over-budget';
      graph.push([propertySnapshot(node), children.map(child => child.id)]);
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1 });
    }
    return graph.length > bound.maxNodes ? 'over-budget' : hash(graph);
  }
  function hasUnsupportedComponentTransform(transform: SourceNode['relativeTransform']): boolean {
    return transform !== undefined && (!Array.isArray(transform) || transform.length !== 2 ||
      !transform.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)) ||
      Math.abs(transform[0][0] - 1) > 0.00001 || Math.abs(transform[0][1]) > 0.00001 ||
      Math.abs(transform[1][0]) > 0.00001 || Math.abs(transform[1][1] - 1) > 0.00001);
  }
  function fail(node: SourceNode, property: string, message: string, code = 'UNSUPPORTED_FEATURE') {
    diagnostics.push({ code, severity: 'error', nodeId: node.id, property, message: `${node.name}: ${message}` });
  }
  function visit(node: SourceNode, parentId: string | null, depth: number, parent?: SourceNode, interactiveAncestor = false, rotatedAncestor = false) {
    if (depth > bound.maxDepth || totalNodes >= bound.maxNodes) { fail(node, 'children', 'Capture depth/node budget exceeded'); return; }
    const observation: (typeof observed)[number] = { node, fingerprint: hash(propertySnapshot(node)) };
    observed.push(observation);
    if (!node.id || !node.name) { fail(node, 'identity', 'Source ID and display name are required'); return; }
    if (!['FRAME', 'TEXT', 'RECTANGLE', 'POLYGON', 'INSTANCE'].includes(node.type)) { fail(node, 'type', `Unsupported node: ${node.type}`); return; }
    if (node.type === 'INSTANCE') {
      if (!parentId || !node.getMainComponentAsync || ![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width < 0 || node.height < 0)
        fail(node, 'instance', 'Instance needs a parent, bounded geometry and resolvable definition');
      if (node.opacity !== undefined && node.opacity !== 1) fail(node, 'opacity', 'Instance opacity is not an exposed component property');
      if (node.rotation !== undefined && (!Number.isFinite(node.rotation) || node.rotation !== 0) ||
          node.effects?.length || node.strokes?.length || node.reactions?.length)
        fail(node, 'instance', 'Instance rotation, effects, strokes and reactions require a verified control contract');
      if (hasUnsupportedComponentTransform(node.relativeTransform))
        fail(node, 'relativeTransform', 'Skew, scale and flip transforms are unsupported on instances');
      if (node.layoutSizingHorizontal && node.layoutSizingHorizontal !== 'FIXED' ||
          node.layoutSizingVertical && node.layoutSizingVertical !== 'FIXED' ||
          node.constraints?.horizontal && node.constraints.horizontal !== 'LEFT' ||
          node.constraints?.vertical && node.constraints.vertical !== 'TOP' ||
          [node.minWidth, node.maxWidth, node.minHeight, node.maxHeight].some(value => value != null))
        fail(node, 'instance', 'Responsive instance sizing and limits require a verified control contract');
      if (node.overrides?.some(change => change.id !== node.id ||
        change.overriddenFields.some(field => !['x', 'y', 'width', 'height', 'visible'].includes(field))))
        fail(node, 'overrides', 'Visual/child overrides require an explicit exposed-property contract');
      const output: DesignNode = { id: node.id, parentId, name: node.name, type: 'INSTANCE', x: node.x, y: node.y,
        width: node.width, height: node.height, visible: node.visible };
      nodes.push(output);
      totalNodes++;
      instances.push({ node: output, source: node });
      return;
    }
    const shape = node.type === 'RECTANGLE' || node.type === 'POLYGON';
    const shapeFill = typeof node.fills === 'symbol' ? [] : node.fills ?? [];
    const unsupportedShape = node.type === 'POLYGON' || shape && (
      shapeFill.length > 1 || shapeFill.some(paint => !['SOLID', 'IMAGE'].includes(paint.type)) ||
      !!node.cornerRadius || node.rectangleCornerRadii?.some(radius => radius !== 0));
    const needsFallback = unsupportedShape || (node.effects?.length ?? 0) > 0 || (node.strokes?.length ?? 0) > 0;
    const feature = unsupportedShape ? 'decorative-shape' : 'effects/strokes';
    const raster = rasterFallbackPlan(node, parentId, parent, interactiveAncestor, rotatedAncestor);
    const fingerprint = needsFallback ? hash({ namespace: documentNamespace, node: propertySnapshot(node), feature,
      ...(raster.useAbsoluteBounds ? { rasterBounds: 'node' } : {}) }) : '';
    const box = node.absoluteBoundingBox;
    const render = raster.bounds;
    const eligible = !!render;
    const approved = needsFallback && eligible &&
      approvals.some(entry => entry.nodeId === node.id && entry.feature === feature && entry.fingerprint === fingerprint);
    if (needsFallback && !approved) diagnostics.push({ code: 'UNSUPPORTED_FEATURE', severity: 'error', nodeId: node.id,
      property: feature, ...(eligible ? { fingerprint } : {}), message: eligible
        ? `Decorative raster fallback for "${node.name}": loses editability and resolution independence. Approve this exact node/feature to export PNG.`
        : `${node.name}: ${raster.reason}` });
    const rotated = node.rotation !== undefined && node.rotation !== 0;
    if (rotated && (node.type === 'TEXT' || node.type === 'FRAME' && (node.children?.length ?? 0) > 0 || parentId === null))
      fail(node, 'rotation', 'Rotated text or interactive container has unverified hit-test geometry');
    if (node.rotation !== undefined && (!Number.isFinite(node.rotation) || Math.abs(node.rotation) > 180))
      fail(node, 'rotation', 'Rotation must be finite and within Figma node range');
    const matrix = node.relativeTransform;
    if (matrix !== undefined) {
      const valid = matrix.length === 2 && matrix.every(row => row.length === 3 && row.every(Number.isFinite));
      const radians = (node.rotation ?? 0) * Math.PI / 180;
      if (!valid || Math.abs(matrix[0][0] - Math.cos(radians)) > 0.00001 ||
        Math.abs(matrix[0][1] - Math.sin(radians)) > 0.00001 ||
        Math.abs(matrix[1][0] + Math.sin(radians)) > 0.00001 ||
        Math.abs(matrix[1][1] - Math.cos(radians)) > 0.00001)
        fail(node, 'relativeTransform', 'Skew, scale and flip transforms are unsupported; do not flatten interactive geometry');
    }
    if (node.opacity !== undefined && node.opacity !== 1) fail(node, 'opacity', 'Non-opaque nodes are not supported');
    if (!approved && node.cornerRadius !== undefined && node.cornerRadius !== 0) fail(node, 'cornerRadius', 'Rounded corners are not captured');
    if (!approved && node.rectangleCornerRadii?.some(radius => radius !== 0)) fail(node, 'rectangleCornerRadii', 'Rounded corners are not captured');
    if (node.isMask) fail(node, 'isMask', 'Masks are not captured');
    if (node.blendMode && node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') fail(node, 'blendMode', 'Blend mode is not captured');
    if (node.boundVariables && Object.keys(node.boundVariables).length) fail(node, 'boundVariables', 'Variables are not resolved');
    if (node.fillStyleId) fail(node, 'fillStyleId', 'Paint style provenance is not captured');
    if (node.strokeStyleId || node.effectStyleId) fail(node, 'styleId', 'Stroke/effect style provenance is not captured');
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
    for (const [axis, sizingKey, size] of [['horizontal', 'layoutSizingHorizontal', 'Width'], ['vertical', 'layoutSizingVertical', 'Height']] as const) {
      const anchor = node.constraints?.[axis] ?? 'MIN';
      const sizing = node[sizingKey] ?? 'FIXED';
      if (!['MIN', 'MAX', 'CENTER', 'STRETCH'].includes(anchor)) fail(node, 'constraints', `Unsupported ${axis} anchor ${anchor}; use MIN, MAX, CENTER or STRETCH`);
      if (sizing !== 'FIXED' && !(sizing === 'HUG' && node.type === 'FRAME' && node.layoutMode !== 'NONE') &&
        !(sizing === 'FILL' && parent?.layoutMode !== undefined && parent.layoutMode !== 'NONE'))
        fail(node, sizingKey, `${axis} ${sizing} sizing requires a supported auto layout`);
      const min = node[`min${size}` as 'minWidth' | 'minHeight'];
      const max = node[`max${size}` as 'maxWidth' | 'maxHeight'];
      for (const [property, value] of [[`min${size}`, min], [`max${size}`, max]] as const)
        if (value != null && (!Number.isFinite(value) || value < 0)) fail(node, property, 'Sizing limit must be finite and nonnegative');
      if (min != null && max != null && min > max) fail(node, `min${size}`, 'Minimum exceeds maximum; correct sizing limits');
      if (parentId === null && (anchor !== 'MIN' || sizing !== 'FIXED' || min != null || max != null))
        fail(node, min != null ? `min${size}` : max != null ? `max${size}` : anchor !== 'MIN' ? 'constraints' : sizingKey,
          'Export root requires fixed geometry; apply responsive sizing and limits to children');
    }
    for (const property of ['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'] as const) {
      const value = node[property];
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || (value !== 0 && ((node.layoutMode ?? 'NONE') === 'NONE' || node.type !== 'FRAME'))))
        fail(node, property, 'Spacing and padding must be nonnegative values on an auto-layout frame');
    }
    if (node.counterAxisAlignItems && !['MIN', 'CENTER', 'MAX'].includes(node.counterAxisAlignItems))
      fail(node, 'counterAxisAlignItems', 'Unsupported cross-axis alignment');
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== 'MIN' && (node.layoutMode ?? 'NONE') === 'NONE')
      fail(node, 'counterAxisAlignItems', 'Cross-axis alignment requires auto layout');
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== 'MIN')
      fail(node, 'primaryAxisAlignItems', 'Main-axis distribution requires a verified stack rule');
    if (node.layoutWrap && node.layoutWrap !== 'NO_WRAP')
      fail(node, 'layoutWrap', 'Wrapping requires a verified Gum rule');
    if (node.layoutPositioning && node.layoutPositioning !== 'AUTO')
      fail(node, 'layoutPositioning', 'Absolute-positioned children are excluded from stack flow; a verified rule is required');
    if (node.layoutAlign && !['INHERIT', 'MIN', 'CENTER', 'MAX', 'STRETCH'].includes(node.layoutAlign))
      fail(node, 'layoutAlign', 'Unsupported per-child cross-axis alignment');
    if (node.layoutAlign && node.layoutAlign !== 'INHERIT' && (!parent || parent.layoutMode === 'NONE'))
      fail(node, 'layoutAlign', 'Per-child alignment requires auto-layout parent');
    if (node.layoutAlign === 'STRETCH' && parent &&
      (parent.layoutMode === 'HORIZONTAL' ? node.layoutSizingVertical : node.layoutSizingHorizontal) === 'HUG')
      fail(node, 'layoutAlign', 'Cross-axis STRETCH cannot also HUG');
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
    const image = node.type === 'RECTANGLE' && fill.length === 1 && fill[0].type === 'IMAGE';
    const nativeRectangle = node.type === 'RECTANGLE' && !approved && !image;
    if (!approved && (fill.length > 1 || fill.some(paint => paint.type !== (image ? 'IMAGE' : 'SOLID'))))
      fail(node, 'fills', 'Use one opaque solid fill or a FIT/FILL/CROP image; decorative shape paints need explicit PNG approval.');
    const solid = !image && !approved ? fill[0] : undefined;
    if (solid && (solid.visible === false || solid.opacity !== undefined && solid.opacity !== 1 ||
      !solid.color || ![solid.color.r, solid.color.g, solid.color.b].every(v => Number.isFinite(v) && v >= 0 && v <= 1))) {
      fail(node, 'fills', 'Solid fill must have opaque finite RGB');
    }
    if (image && !approved && (!fill[0].imageHash || !['FIT', 'FILL', 'CROP'].includes(fill[0].scaleMode ?? ''))) {
      fail(node, 'fills', 'Image-filled rectangle requires an available FIT/FILL/CROP raster image'); return;
    }
    if ((image || approved) && (node.constraints?.horizontal === 'STRETCH' || node.constraints?.vertical === 'STRETCH' ||
      ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].some(key => node[key as keyof SourceNode] != null)))
      fail(node, 'constraints', 'Responsive image dimensions and limits require verified FIT/FILL aspect-ratio rendering');
    if (image && !approved && fill[0]?.scaleMode === 'CROP') {
      const matrix = fill[0].imageTransform;
      if (!Array.isArray(matrix) || matrix.length !== 2 || !matrix.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)))
        fail(node, 'fills.imageTransform', 'CROP requires a finite 2x3 image transform');
    } else if (image && !approved && fill[0]?.imageTransform)
      fail(node, 'fills.imageTransform', 'Only CROP may specify an image transform');
    if (node.type === 'TEXT' && (typeof node.fontSize !== 'number' || !Number.isFinite(node.fontSize) || node.fontSize <= 0 || typeof node.characters !== 'string' || !(typeof node.fontName === 'object' && node.fontName !== null && 'family' in node.fontName && 'style' in node.fontName && typeof node.fontName.family === 'string' && typeof node.fontName.style === 'string')))  {
      fail(node, 'text', 'Text requires uniform style and characters'); return;
    }
    if (node.type === 'FRAME' && !['NONE', 'HORIZONTAL', 'VERTICAL'].includes(node.layoutMode ?? 'NONE')) fail(node, 'layoutMode', 'Unsupported layout mode');
    const color = solid?.color && [solid.color.r, solid.color.g, solid.color.b].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
      ? `#${[solid.color.r, solid.color.g, solid.color.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : undefined;
    const output: DesignNode = {
      id: node.id, parentId, type: approved || image ? 'IMAGE' : nativeRectangle ? 'FRAME' : node.type as 'FRAME' | 'TEXT', name: node.name,
      x: approved ? node.x + render!.x - box!.x : node.x,
      y: approved ? node.y + render!.y - box!.y : node.y,
      width: approved ? render!.width : node.width,
      height: approved ? render!.height : node.height, visible: node.visible,
      ...(color && !approved ? { color } : {}),
      ...(node.type === 'FRAME' || nativeRectangle ? { layoutMode: node.layoutMode ?? 'NONE', clipsContent: node.clipsContent ?? false } : {}),
      ...(node.layoutSizingHorizontal === 'HUG' ? { horizontalSizing: 'HUG' as const } :
        node.layoutSizingHorizontal === 'FILL' || node.constraints?.horizontal === 'STRETCH' ||
        node.layoutAlign === 'STRETCH' && parent?.layoutMode === 'VERTICAL' ? { horizontalSizing: 'FILL' as const } : {}),
      ...(node.layoutSizingVertical === 'HUG' ? { verticalSizing: 'HUG' as const } :
        node.layoutSizingVertical === 'FILL' || node.constraints?.vertical === 'STRETCH' ||
        node.layoutAlign === 'STRETCH' && parent?.layoutMode === 'HORIZONTAL' ? { verticalSizing: 'FILL' as const } : {}),
      ...(node.layoutSizingHorizontal === 'FILL' || node.layoutAlign === 'STRETCH' && parent?.layoutMode === 'VERTICAL' ? { horizontalAnchor: 'STRETCH' as const } :
        ['MAX', 'CENTER', 'STRETCH'].includes(node.constraints?.horizontal ?? '') ? { horizontalAnchor: node.constraints!.horizontal as 'MAX' | 'CENTER' | 'STRETCH' } : {}),
      ...(node.layoutSizingVertical === 'FILL' || node.layoutAlign === 'STRETCH' && parent?.layoutMode === 'HORIZONTAL' ? { verticalAnchor: 'STRETCH' as const } :
        ['MAX', 'CENTER', 'STRETCH'].includes(node.constraints?.vertical ?? '') ? { verticalAnchor: node.constraints!.vertical as 'MAX' | 'CENTER' | 'STRETCH' } : {}),
      ...Object.fromEntries((['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).filter(key => node[key] != null).map(key => [key, node[key]])),
      ...(node.type === 'FRAME' && node.layoutMode !== 'NONE' ? {
        ...Object.fromEntries((['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'] as const)
          .filter(key => node[key] !== undefined && node[key] !== 0).map(key => [key, node[key]])),
        ...(node.counterAxisAlignItems && node.counterAxisAlignItems !== 'MIN' ? { counterAxisAlignItems: node.counterAxisAlignItems as 'CENTER' | 'MAX' } : {}),
      } : {}),
      ...(parent?.layoutMode && parent.layoutMode !== 'NONE' && node.layoutAlign && node.layoutAlign !== 'INHERIT' && node.layoutAlign !== 'STRETCH' ?
        { layoutAlign: node.layoutAlign as 'MIN' | 'CENTER' | 'MAX' } : {}),
      ...(rotated && Number.isFinite(node.rotation) ? { rotation: node.rotation } : {}),
      ...(node.type === 'TEXT' ? { characters: node.characters!, fontSize: node.fontSize as number, fontFamily: (node.fontName as { family: string }).family, fontStyle: (node.fontName as { style: string }).style } : {}),
      ...(approved ? { scaleMode: 'FIT', fallback: { feature, fingerprint } } : {}),
      ...(node.type === 'RECTANGLE' && !approved && fill[0]?.imageHash ? { scaleMode: fill[0].scaleMode,
        ...(fill[0].scaleMode === 'CROP' && Array.isArray(fill[0].imageTransform) ? { imageTransform: fill[0].imageTransform as readonly (readonly number[])[] } : {}) } : {}),
    };
    nodes.push(output);
    totalNodes++;
    if (approved) fallbackExports.push({ node: output, source: node, useAbsoluteBounds: raster.useAbsoluteBounds });
    else if (node.type === 'RECTANGLE' && fill[0]?.imageHash) pending.push({ node: output, sourceHash: fill[0].imageHash });
    // At the boundary, do not even touch the children getter. Block conservatively.
    if (depth >= bound.maxDepth || totalNodes >= bound.maxNodes) {
      fail(node, 'children', 'Capture stopped at depth/node budget'); return;
    }
    const children = node.children ?? [];
    observation.childCount = children.length;
    // Reject wide branches before reading any child IDs. Neither diagnostics nor freshness
    // may scale with a subtree that the capture budget cannot visit.
    if (children.length > bound.maxNodes - totalNodes) {
      fail(node, 'children', 'Capture stopped at node budget'); return;
    }
    observation.childIds = children.map(child => child.id);
    for (const child of children) visit(child, node.id, depth + 1, node,
      interactiveAncestor || !!node.reactions?.length, rotatedAncestor || !!node.rotation);
  }
  for (const root of selected) visit(root, null, 0);
  const screenNodes = nodes.splice(0);
  // Resolve only transitive definitions; never scan the entire Figma document.
  for (let index = 0; index < instances.length && index < bound.maxNodes; index++) {
    const item = instances[index];
    try {
      const source = await item.source.getMainComponentAsync?.();
      if (!source || source.type !== 'COMPONENT' || !source.id) {
        diagnostics.push({ code: 'UNRESOLVED_COMPONENT', severity: 'error', nodeId: item.node.id, property: 'mainComponent', message: 'Instance definition unavailable' });
        continue;
      }
      item.node.componentId = source.id;
      const mapping = componentMappings[source.id];
      if (mapping?.mode === 'reference' && (item.node.width !== source.width || item.node.height !== source.height))
        diagnostics.push({ code: 'INVALID_CONTROL_CONTRACT', severity: 'error', nodeId: item.node.id, property: 'bounds',
          message: 'Referenced control size must match its unstyled placeholder; resizing requires a verified target contract' });
      if (componentSources.has(source.id)) continue;
      if (!mapping || !/^[A-Za-z][A-Za-z0-9_]*$/.test(mapping.alias)) {
        diagnostics.push({ code: 'UNRESOLVED_COMPONENT', severity: 'error', nodeId: item.node.id, property: 'mapping', message: 'Map the component definition to a generated public alias' });
        continue;
      }
      componentSources.set(source.id, source);
      definitionObservations.push({ source, fingerprint: hash(propertySnapshot(source)), childIds: (source.children ?? []).map(child => child.id), graph: definitionGraph(source) });
      if (mapping.mode === 'reference') {
        // The registered component owns its visuals. This unstyled placeholder cannot
        // authorize modifying its children, paint, skins or behavior.
        if (hasUnsupportedComponentTransform(source.relativeTransform))
          fail(source, 'relativeTransform', 'Skew, scale and flip transforms are unsupported on referenced placeholders');
        if (mapping.controlId !== mapping.alias || source.width !== mapping.targetWidth || source.height !== mapping.targetHeight ||
          source.children?.length || (typeof source.fills === 'symbol' || !!source.fills?.length) || source.effects?.length || source.strokes?.length ||
          source.reactions?.length || source.rotation || source.opacity !== undefined && source.opacity !== 1 ||
          source.layoutMode !== 'NONE' || source.clipsContent || source.boundVariables && Object.keys(source.boundVariables).length) {
          fail(source, 'reference', 'Referenced control needs an unstyled placeholder and an exact registered target contract');
          continue;
        }
        if (![source.width, source.height].every(value => Number.isFinite(value) && value > 0)) {
          fail(source, 'bounds', 'Referenced control placeholder dimensions must be finite and positive');
          continue;
        }
        components.push({ id: source.id, alias: mapping.alias, mode: 'reference', controlId: mapping.controlId,
          width: source.width, height: source.height });
        continue;
      }
      visit({ ...source, type: 'FRAME' }, null, 0);
      components.push({ id: source.id, alias: mapping.alias, mode: 'generate', nodes: nodes.splice(0) });
    } catch {
      diagnostics.push({ code: 'UNRESOLVED_COMPONENT', severity: 'error', nodeId: item.node.id, property: 'mainComponent', message: 'Cannot resolve instance definition' });
    }
  }
  nodes.push(...screenNodes);
  for (const item of instances) {
    try {
      const current = await item.source.getMainComponentAsync?.();
      const captured = definitionObservations.find(entry => entry.source.id === item.node.componentId);
      if (!current || current.id !== item.node.componentId || !captured ||
          hash(propertySnapshot(current)) !== captured.fingerprint ||
          definitionGraph(current) !== captured.graph)
        diagnostics.push({ code: 'SOURCE_CHANGED_DURING_CAPTURE', severity: 'error', nodeId: item.node.id, property: 'mainComponent', message: 'Instance definition changed during capture' });
    } catch {
      diagnostics.push({ code: 'SOURCE_CHANGED_DURING_CAPTURE', severity: 'error', nodeId: item.node.id, property: 'mainComponent', message: 'Instance definition unavailable after capture' });
    }
  }
  if (totalNodes > bound.maxNodes || instances.length > bound.maxNodes) diagnostics.push({ code: 'UNSUPPORTED_FEATURE', severity: 'error', nodeId: '', property: 'components', message: 'Component dependency budget exceeded' });
  for (const item of fallbackExports) {
    try {
      if (!item.source.exportAsync) throw new Error('Figma PNG export unavailable');
      const bytes = await item.source.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 },
        ...(item.useAbsoluteBounds ? { useAbsoluteBounds: true, contentsOnly: true } : {}) });
      if (bytes.length < 24 || bytes.length > bound.maxAssetBytes ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
        new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) !== item.node.width ||
        new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) !== item.node.height)
        throw new Error('Fallback PNG does not match bounded render geometry');
      item.node.imageHash = hashBytes(bytes);
      if (!assets.some(asset => asset.hash === item.node.imageHash)) assets.push({ hash: item.node.imageHash, bytes });
    } catch (error) { diagnostics.push({ code: 'UNRESOLVED_ASSET', severity: 'error', nodeId: item.node.id,
      property: item.node.fallback!.feature, message: `Decorative PNG export failed: ${error instanceof Error ? error.message : 'unknown error'}` }); }
  }
  for (const item of pending) {
    const image = images.getImageByHash(item.sourceHash);
    if (!image) { diagnostics.push({ code: 'UNRESOLVED_ASSET', severity: 'error', nodeId: item.node.id, property: 'fills', message: 'Image bytes are unavailable' }); continue; }
    const bytes = await image.getBytesAsync();
    if (bytes.length > bound.maxAssetBytes) { diagnostics.push({ code: 'UNSUPPORTED_FEATURE', severity: 'error', nodeId: item.node.id, property: 'fills', message: 'Asset byte budget exceeded' }); continue; }
    item.node.imageHash = hashBytes(bytes);
    if (!assets.some(asset => asset.hash === item.node.imageHash)) assets.push({ hash: item.node.imageHash, bytes });
  }
  if (definitionObservations.some(entry => hash(propertySnapshot(entry.source)) !== entry.fingerprint ||
      definitionGraph(entry.source) !== entry.graph))
    diagnostics.push({ code: 'SOURCE_CHANGED_DURING_CAPTURE', severity: 'error', nodeId: selected[0]?.id ?? '', property: 'definition', message: 'Component definition changed during capture' });
  if (observed.some(entry => hash(propertySnapshot(entry.node)) !== entry.fingerprint ||
      entry.childCount !== undefined && ((entry.node.children ?? []).length !== entry.childCount ||
        entry.childIds !== undefined && canonicalize((entry.node.children ?? []).map(child => child.id)) !== canonicalize(entry.childIds)))) {
    diagnostics.push({ code: 'SOURCE_CHANGED_DURING_CAPTURE', severity: 'error', nodeId: selected[0]?.id ?? '', property: 'selection', message: 'Selected source changed during capture' });
  }
  if (diagnostics.length) return { snapshot: null, assets: [], diagnostics };
  const selectedRootIds = selected.map(root => root.id);
  const rootAliases = roots.roots.filter(root => root.alias).sort((a, b) => a.id.localeCompare(b.id)).map(root => ({ rootId: root.id, alias: root.alias! }));
  const semantic = { documentNamespace, selectedRootIds, rootAliases, nodes,
    ...(components.length ? { components: components.sort((a, b) => a.id.localeCompare(b.id)) } : {}),
    ...(rootMappings.length ? { rootMappings: [...rootMappings].sort((a, b) => a.rootId.localeCompare(b.rootId)) } : {}) };
  const layout = nodes.some(node => node.layoutMode !== undefined && node.layoutMode !== 'NONE' ||
    node.horizontalSizing === 'HUG' || node.verticalSizing === 'HUG' ||
    ['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'counterAxisAlignItems', 'layoutAlign'].some(key => key in node));
  const geometry = nodes.some(node => node.clipsContent || node.rotation !== undefined || node.scaleMode === 'CROP' || node.fallback);
  const responsive = nodes.some(node => ['horizontalSizing' , 'verticalSizing', 'horizontalAnchor', 'verticalAnchor', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'].some(key => key in node));
  const shapeFallback = [...nodes, ...components.flatMap(component => component.mode === 'generate' ? component.nodes : [])].some(node => node.fallback?.feature === 'decorative-shape');
  return { snapshot: { schemaVersion: { major: 1, minor: shapeFallback ? 6 : components.length ? 5 : rootMappings.length ? 4 : geometry ? 3 : layout ? 2 : responsive ? 1 : 0 }, snapshotId: hash(semantic), ...semantic }, assets, diagnostics };
}
