import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSelection } from '../src/document/extraction.ts';
import { validateContract } from '../src/transport/contracts.ts';

const frame = (id, children = []) => ({ id, name: id, type: 'FRAME', x: 0, y: 0, width: 800, height: 600, visible: true, layoutMode: 'NONE', clipsContent: false, children });
const definition = { ...frame('shared'), type: 'COMPONENT' };
const instance = id => ({ id, name: id, type: 'INSTANCE', x: 10, y: 20, width: 100, height: 40, visible: true,
  overrides: [], getMainComponentAsync: async () => definition });
const images = { getImageByHash: () => null };
const mappings = { shared: { alias: 'Shared', mode: 'generate' } };

test('two roots capture one transitive shared definition and a stable snapshot', async () => {
  const selected = [frame('a', [instance('i1')]), frame('b', [instance('i2')])];
  const first = await captureSelection(selected, 'ns', images, {}, { a: 'First', b: 'Second' }, [], [], mappings);
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.snapshot.components.length, 1);
  assert.equal(first.snapshot.schemaVersion.minor, 5);
  assert.equal(first.snapshot.nodes.filter(n => n.type === 'INSTANCE').length, 2);
  assert.equal(validateContract('snapshot', first.snapshot), true);
  const second = await captureSelection(selected, 'ns', images, {}, { a: 'First', b: 'Second' }, [], [], mappings);
  assert.equal(second.snapshot.snapshotId, first.snapshot.snapshotId);
});

test('flipped and skewed instances block instead of losing their transform', async () => {
  for (const relativeTransform of [[[-1, 0, 110], [0, 1, 20]], [[1, 0.2, 10], [0, 1, 20]]]) {
    const node = { ...instance('i'), relativeTransform, rotation: 0 };
    const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
    assert.equal(result.snapshot, null);
    assert.ok(result.diagnostics.some(d => d.nodeId === 'i' && d.property === 'relativeTransform'));
  }
});

test('hand-built responsive instance fails wire validation', async () => {
  const result = await captureSelection([frame('a', [instance('i')])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
  const malicious = structuredClone(result.snapshot);
  Object.assign(malicious.nodes.find(n => n.type === 'INSTANCE'), { horizontalSizing: 'FILL', horizontalAnchor: 'STRETCH' });
  assert.equal(validateContract('snapshot', malicious), false);
});

test('unsupported instance opacity is never silently discarded', async () => {
  const node = { ...instance('i'), opacity: 0.5, overrides: [] };
  const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.nodeId === 'i' && d.property === 'opacity'));
});

test('referenced placeholder flip and skew cannot be silently discarded', async () => {
  const referenceMapping = { shared: { alias: 'ExistingButton', mode: 'reference', controlId: 'ExistingButton', targetWidth: 100, targetHeight: 40 } };
  for (const relativeTransform of [[[-1, 0, 100], [0, 1, 0]], [[1, 0.2, 0], [0, 1, 0]]]) {
    const reference = { ...definition, width: 100, height: 40, children: [], fills: [],
      relativeTransform, rotation: 0 };
    const node = { ...instance('i'), getMainComponentAsync: async () => reference };
    const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], referenceMapping);
    assert.equal(result.snapshot, null);
    assert.ok(result.diagnostics.some(d => d.nodeId === 'shared' && d.property === 'relativeTransform'));
  }
});

test('referenced instance dimensions must match its unstyled definition', async () => {
  const reference = { ...definition, children: [], fills: [] };
  const node = { ...instance('i'), width: 200, getMainComponentAsync: async () => reference };
  const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [],
    { shared: { alias: 'ExistingButton', mode: 'reference', controlId: 'ExistingButton' } });
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.nodeId === 'i' && d.code === 'INVALID_CONTROL_CONTRACT'));
});

test('child position override is rejected rather than silently discarded', async () => {
  const node = { ...instance('i'), overrides: [{ id: 'child', overriddenFields: ['x'] }] };
  const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.property === 'overrides'));
});

test('definition replacement under the same ID during capture blocks mixed revision', async () => {
  const old = { ...definition, width: 100 };
  const replacement = { ...definition, width: 200 };
  let calls = 0;
  const node = { ...instance('i'), getMainComponentAsync: async () => ++calls === 1 ? old : replacement };
  const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
});

test('same-ID child replacement in a definition is not mistaken for an unchanged graph', async () => {
  const original = { ...definition, children: [frame('child')] };
  const changed = { ...definition, children: [{ ...frame('child'), x: 30 }] };
  let calls = 0;
  const node = { ...instance('i'), getMainComponentAsync: async () => ++calls === 1 ? original : changed };
  const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
});

test('transitive definitions share the selected graph node budget', async () => {
  const leaf = { ...definition, id: 'leaf', children: [frame('inner-leaf')] };
  const middle = { ...definition, id: 'middle', children: [
    { ...instance('nested'), getMainComponentAsync: async () => leaf }, frame('inner-middle')] };
  const node = { ...instance('i'), getMainComponentAsync: async () => middle };
  const result = await captureSelection([frame('a', [node])], 'ns', images, { maxNodes: 6 }, { a: 'First' }, [], [],
    { middle: { alias: 'Middle', mode: 'generate' }, leaf: { alias: 'Leaf', mode: 'generate' } });
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => /budget/i.test(d.message)));
});

test('definition root mutation during asynchronous resolution blocks mixed capture', async () => {
  const changing = { ...definition };
  let calls = 0;
  const node = { ...instance('i'), getMainComponentAsync: async () => {
    if (++calls === 2) changing.width += 1;
    return changing;
  } };
  const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mappings);
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(d => d.code === 'SOURCE_CHANGED_DURING_CAPTURE'));
});

test('missing definition, mapping or unapproved visual override cannot finalize', async () => {
  for (const [node, mapping] of [[{ ...instance('i'), getMainComponentAsync: async () => null }, mappings],
    [instance('i'), {}], [{ ...instance('i'), overrides: [{ id: 'i', overriddenFields: ['fills'] }] }, mappings]]) {
    const result = await captureSelection([frame('a', [node])], 'ns', images, {}, { a: 'First' }, [], [], mapping);
    assert.equal(result.snapshot, null);
    assert.ok(result.diagnostics.length);
  }
});
