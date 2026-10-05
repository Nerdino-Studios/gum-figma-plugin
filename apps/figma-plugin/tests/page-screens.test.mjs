import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPageScreen, resolvePageScreen } from '../src/document/page-screens.ts';
import { loadMappings, saveMapping, builtinCatalog } from '../src/document/mappings.ts';

const frame = id => ({ id, name: 'Screen frame', type: 'FRAME' });
function document() {
  const data = new Map();
  return { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) };
}

test('page binding persists by source identity, survives display renames and keeps frame mappings', () => {
  const root = document(), screen = frame('1:2');
  const page = { id: '1:1', name: 'Menu', children: [screen], selection: [screen] };
  bindPageScreen(root, 'design', page, 'MainMenu');
  page.name = 'Renamed page'; screen.name = 'Renamed frame'; page.selection = [];
  const result = resolvePageScreen(root, 'design', page);
  assert.equal(result.frame, screen);
  assert.equal(result.mapping.alias, 'MainMenu');
  saveMapping(root, 'design', screen.id, { alias: 'MainMenu', mode: 'generate', catalogId: builtinCatalog.catalogId,
    revision: builtinCatalog.revision, controlId: 'native.frame' });
  assert.equal(resolvePageScreen(root, 'design', page).mapping.pageId, page.id);
  assert.equal(resolvePageScreen(root, 'other-design', page), null);
  assert.equal(resolvePageScreen(root, 'design', { ...page, id: 'copied-page' }), null);
});

test('page binding rejects nested frames, alias collisions and silent binding replacement without metadata writes', () => {
  const root = document(), first = frame('1:2'), second = frame('1:3');
  const page = { id: '1:1', children: [first, second], selection: [first] };
  bindPageScreen(root, 'design', page, 'MainMenu');
  const before = root.getPluginData('gumbridge.mappings.v1');
  page.selection = [second];
  assert.throws(() => bindPageScreen(root, 'design', page, 'OtherScreen'), /already bound/i);
  assert.equal(root.getPluginData('gumbridge.mappings.v1'), before);
  const nested = frame('1:4'); page.selection = [nested];
  assert.throws(() => bindPageScreen(root, 'design', page, 'Nested'), /top-level frame/i);
  const otherPage = { id: '2:1', children: [second], selection: [second] };
  assert.throws(() => bindPageScreen(root, 'design', otherPage, 'mainmenu'), /ALIAS_COLLISION/);
  assert.equal(root.getPluginData('gumbridge.mappings.v1'), before);
  page.children = [second];
  assert.throws(() => resolvePageScreen(root, 'design', page), /missing|moved/i);
  assert.equal(loadMappings(root, 'design')[0].nodeId, first.id);
});

test('corrupt duplicate page bindings are diagnosed instead of choosing a screen', () => {
  const root = document(), first = frame('1:2'), second = frame('1:3');
  const page = { id: '1:1', children: [first, second], selection: [first] };
  bindPageScreen(root, 'design', page, 'MainMenu');
  const stored = JSON.parse(root.getPluginData('gumbridge.mappings.v1'));
  stored.entries.push({ ...stored.entries[0], nodeId: second.id, alias: 'Other' });
  root.setPluginData('gumbridge.mappings.v1', JSON.stringify(stored));
  assert.throws(() => resolvePageScreen(root, 'design', page), /AMBIGUOUS_MAPPING/);
});
