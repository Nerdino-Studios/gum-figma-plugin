import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readSelectedRoots } from '../src/document/selection.ts';
import { captureSelection, canonicalize, hashBytes } from '../src/document/extraction.ts';
import { encodeUtf8 } from '../src/document/utf8.ts';
import { validateContract } from '../src/transport/contracts.ts';

const frame = (id, name, children = []) => ({ id, name, type: 'FRAME', x: 0, y: -0, width: 120, height: 50, visible: true, layoutMode: 'NONE', clipsContent: false, children, fills: [] });
const text = (id) => ({ id, name: 'Label', type: 'TEXT', x: 2, y: 3, width: 30, height: 12, visible: true, characters: 'Hello', fontSize: 12, fontName: { family: 'Inter', style: 'Regular' }, fills: [] });

test('scene UTF-8 matches TextEncoder for ASCII, Unicode and malformed UTF-16', () => {
  for (const input of ['', 'ASCII', 'Café 😀', '\0\u007f\u0080\u07ff\u0800\uffff', '\ud800', '\udc00', '\ud800A\udc00', '\ud800\udc00', '\udbff\udfff', '\ud800\ud800\udc00']) {
    assert.deepEqual(encodeUtf8(input), new TextEncoder().encode(input), JSON.stringify(input));
  }
  assert.equal(hashBytes(encodeUtf8('"ASCII"')), 'sha256:8d8086de6994d1bb23d5e440929193b78719ce686c6e88247877f8411c51905d');
  assert.equal(hashBytes(encodeUtf8('"Café 😀"')), 'sha256:1c8e1a60f5bbeb857465f51d2fc1464c4f1a101f7f05b43357fd86651df19ce3');
  const original = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = undefined;
    assert.deepEqual(encodeUtf8('\ud800\udc00\ud800A\udc00'), Uint8Array.from([0xf0, 0x90, 0x80, 0x80, 0xef, 0xbf, 0xbd, 0x41, 0xef, 0xbf, 0xbd]));
  } finally { globalThis.TextEncoder = original; }
});

test('scene hash retains published JS/C# Unicode wire vector', () => {
  // PublicationTests.JavascriptUnicodeAndNumberVectorAndSequentialTransfers validates this ID in C#.
  const semantic = { documentNamespace: 'design-1', selectedRootIds: ['1:2'], rootAliases: [{ rootId: '1:2', alias: 'Main' }],
    nodes: [{ id: '1:2', parentId: null, type: 'FRAME', name: '😀', x: 1e-7, y: 1e-6, width: 100, height: 100, visible: true, layoutMode: 'NONE', clipsContent: false }] };
  assert.equal(hashBytes(encodeUtf8(canonicalize(semantic))), 'sha256:4f727b77f8b0ec2756d1b9378e0bcd9e9010d5a8be841f53412e7ed6fdf4cba5');
});

test('scene capture without TextEncoder retains canonical JS/C# snapshot identity', async () => {
  const api = { getImageByHash: () => null };
  const cases = [frame('1:2', 'ASCII'), frame('1:2', '😀'), frame('1:2', 'Café \ud800 end', [text('1:3')])];
  const expected = await Promise.all(cases.map(root => captureSelection([root], 'design-1', api, {}, { '1:2': 'Main' })));
  const original = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = undefined;
    for (const [index, root] of cases.entries()) {
      const result = await captureSelection([root], 'design-1', api, {}, { '1:2': 'Main' });
      assert.deepEqual(result.diagnostics, []);
      assert.ok(result.snapshot);
      assert.equal(validateContract('snapshot', result.snapshot), true);
      assert.equal(result.snapshot.snapshotId, expected[index].snapshot.snapshotId);
      const { snapshotId, schemaVersion, ...semantic } = result.snapshot;
      assert.equal(snapshotId, 'sha256:' + createHash('sha256').update(canonicalize(semantic), 'utf8').digest('hex'));
    }
  } finally {
    globalThis.TextEncoder = original;
  }
});

test('selection retains identity, detects unsupported roots and ignores display name for alias', () => {
  const selected = [frame('1:2', 'Renamed'), { id: '3:4', name: 'Oval', type: 'ELLIPSE' }];
  const result = readSelectedRoots(selected, { '1:2': 'StartScreen' });
  assert.deepEqual(result.roots.map(root => [root.id, root.alias]), [['1:2', 'StartScreen']]);
  assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_FEATURE');
  selected[0].name = 'New display name';
  assert.equal(readSelectedRoots(selected, { '1:2': 'StartScreen' }).roots[0].alias, 'StartScreen');
});

test('capture bounded subtree, image bytes and semantic hash independent of selection order and display property order', async () => {
  const image = { id: '5', type: 'RECTANGLE', name: 'Image', x: 0, y: 0, width: 10, height: 10, visible: true, fills: [{ type: 'IMAGE', imageHash: 'figma-hash', scaleMode: 'FIT' }] };
  const a = frame('a', 'A', [text('t'), image]);
  const b = frame('b', 'B');
  const api = { getImageByHash: hash => hash === 'figma-hash' ? { getBytesAsync: async () => new Uint8Array([1, 2, 3]) } : null };
  const first = await captureSelection([b, a], 'design-1', api);
  const second = await captureSelection([a, b], 'design-1', api);
  assert.equal(first.snapshot.snapshotId, second.snapshot.snapshotId);
  assert.equal(hashBytes(new Uint8Array()), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(first.snapshot.nodes.length, 4);
  assert.equal(validateContract('snapshot', first.snapshot), true);
  assert.equal(first.assets.length, 1);
  assert.match(first.assets[0].hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.snapshot.nodes.find(n => n.id === 't').characters, 'Hello');
  assert.equal(first.snapshot.nodes.find(n => n.id === '5').imageHash, first.assets[0].hash);
  assert.equal(first.snapshot.nodes.find(n => n.id === 'a').height, 50);
  const renamed = await captureSelection([{ ...a, name: 'New label' }, b], 'design-1', api);
  assert.notEqual(first.snapshot.snapshotId, renamed.snapshot.snapshotId);
  const colored = frame('colored', 'Panel', [text('label')]);
  colored.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  colored.children[0].fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }];
  const colors = await captureSelection([colored], 'design-1', api);
  assert.equal(colors.snapshot.nodes[0].color, '#ff0000');
  assert.equal(colors.snapshot.nodes[1].color, '#0000ff');
  assert.equal(validateContract('snapshot', colors.snapshot), true);
});

test('captures clipping, axis-aligned crop and leaf rotation; diagnoses skew and interactive rotation', async () => {
  const api = { getImageByHash: () => ({ getBytesAsync: async () => new Uint8Array([1, 2, 3]) }) };
  const img = { id: 'img', name: 'Crop', type: 'RECTANGLE', x: 0, y: 0, width: 40, height: 20, visible: true,
    rotation: 15, relativeTransform: [[Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), 0], [-Math.sin(Math.PI / 12), Math.cos(Math.PI / 12), 0]],
    fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 0.25, 0.25]] }] };
  const root = frame('root', 'Root', [frame('box', 'Box', [img])]);
  root.children[0].clipsContent = true;
  const result = await captureSelection([root], 'ns', api);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.schemaVersion.minor, 3);
  assert.equal(result.snapshot.nodes[1].clipsContent, true);
  assert.equal(result.snapshot.nodes[2].rotation, 15);
  assert.deepEqual(result.snapshot.nodes[2].imageTransform, img.fills[0].imageTransform);
  assert.equal(validateContract('snapshot', result.snapshot), true);
  const skewed = { ...img, relativeTransform: [[1, 0.2, 0], [0, 1, 0]] };
  assert.ok((await captureSelection([frame('root', 'Root', [skewed])], 'ns', api)).diagnostics.some(d => d.property === 'relativeTransform'));
  const interactive = { ...root.children[0], rotation: 15 };
  assert.ok((await captureSelection([frame('root', 'Root', [interactive])], 'ns', api)).diagnostics.some(d => d.property === 'rotation'));
});

test('capture rejects excess depth, unsupported properties, missing assets and changed sources', async () => {
  const api = { getImageByHash: () => null };
  assert.ok((await captureSelection([frame('a', 'A', [frame('b', 'B')])], 'ns', api, { maxDepth: 0 })).diagnostics.some(d => d.code === 'UNSUPPORTED_FEATURE'));
  assert.ok((await captureSelection([frame('a', 'A', [{ ...text('t'), fontName: figmaMixed }])], 'ns', api)).diagnostics.some(d => d.code === 'UNSUPPORTED_FEATURE'));
  assert.equal((await captureSelection([{ ...frame('a', 'A'), paddingLeft: 8 }], 'ns', api)).snapshot, null);
  assert.equal((await captureSelection([{ ...frame('a', 'A'), fills: [{ type: 'GRADIENT_LINEAR' }] }], 'ns', api)).snapshot, null);
  assert.ok((await captureSelection([frame('a', 'A', [{ id: 'i', type: 'RECTANGLE', name: 'I', x: 0, y: 0, width: 1, height: 1, visible: true, fills: [{ type: 'IMAGE', imageHash: 'missing', scaleMode: 'FIT' }] }])], 'ns', api)).diagnostics.some(d => d.code === 'UNRESOLVED_ASSET'));
  assert.throws(() => canonicalize({ value: Infinity }), /finite/i);
  assert.equal(canonicalize({ a: -0, b: 1 }), canonicalize({ b: 1, a: 0 }));
  const changed = frame('changing', 'Before', [{ id: 'img', type: 'RECTANGLE', name: 'Image', x: 0, y: 0, width: 1, height: 1, visible: true, fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FIT' }] }]);
  const result = await captureSelection([changed], 'ns', { getImageByHash: () => ({ getBytesAsync: async () => { changed.name = 'After'; return new Uint8Array([1]); } }) });
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
  assert.equal((await captureSelection([frame('a', 'A', [text('t')])], 'ns', api, { maxNodes: 1 })).snapshot, null);
});
const figmaMixed = Symbol('mixed');

test('realistic plain Inter Regular text defaults capture without losing supported meaning', async () => {
  const api = { getImageByHash: () => null };
  const label = { ...text('t'), fontWeight: 400, lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PIXELS', value: 0 }, maxLines: null };
  const result = await captureSelection([frame('root', 'Root', [label])], 'ns', api);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.nodes[1].characters, 'Hello');
  assert.equal(validateContract('snapshot', result.snapshot), true);
  for (const [property, value] of [
    ['fontWeight', 700], ['lineHeight', { unit: 'PIXELS', value: 18 }],
    ['letterSpacing', { unit: 'PIXELS', value: 2 }], ['maxLines', 2],
  ]) {
    const unsupported = await captureSelection([frame('root', 'Root', [{ ...label, [property]: value }])], 'ns', api);
    assert.equal(unsupported.snapshot, null, property);
    assert.ok(unsupported.diagnostics.some(d => d.property === property), property);
  }
});

test('sizing constraints and min/max must not silently produce the same successful snapshot', async () => {
  const api = { getImageByHash: () => null };
  const baseline = await captureSelection([frame('root', 'Root')], 'ns', api);
  assert.ok(baseline.snapshot);
  const defaults = await captureSelection([{ ...frame('root', 'Root'), constraints: { horizontal: 'MIN', vertical: 'MIN' },
    minWidth: null, maxWidth: null, minHeight: null, maxHeight: null }], 'ns', api);
  assert.equal(defaults.snapshot.snapshotId, baseline.snapshot.snapshotId);
  for (const [property, value] of [
    ['constraints', { horizontal: 'SCALE', vertical: 'STRETCH' }],
    ['minWidth', 200], ['maxWidth', 300], ['minHeight', 20], ['maxHeight', 80],
  ]) {
    const result = await captureSelection([{ ...frame('root', 'Root'), [property]: value }], 'ns', api);
    assert.equal(result.snapshot, null, property);
    assert.ok(result.diagnostics.some(d => d.property === property), property);
  }
});

test('child fixed/fill anchors and limits retain semantics and reject incompatible combinations', async () => {
  const api = { getImageByHash: () => null };
  const child = { ...frame('panel', 'Panel'), x: 10, y: 20, width: 200, height: 100,
    layoutSizingHorizontal: 'FIXED', constraints: { horizontal: 'STRETCH', vertical: 'MAX' }, minWidth: 150, maxWidth: 900 };
  const result = await captureSelection([frame('root', 'Root', [child])], 'ns', api);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(validateContract('snapshot', result.snapshot), true);
  assert.equal(result.snapshot.schemaVersion.minor, 1);
  assert.equal(validateContract('snapshot', { ...result.snapshot, schemaVersion: { major: 1, minor: 0 } }), false);
  assert.equal(result.snapshot.nodes[1].horizontalSizing, 'FILL');
  assert.equal(result.snapshot.nodes[1].horizontalAnchor, 'STRETCH');
  assert.equal(result.snapshot.nodes[1].verticalAnchor, 'MAX');
  assert.equal(result.snapshot.nodes[1].maxWidth, 900);
  const altered = await captureSelection([frame('root', 'Root', [{ ...child, maxWidth: 800 }])], 'ns', api);
  assert.notEqual(result.snapshot.snapshotId, altered.snapshot.snapshotId);
  for (const variant of [{ ...child, layoutSizingHorizontal: 'FILL' }, { ...child, minWidth: 1000 }, { ...child, layoutSizingHorizontal: 'HUG' }]) {
    const invalid = await captureSelection([frame('root', 'Root', [variant])], 'ns', api);
    assert.equal(invalid.snapshot, null);
    assert.ok(invalid.diagnostics.some(d => /sizing|limit|minimum|FILL/i.test(d.message)));
  }
});

test('nested auto layout captures spacing, asymmetric padding, alignment and hug in v1.2', async () => {
  const api = { getImageByHash: () => null };
  const inner = { ...frame('inner', 'Inner', [frame('leaf', 'Leaf')]), layoutMode: 'VERTICAL',
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', paddingLeft: 3, paddingRight: 9,
    paddingTop: 4, paddingBottom: 8, itemSpacing: 5, layoutAlign: 'MAX' };
  const outer = { ...frame('outer', 'Outer', [inner]), layoutMode: 'HORIZONTAL', itemSpacing: 7,
    paddingLeft: 11, paddingRight: 19, paddingTop: 13, paddingBottom: 17, counterAxisAlignItems: 'CENTER' };
  const result = await captureSelection([frame('root', 'Root', [outer])], 'ns', api);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(validateContract('snapshot', result.snapshot), true);
  assert.equal(result.snapshot.schemaVersion.minor, 2);
  assert.equal(validateContract('snapshot', { ...result.snapshot, schemaVersion: { major: 1, minor: 1 } }), false);
  assert.equal(result.snapshot.nodes[1].paddingRight, 19);
  assert.equal(result.snapshot.nodes[2].horizontalSizing, 'HUG');
  assert.equal(result.snapshot.nodes[2].layoutAlign, 'MAX');
  const changed = await captureSelection([frame('root', 'Root', [{ ...outer, paddingRight: 20 }])], 'ns', api);
  assert.notEqual(result.snapshot.snapshotId, changed.snapshot.snapshotId);
  const invalid = await captureSelection([frame('root', 'Root', [{ ...outer, paddingLeft: -1 }])], 'ns', api);
  assert.equal(invalid.snapshot, null);
  assert.ok(invalid.diagnostics.some(d => d.property === 'paddingLeft'));
});

test('ordinary Figma layout defaults do not block a plain frame', async () => {
  const defaults = { ...frame('root', 'Root'), itemSpacing: 0, paddingLeft: 0, paddingRight: 0,
    paddingTop: 0, paddingBottom: 0, layoutAlign: 'INHERIT', primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN', layoutWrap: 'NO_WRAP' };
  const result = await captureSelection([defaults], 'ns', { getImageByHash: () => null });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.schemaVersion.minor, 0);
});

test('cross-axis STRETCH lowers as fill; unsupported main-axis distribution and wrapping block', async () => {
  const api = { getImageByHash: () => null };
  const child = { ...frame('child', 'Child'), layoutSizingHorizontal: 'FILL', layoutAlign: 'STRETCH' };
  const stack = { ...frame('stack', 'Stack', [child]), layoutMode: 'VERTICAL' };
  const result = await captureSelection([frame('root', 'Root', [stack])], 'ns', api);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.nodes[2].horizontalSizing, 'FILL');
  assert.equal(result.snapshot.nodes[2].horizontalAnchor, 'STRETCH');
  for (const field of [{ primaryAxisAlignItems: 'MAX' }, { layoutWrap: 'WRAP' }]) {
    const invalid = await captureSelection([frame('root', 'Root', [{ ...stack, ...field }])], 'ns', api);
    assert.equal(invalid.snapshot, null);
    assert.ok(invalid.diagnostics.some(d => d.property in field));
  }
});

test('absolute-positioned children cannot silently enter stack flow or share the AUTO hash', async () => {
  const api = { getImageByHash: () => null };
  const child = { ...frame('child', 'Child'), x: 77, y: 23, layoutPositioning: 'AUTO' };
  const parent = { ...frame('stack', 'Stack', [child]), layoutMode: 'HORIZONTAL' };
  const supported = await captureSelection([frame('root', 'Root', [parent])], 'ns', api);
  assert.ok(supported.snapshot);
  const absolute = await captureSelection([frame('root', 'Root', [{ ...parent,
    children: [{ ...child, layoutPositioning: 'ABSOLUTE' }] }])], 'ns', api);
  assert.equal(absolute.snapshot, null);
  assert.ok(absolute.diagnostics.some(d => d.nodeId === 'child' && d.property === 'layoutPositioning'));
});

test('budget never reads descendants beyond bounded depth or node count', async () => {
  const root = frame('root', 'Root');
  Object.defineProperty(root, 'children', { get() { throw Error('read outside depth budget'); } });
  const api = { getImageByHash: () => null };
  const depth = await captureSelection([root], 'ns', api, { maxDepth: 0 });
  assert.equal(depth.snapshot, null);
  assert.ok(depth.diagnostics.some(d => d.property === 'children'));
  const count = await captureSelection([root], 'ns', api, { maxNodes: 1 });
  assert.equal(count.snapshot, null);
  assert.ok(count.diagnostics.some(d => d.property === 'children'));
});

test('unsupported node, text, and paint semantics report property diagnostics', async () => {
  const api = { getImageByHash: () => ({ getBytesAsync: async () => new Uint8Array([1]) }) };
  for (const [node, property] of [
    [{ ...frame('a', 'A'), cornerRadius: 12 }, 'cornerRadius'],
    [{ ...frame('a', 'A'), isMask: true }, 'isMask'],
    [{ ...frame('a', 'A'), blendMode: 'MULTIPLY' }, 'blendMode'],
    [frame('a', 'A', [{ ...text('t'), fills: figmaMixed }]), 'fills'],
    [frame('a', 'A', [{ ...text('t'), textAlignHorizontal: 'CENTER' }]), 'textAlignHorizontal'],
    [frame('a', 'A', [{ id: 'i', name: 'I', type: 'RECTANGLE', x: 0, y: 0, width: 5, height: 5, visible: true, fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FIT', opacity: 0.2, visible: false }] }]), 'fills'],
  ]) {
    const result = await captureSelection([node], 'ns', api);
    assert.equal(result.snapshot, null, property);
    assert.ok(result.diagnostics.some(d => d.property === property), property);
  }
});

test('image paint rotation and filters reject non-default appearance and detect asynchronous changes', async () => {
  const image = { id: 'i', name: 'Image', type: 'RECTANGLE', x: 0, y: 0, width: 5, height: 5, visible: true,
    fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FIT', rotation: 0, filters: { exposure: 0, contrast: 0 } }] };
  const api = { getImageByHash: () => ({ getBytesAsync: async () => new Uint8Array([1]) }) };
  const baseline = await captureSelection([frame('root', 'Root', [image])], 'ns', api);
  assert.ok(baseline.snapshot);
  for (const [property, paint] of [
    ['fills.rotation', { ...image.fills[0], rotation: 90 }],
    ['fills.filters', { ...image.fills[0], filters: { exposure: 1 } }],
  ]) {
    const result = await captureSelection([frame('root', 'Root', [{ ...image, fills: [paint] }])], 'ns', api);
    assert.equal(result.snapshot, null, property);
    assert.ok(result.diagnostics.some(d => d.property === property), property);
  }
  const changed = await captureSelection([frame('root', 'Root', [image])], 'ns', {
    getImageByHash: () => ({ getBytesAsync: async () => { image.fills[0].filters.exposure = 1; return new Uint8Array([1]); } }),
  });
  assert.equal(changed.snapshot, null);
  assert.ok(changed.diagnostics.some(d => d.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
});

test('wide sibling budget bounds ID reads and emits one budget diagnostic', async () => {
  let reads = 0;
  const children = Array.from({ length: 1000 }, (_, i) => {
    const child = text(`t${i}`);
    Object.defineProperty(child, 'id', { get() { reads++; return `t${i}`; } });
    return child;
  });
  const result = await captureSelection([frame('root', 'Root', children)], 'ns',
    { getImageByHash: () => null }, { maxNodes: 2 });
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.property === 'children'));
  assert.ok(result.diagnostics.length <= 2, `diagnostic count ${result.diagnostics.length}`);
  assert.ok(reads <= 8, `child ID reads ${reads}`);
});

test('oversized selected-root budget rejects before reading root properties or emitting per-root diagnostics', async () => {
  let reads = 0;
  const selection = Array.from({ length: 1000 }, (_, i) => {
    const root = frame(`r${i}`, `Root ${i}`);
    for (const property of ['id', 'name', 'type']) {
      Object.defineProperty(root, property, { get() { reads++; return property === 'id' ? `r${i}` : property === 'name' ? `Root ${i}` : 'FRAME'; } });
    }
    return root;
  });
  const result = await captureSelection(selection, 'ns', { getImageByHash: () => null }, { maxNodes: 2 });
  assert.equal(result.snapshot, null);
  assert.deepEqual(result.assets, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].property, 'selection');
  assert.equal(reads, 0, `selected root property reads ${reads}`);
});

test('public alias changes hash without deriving alias from display name', async () => {
  const api = { getImageByHash: () => null };
  const original = await captureSelection([frame('a', 'Old')], 'ns', api, {}, { a: 'Before' });
  const renamed = await captureSelection([frame('a', 'New')], 'ns', api, {}, { a: 'Before' });
  const changed = await captureSelection([frame('a', 'Old')], 'ns', api, {}, { a: 'After' });
  assert.deepEqual(original.snapshot.rootAliases, [{ rootId: 'a', alias: 'Before' }]);
  assert.deepEqual(renamed.snapshot.rootAliases, original.snapshot.rootAliases);
  assert.notEqual(original.snapshot.snapshotId, changed.snapshot.snapshotId);
  assert.equal(validateContract('snapshot', changed.snapshot), true);
});

test('plain frame stretch constraints lower to fill without pretending auto-layout FILL is supported', async () => {
  const api = { getImageByHash: () => null };
  const child = { ...frame('child', 'Child'), constraints: { horizontal: 'STRETCH', vertical: 'MAX' }, layoutSizingHorizontal: 'FIXED', minWidth: 40, maxWidth: 180 };
  const result = await captureSelection([frame('root', 'Root', [child])], 'ns', api);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.nodes[1].horizontalSizing, 'FILL');
  assert.equal(result.snapshot.nodes[1].horizontalAnchor, 'STRETCH');
  assert.equal(result.snapshot.nodes[1].maxWidth, 180);
  const invalid = await captureSelection([frame('root', 'Root', [{ ...child, layoutSizingHorizontal: 'FILL' }])], 'ns', api);
  assert.equal(invalid.snapshot, null);
  assert.ok(invalid.diagnostics.some(d => d.property === 'layoutSizingHorizontal'));
});

test('responsive raster image blocks before a stretching Sprite can distort FIT/FILL', async () => {
  const api = { getImageByHash: () => ({ getBytesAsync: async () => new Uint8Array([1]) }) };
  const image = { id: 'image', name: 'Image', type: 'RECTANGLE', x: 0, y: 0, width: 64, height: 64, visible: true,
    fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FIT' }] };
  for (const change of [{ constraints: { horizontal: 'STRETCH', vertical: 'MIN' } }, { maxWidth: 500 }, { minHeight: 20 }]) {
    const result = await captureSelection([frame('root', 'Root', [{ ...image, ...change }])], 'ns', api);
    assert.equal(result.snapshot, null);
    assert.ok(result.diagnostics.some(d => d.nodeId === 'image' && /aspect-ratio/.test(d.message)));
  }
});


test('decorative fallback needs exact node/feature approval and cannot rasterize text or containers', async () => {
  const decoration = { id: 'deco', name: 'Deco', type: 'RECTANGLE', x: 0, y: 0, width: 1, height: 1, visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], effects: [{ type: 'DROP_SHADOW', radius: 4 }],
    absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, absoluteRenderBounds: { x: 0, y: 0, width: 1, height: 1 },
    exportAsync: async () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64')) };
  const root = frame('root', 'Root', [decoration]);
  root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 };
  const api = { getImageByHash: () => null };
  const blocked = await captureSelection([root], 'ns', api, {}, { root: 'Main' });
  assert.equal(blocked.snapshot, null);
  const diagnostic = blocked.diagnostics.find(d => d.nodeId === 'deco' && d.fingerprint);
  assert.ok(diagnostic);
  const approved = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, [{ nodeId: 'deco', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }]);
  assert.deepEqual(approved.diagnostics, []);
  assert.equal(approved.snapshot.nodes[1].type, 'IMAGE');
  assert.equal(approved.snapshot.nodes[1].fallback.feature, diagnostic.property);
  assert.equal(approved.snapshot.nodes[1].imageHash, approved.assets[0].hash);
  assert.equal(validateContract('snapshot', approved.snapshot), true);
  decoration.effects[0].radius = 5;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, [{ nodeId: 'deco', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }])).snapshot, null);
  const label = text('label'); label.effects = [{ type: 'DROP_SHADOW' }];
  assert.equal((await captureSelection([frame('root', 'Root', [label])], 'ns', api, {}, { root: 'Main' }, [{ nodeId: 'label', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }])).snapshot, null);
});

test('fallback approval expires on stroke changes and never accepts interactive ancestry', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64'));
  const decoration = { id: 'deco', name: 'Decoration', type: 'RECTANGLE', x: 0, y: 0, width: 1, height: 1, visible: true,
    fills: [], strokes: [{ type: 'SOLID' }], strokeWeight: 1, absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
    absoluteRenderBounds: { x: 0, y: 0, width: 1, height: 1 }, exportAsync: async () => png };
  const root = frame('root', 'Root', [decoration]);
  root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 };
  const api = { getImageByHash: () => null };
  const first = await captureSelection([root], 'ns', api, {}, { root: 'Main' });
  const d = first.diagnostics.find(item => item.nodeId === 'deco' && item.fingerprint);
  assert.ok(d);
  const approval = [{ nodeId: 'deco', feature: d.property, fingerprint: d.fingerprint }];
  assert.ok((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot);
  decoration.strokeWeight = 20;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
  decoration.strokeWeight = 1;
  decoration.strokeJoin = 'MITER';
  const joinApproval = (await captureSelection([root], 'ns', api, {}, { root: 'Main' })).diagnostics.find(item => item.nodeId === 'deco').fingerprint;
  decoration.strokeJoin = 'ROUND';
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, [{ nodeId: 'deco', feature: 'effects/strokes', fingerprint: joinApproval }])).snapshot, null);
  delete decoration.strokeJoin;
  decoration.reactions = [{ trigger: { type: 'ON_CLICK' }, action: { type: 'URL' } }];
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
  delete decoration.reactions;
  root.reactions = [{ trigger: { type: 'ON_CLICK' } }];
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
});

test('gradient fallback approval expires on stop/transform edits and mid-export changes', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  const gradient = { type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }],
    gradientTransform: [[1, 0, 0], [0, 1, 0]] };
  const leaf = { id: 'deco', name: 'Gradient', type: 'RECTANGLE', x: 0, y: 0, width: 1, height: 1, visible: true,
    fills: [gradient], effects: [{ type: 'DROP_SHADOW' }], absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
    absoluteRenderBounds: { x: 0, y: 0, width: 1, height: 1 }, exportAsync: async () => png };
  const root = frame('root', 'Root', [leaf]); root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 };
  const api = { getImageByHash: () => null };
  const diagnostic = (await captureSelection([root], 'ns', api, {}, { root: 'Main' })).diagnostics.find(d => d.nodeId === 'deco');
  const approval = [{ nodeId: 'deco', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }];
  assert.ok((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot);
  gradient.gradientStops[0].color.b = 1;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
  gradient.gradientStops[0].color.b = 0;
  gradient.gradientTransform[0][2] = 0.2;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
  gradient.gradientTransform[0][2] = 0;
  leaf.exportAsync = async () => { gradient.gradientStops[0].color.b = 1; return png; };
  const changed = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval);
  assert.equal(changed.snapshot, null);
  assert.ok(changed.diagnostics.some(d => d.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
});

test('fallback captures exact unrotated raster bounds or blocks unknown geometry', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAD0lEQVR4nGP4z8DwHxkDAEPNB/lfEPxcAAAAAElFTkSuQmCC', 'base64'));
  const leaf = { id: 'deco', name: 'Shadow', type: 'RECTANGLE', x: 10, y: 20, width: 1, height: 1, visible: true,
    fills: [], effects: [{ type: 'DROP_SHADOW' }], absoluteBoundingBox: { x: 10, y: 20, width: 1, height: 1 },
    absoluteRenderBounds: { x: 9, y: 20, width: 4, height: 1 }, exportAsync: async () => png };
  const root = frame('root', 'Root', [leaf]); root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 }; const api = { getImageByHash: () => null };
  const blocked = await captureSelection([root], 'ns', api, {}, { root: 'Main' });
  const d = blocked.diagnostics.find(item => item.nodeId === 'deco' && item.fingerprint);
  const approved = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, [{ nodeId: 'deco', feature: d.property, fingerprint: d.fingerprint }]);
  assert.ok(approved.snapshot);
  assert.equal(approved.snapshot.nodes[1].x, 9); assert.equal(approved.snapshot.nodes[1].width, 4);
  leaf.rotation = 15;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' })).snapshot, null);
  leaf.rotation = 0;
  delete leaf.absoluteRenderBounds;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' })).snapshot, null);
});

test('solid rectangles capture as native leaf frames with color and responsive bounds', async () => {
  const rectangle = { id: 'rect', name: 'Panel', type: 'RECTANGLE', x: 4, y: 5, width: 40, height: 20, visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 } }],
    constraints: { horizontal: 'STRETCH', vertical: 'MIN' }, minWidth: 10 };
  const result = await captureSelection([frame('root', 'Screen', [rectangle])], 'ns', { getImageByHash: () => null }, {}, { root: 'Main' });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.nodes[1].type, 'FRAME');
  assert.equal(result.snapshot.nodes[1].color, '#ff8000');
  assert.equal(result.snapshot.nodes[1].layoutMode, 'NONE');
  assert.equal(result.snapshot.nodes[1].clipsContent, false);
  assert.equal(result.snapshot.nodes[1].horizontalSizing, 'FILL');
  assert.equal(result.snapshot.nodes[1].minWidth, 10);
  assert.equal(validateContract('snapshot', result.snapshot), true);
  assert.deepEqual(result.assets, []);
  rectangle.fills = [];
  assert.ok((await captureSelection([frame('root', 'Screen', [rectangle])], 'ns', { getImageByHash: () => null })).snapshot);
});

test('decorative polygons require scoped PNG approval that expires on point-count edits', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  let exports = 0;
  const polygon = { id: 'poly', name: 'Triangle', type: 'POLYGON', pointCount: 3, x: 0, y: 0, width: 1, height: 1, visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
    absoluteRenderBounds: { x: 0, y: 0, width: 1, height: 1 }, exportAsync: async () => { exports++; return png; } };
  const root = frame('root', 'Screen', [polygon]); root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 };
  const api = { getImageByHash: () => null };
  const blocked = await captureSelection([root], 'ns', api, {}, { root: 'Main' });
  const diagnostic = blocked.diagnostics.find(item => item.nodeId === 'poly' && item.property === 'decorative-shape');
  assert.ok(diagnostic?.fingerprint);
  assert.equal(exports, 0);
  const approval = [{ nodeId: 'poly', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }];
  const approved = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval);
  assert.deepEqual(approved.diagnostics, []);
  assert.equal(approved.snapshot.schemaVersion.minor, 6);
  assert.equal(approved.snapshot.nodes[1].type, 'IMAGE');
  assert.equal(approved.snapshot.nodes[1].fallback.feature, 'decorative-shape');
  assert.equal(validateContract('snapshot', approved.snapshot), true);
  assert.equal(exports, 1);
  polygon.pointCount = 4;
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
  assert.equal(exports, 1);
  polygon.pointCount = 3;
  root.reactions = [{ trigger: { type: 'ON_CLICK' } }];
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
  assert.equal(exports, 1);
  delete root.reactions;
  polygon.exportAsync = async () => { polygon.pointCount = 4; return png; };
  const changed = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval);
  assert.ok(changed.diagnostics.some(item => item.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
});

test('polygon with fractional visible bounds exports full node bounds without moving the layer', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAD0lEQVR4nGP4z8DwHxkDAEPNB/lfEPxcAAAAAElFTkSuQmCC', 'base64'));
  const settings = [];
  const polygon = { id: 'poly', name: 'Triangle', type: 'POLYGON', pointCount: 3, x: 10, y: 20, width: 4, height: 1, visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    absoluteBoundingBox: { x: 10, y: 20, width: 4, height: 1 },
    absoluteRenderBounds: { x: 10.2, y: 20.25, width: 3.6, height: 0.75 },
    exportAsync: async value => { settings.push(value); return png; } };
  const root = frame('root', 'Screen', [polygon]); root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 };
  const api = { getImageByHash: () => null };
  const diagnostic = (await captureSelection([root], 'ns', api, {}, { root: 'Main' })).diagnostics.find(d => d.nodeId === 'poly');
  assert.ok(diagnostic.fingerprint);
  const approval = [{ nodeId: 'poly', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }];
  const result = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(settings[0], { format: 'PNG', constraint: { type: 'SCALE', value: 1 }, useAbsoluteBounds: true, contentsOnly: true });
  const captured = result.snapshot.nodes[1];
  assert.deepEqual([captured.x, captured.y, captured.width, captured.height], [10, 20, 4, 1]);
  assert.equal(validateContract('snapshot', result.snapshot), true);
  polygon.exportAsync = async () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  assert.equal((await captureSelection([root], 'ns', api, {}, { root: 'Main' }, approval)).snapshot, null);
});

test('auto-layout polygon fallback keeps its full slot; outer shadow bounds stay blocked', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAD0lEQVR4nGP4z8DwHxkDAEPNB/lfEPxcAAAAAElFTkSuQmCC', 'base64'));
  const polygon = { id: 'poly', name: 'Triangle', type: 'POLYGON', pointCount: 3, x: 0, y: 0, width: 4, height: 1, visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], absoluteBoundingBox: { x: 0, y: 0, width: 4, height: 1 },
    absoluteRenderBounds: { x: 0.2, y: 0, width: 3.6, height: 0.75 }, exportAsync: async () => png };
  const root = frame('root', 'Stack', [polygon, { ...frame('next', 'Next'), width: 4, height: 1 }]);
  root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 }; root.layoutMode = 'VERTICAL'; root.itemSpacing = 6;
  const api = { getImageByHash: () => null };
  const diagnostic = (await captureSelection([root], 'ns', api, {}, { root: 'Main' })).diagnostics.find(d => d.nodeId === 'poly');
  assert.ok(diagnostic.fingerprint);
  const result = await captureSelection([root], 'ns', api, {}, { root: 'Main' }, [{ nodeId: 'poly', feature: diagnostic.property, fingerprint: diagnostic.fingerprint }]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.nodes[1].height, 1);
  assert.equal(result.snapshot.nodes[0].itemSpacing, 6);
  polygon.absoluteRenderBounds.width = 5;
  const blocked = (await captureSelection([root], 'ns', api, {}, { root: 'Main' })).diagnostics.find(d => d.nodeId === 'poly');
  assert.equal(blocked.fingerprint, undefined);
  assert.match(blocked.message, /outside.*auto.layout/i);
});

test('fallback diagnostics identify the exact failed guard', async () => {
  const polygon = { id: 'poly', name: 'Triangle', type: 'POLYGON', pointCount: 3, x: 0, y: 0, width: 1, height: 1, visible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, absoluteRenderBounds: { x: 0, y: 0, width: 1, height: 1 } };
  const root = frame('root', 'Screen', [polygon]); root.absoluteBoundingBox = { x: 0, y: 0, width: 120, height: 50 };
  const reason = async () => (await captureSelection([root], 'ns', { getImageByHash: () => null })).diagnostics.find(d => d.property === 'decorative-shape').message;
  polygon.rotation = 15;
  assert.match(await reason(), /Triangle.*rotated/i);
  polygon.rotation = 0; root.reactions = [{ trigger: { type: 'ON_CLICK' } }];
  assert.match(await reason(), /Triangle.*interactive/i);
  delete root.reactions; delete polygon.absoluteRenderBounds;
  assert.match(await reason(), /Triangle.*render bounds.*unavailable/i);
});
