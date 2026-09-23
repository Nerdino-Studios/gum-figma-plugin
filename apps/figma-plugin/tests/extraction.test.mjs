import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSelectedRoots } from '../src/document/selection.ts';
import { captureSelection, canonicalize, hashBytes } from '../src/document/extraction.ts';
import { validateContract } from '../src/transport/contracts.ts';

const frame = (id, name, children = []) => ({ id, name, type: 'FRAME', x: 0, y: -0, width: 120, height: 50, visible: true, layoutMode: 'NONE', clipsContent: false, children, fills: [] });
const text = (id) => ({ id, name: 'Label', type: 'TEXT', x: 2, y: 3, width: 30, height: 12, visible: true, characters: 'Hello', fontSize: 12, fontName: { family: 'Inter', style: 'Regular' }, fills: [] });

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
