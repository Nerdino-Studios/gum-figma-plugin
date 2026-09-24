import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinCatalog, resolveMapping, saveMapping, loadMappings, aliasesForSelection } from '../src/document/mappings.ts';

function root() {
  const data = new Map();
  return { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) };
}

test('offline catalog is versioned and marks unimplemented adapters unavailable', () => {
  assert.equal(builtinCatalog.catalogId, 'gumbridge.builtin');
  assert.match(builtinCatalog.revision, /^1\./);
  assert.ok(builtinCatalog.controls.some(c => c.id === 'native.text' && c.available));
  assert.ok(builtinCatalog.controls.some(c => c.id === 'forms.button' && !c.available));
});

test('alias survives display rename and repeated launch, but copied metadata cannot silently change namespace', () => {
  const store = root();
  saveMapping(store, 'design-one', '1:2', { alias: 'MainMenu', mode: 'generate', catalogId: 'gumbridge.builtin', revision: builtinCatalog.revision, controlId: 'native.frame' });
  assert.equal(aliasesForSelection(loadMappings(store, 'design-one'), ['1:2'])['1:2'], 'MainMenu');
  assert.deepEqual(loadMappings(store, 'design-two'), []);
  assert.equal(resolveMapping(loadMappings(store, 'design-one')[0], builtinCatalog).length, 0);
});

test('alias collision, invalid identifier and ambiguous copied records block save', () => {
  const store = root();
  saveMapping(store, 'design-one', '1:2', { alias: 'MainMenu', mode: 'generate', catalogId: 'gumbridge.builtin', revision: builtinCatalog.revision, controlId: 'native.frame' });
  assert.throws(() => saveMapping(store, 'design-one', '1:3', { alias: 'mainmenu', mode: 'generate', catalogId: 'gumbridge.builtin', revision: builtinCatalog.revision, controlId: 'native.frame' }), /ALIAS_COLLISION/);
  assert.throws(() => saveMapping(store, 'design-one', '1:3', { alias: '../bad', mode: 'generate', catalogId: 'gumbridge.builtin', revision: builtinCatalog.revision, controlId: 'native.frame' }), /INVALID_ALIAS/);
  store.setPluginData('gumbridge.mappings.v1', JSON.stringify({ version: 1, namespace: 'design-one', entries: [loadMappings(store, 'design-one')[0], loadMappings(store, 'design-one')[0]] }));
  assert.throws(() => loadMappings(store, 'design-one'), /AMBIGUOUS_MAPPING/);
});

test('custom target, old catalog, unknown control and unimplemented adapter surface diagnostics', () => {
  const mapping = { nodeId: '1:2', alias: 'Main', mode: 'reference', catalogId: 'custom', revision: '1.0', controlId: 'widget' };
  assert.match(resolveMapping(mapping, builtinCatalog).join(' '), /CATALOG_MISMATCH/);
  assert.match(resolveMapping({ ...mapping, catalogId: builtinCatalog.catalogId, revision: '0.9' }, builtinCatalog).join(' '), /CATALOG_MISMATCH/);
  assert.match(resolveMapping({ ...mapping, catalogId: builtinCatalog.catalogId, revision: builtinCatalog.revision }, builtinCatalog).join(' '), /UNRESOLVED_COMPONENT/);
  assert.match(resolveMapping({ ...mapping, mode: 'generate', catalogId: builtinCatalog.catalogId, revision: builtinCatalog.revision, controlId: 'forms.button' }, builtinCatalog).join(' '), /INVALID_CONTROL_CONTRACT/);
});
