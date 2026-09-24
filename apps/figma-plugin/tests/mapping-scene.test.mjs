import { test } from 'node:test';
import assert from 'node:assert/strict';

test('scene saves alias by source ID, keeps it after layer rename, and refuses unsaved publication aliases', async () => {
  const data = new Map(), posts = [];
  const frame = { id: '1:2', name: 'Original', type: 'FRAME', x: 0, y: 0, width: 100, height: 100, visible: true, layoutMode: 'NONE', clipsContent: false, children: [] };
  globalThis.__html__ = '';
  globalThis.figma = {
    root: { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) },
    currentPage: { selection: [frame], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null },
  };
  await import('../src/index.ts?mapping-scene');
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'doc-one' });
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'MainMenu', controlId: 'native.frame' });
  assert.equal(posts.at(-1).type, 'mapping-saved');
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'Wrong', controlId: 'native.text' });
  assert.match(posts.at(-1).message, /INVALID_CONTROL_CONTRACT/);
  frame.name = 'Renamed';
  await figma.ui.onmessage({ type: 'read-mappings' });
  assert.equal(posts.at(-1).mappings[0].alias, 'MainMenu');
  await figma.ui.onmessage({ type: 'capture-publication', namespace: 'doc-one', alias: 'OtherName' });
  assert.match(posts.at(-1).result.diagnostics[0].message, /Save the public alias/);
  await figma.ui.onmessage({ type: 'capture-publication', namespace: 'doc-one', alias: 'MainMenu' });
  assert.equal(posts.at(-1).result.snapshot.rootAliases[0].alias, 'MainMenu');
  assert.deepEqual(posts.at(-1).result.snapshot.rootMappings, [{ rootId: '1:2', mode: 'generate', catalogId: 'gumbridge.builtin', revision: '1.0', controlId: 'native.frame' }]);
});
