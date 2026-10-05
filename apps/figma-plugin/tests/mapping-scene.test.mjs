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

test('scene publishes two mapped screens that share one definition', async () => {
  const data = new Map(), posts = [];
  const component = { id: 'shared', name: 'Shared', type: 'COMPONENT', x: 0, y: 0, width: 100, height: 40, visible: true, layoutMode: 'NONE', clipsContent: false, children: [] };
  const screen = id => ({ id, name: id, type: 'FRAME', x: 0, y: 0, width: 200, height: 100, visible: true, layoutMode: 'NONE', clipsContent: false,
    children: [{ id: `instance-${id}`, name: 'Shared instance', type: 'INSTANCE', x: 0, y: 0, width: 100, height: 40, visible: true,
      overrides: [], getMainComponentAsync: async () => component }] });
  const first = screen('a'), second = screen('b');
  globalThis.__html__ = '';
  globalThis.figma = { root: { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) },
    currentPage: { selection: [component], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null } };
  await import('../src/index.ts?multi-screen-scene');
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'doc-multi' });
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'SharedButton', controlId: 'native.frame' });
  figma.currentPage.selection = [first];
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'First', controlId: 'native.frame' });
  figma.currentPage.selection = [second];
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'Second', controlId: 'native.frame' });
  figma.currentPage.selection = [first, second];
  await figma.ui.onmessage({ type: 'capture-publication', namespace: 'doc-multi', alias: 'First' });
  const result = posts.at(-1).result;
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.snapshot.selectedRootIds, ['a', 'b']);
  assert.equal(result.snapshot.components.length, 1);
});

test('scene rejects reference whose placeholder dimensions differ from registered native control', async () => {
  const data = new Map(), posts = [];
  const workspaceId = 'a'.repeat(32);
  const component = { id: 'r', name: 'Placeholder', type: 'COMPONENT', x: 0, y: 0, width: 120, height: 40, visible: true, layoutMode: 'NONE', clipsContent: false, children: [] };
  globalThis.__html__ = '';
  globalThis.figma = { root: { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) },
    currentPage: { selection: [component], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: { major: 1, minor: 0 }, workspaceId,
    targetHash: 'sha256:' + 'c'.repeat(64), controls: [{ controlId: 'ExistingButton', hash: 'sha256:' + 'b'.repeat(64), width: 80, height: 20 }] }) });
  try {
    await import('../src/index.ts?reference-dimension-scene');
    await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'doc-reference-size' });
    await figma.ui.onmessage({ type: 'save-mapping', mode: 'reference', alias: 'ExistingButton', controlId: 'ExistingButton', workspaceId });
    assert.equal(posts.at(-1).type, 'mapping-error');
    assert.match(posts.at(-1).message, /dimension|size|bounds/i);
  } finally { globalThis.fetch = originalFetch; }
});

test('scene references only a registered developer-owned control without exporting its definition', async () => {
  const data = new Map(), posts = [];
  const workspaceId = 'a'.repeat(32), hash = 'sha256:' + 'b'.repeat(64);
  const component = { id: 'r', name: 'Placeholder', type: 'COMPONENT', x: 0, y: 0, width: 100, height: 40, visible: true, layoutMode: 'NONE', clipsContent: false, children: [] };
  const instance = { id: 'i', name: 'Existing', type: 'INSTANCE', x: 1, y: 2, width: 100, height: 40, visible: true, overrides: [],
    getMainComponentAsync: async () => component };
  const frame = { id: 'f', name: 'Screen', type: 'FRAME', x: 0, y: 0, width: 200, height: 100, visible: true, layoutMode: 'NONE', clipsContent: false, children: [instance] };
  globalThis.__html__ = '';
  globalThis.figma = { root: { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) },
    currentPage: { selection: [component], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: { major: 1, minor: 0 }, workspaceId,
    targetHash: 'sha256:' + 'c'.repeat(64), controls: [{ controlId: 'ExistingButton', hash, width: 100, height: 40 }] }) });
  try {
    await import('../src/index.ts?reference-mapping-scene');
    await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'doc-reference' });
    await figma.ui.onmessage({ type: 'save-mapping', mode: 'reference', alias: 'ExistingButton', controlId: 'ExistingButton', workspaceId });
    assert.equal(posts.at(-1).type, 'mapping-saved');
    figma.currentPage.selection = [frame];
    await figma.ui.onmessage({ type: 'save-mapping', alias: 'Menu', controlId: 'native.frame' });
    await figma.ui.onmessage({ type: 'capture-publication', namespace: 'doc-reference', alias: 'Menu', workspaceId });
    assert.deepEqual(posts.at(-1).result.diagnostics, []);
    assert.deepEqual(posts.at(-1).result.snapshot.components, [{ id: 'r', alias: 'ExistingButton', mode: 'reference', controlId: 'ExistingButton', width: 100, height: 40 }]);
    assert.ok(!('nodes' in posts.at(-1).result.snapshot.components[0]));
  } finally { globalThis.fetch = originalFetch; }
});

test('scene maps a component definition and captures its instance through the plugin message path', async () => {
  const data = new Map(), posts = [];
  const component = { id: '1:10', name: 'Shared', type: 'COMPONENT', x: 0, y: 0, width: 100, height: 40, visible: true, layoutMode: 'NONE', clipsContent: false, children: [] };
  const instance = { id: '1:11', name: 'Instance', type: 'INSTANCE', x: 10, y: 20, width: 100, height: 40, visible: true, overrides: [],
    getMainComponentAsync: async () => component, children: [] };
  const frame = { id: '1:12', name: 'Screen', type: 'FRAME', x: 0, y: 0, width: 200, height: 100, visible: true, layoutMode: 'NONE', clipsContent: false, children: [instance] };
  globalThis.__html__ = '';
  globalThis.figma = { root: { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) },
    currentPage: { selection: [component], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null } };
  await import('../src/index.ts?component-mapping-scene');
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'doc-shared' });
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'SharedButton', controlId: 'native.frame' });
  assert.equal(posts.at(-1).type, 'mapping-saved');
  figma.currentPage.selection = [frame];
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'Menu', controlId: 'native.frame' });
  await figma.ui.onmessage({ type: 'capture-publication', namespace: 'doc-shared', alias: 'Menu' });
  const result = posts.at(-1).result;
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.components[0].alias, 'SharedButton');
  assert.equal(result.snapshot.nodes[1].componentId, component.id);
});
