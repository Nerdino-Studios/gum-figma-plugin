import { test } from 'node:test';
import assert from 'node:assert/strict';

let sequence = 0;
const frame = id => ({ id, name: 'Design', type: 'FRAME', x: 0, y: 0, width: 800, height: 600,
  visible: true, layoutMode: 'NONE', clipsContent: false, children: [] });
async function scene() {
  const data = new Map(), posts = [], events = new Map();
  const screen = frame('1:2'), outside = frame('1:3');
  const page = { id: '1:1', name: 'Menu', children: [screen, outside], selection: [screen], on() {}, off() {} };
  globalThis.__html__ = '';
  globalThis.figma = { root: { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) },
    currentPage: page, showUI() {}, on: (name, callback) => events.set(name, callback),
    ui: { postMessage: message => posts.push(message), onmessage: null } };
  await import('../src/index.ts?page-screen=' + ++sequence);
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'design' });
  return { page, screen, outside, posts, events };
}

test('binding a page saves its screen alias and captures the full bound frame with no selection', async () => {
  const { page, screen, outside, posts, events } = await scene();
  screen.children.push({ ...frame('1:4'), name: 'Inside', width: 100, height: 50 });
  await figma.ui.onmessage({ type: 'bind-page-screen', pageId: page.id, alias: 'MainMenu' });
  assert.equal(posts.at(-1).type, 'page-screen-state');
  assert.equal(posts.at(-1).binding.alias, 'MainMenu');
  page.selection = [outside]; events.get('selectionchange')();
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  assert.equal(posts.at(-1).type, 'capture-result');
  assert.deepEqual(posts.at(-1).result.diagnostics, []);
  const snapshot = posts.at(-1).result.snapshot;
  assert.deepEqual(snapshot.selectedRootIds, [screen.id]);
  assert.deepEqual(snapshot.nodes.map(node => node.id), [screen.id, '1:4']);
  assert.equal(snapshot.rootAliases[0].alias, 'MainMenu');
  page.selection = [];
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  assert.equal(posts.at(-1).result.snapshot.snapshotId, snapshot.snapshotId);
});

test('page switching, missing bound frames and copied namespaces cannot capture another screen', async () => {
  const { page, screen, posts, events } = await scene();
  await figma.ui.onmessage({ type: 'bind-page-screen', pageId: page.id, alias: 'MainMenu' });
  const second = { ...page, id: '2:1', name: 'Second', children: [], selection: [] };
  figma.currentPage = second; events.get('currentpagechange')();
  assert.equal(posts.findLast(message => message.type === 'page-screen-state').binding, null);
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  assert.equal(posts.at(-1).result.snapshot, null);
  assert.match(posts.at(-1).result.diagnostics[0].message, /page changed/i);
  figma.currentPage = page; page.children = [];
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  assert.match(posts.at(-1).result.diagnostics[0].message, /missing|moved/i);
  page.children = [screen];
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'copied-design' });
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'copied-design' });
  assert.match(posts.at(-1).result.diagnostics[0].message, /bind/i);
});

test('page changes during asynchronous component capture reject the result', async () => {
  const { page, screen, posts } = await scene();
  const component = { ...frame('1:5'), type: 'COMPONENT' };
  page.children.push(component); page.selection = [component];
  await figma.ui.onmessage({ type: 'save-mapping', alias: 'SharedBlock', controlId: 'native.frame' });
  page.selection = [screen];
  await figma.ui.onmessage({ type: 'bind-page-screen', pageId: page.id, alias: 'MainMenu' });
  screen.children.push({ id: '1:6', name: 'Instance', type: 'INSTANCE', x: 0, y: 0, width: 800, height: 600,
    visible: true, overrides: [], getMainComponentAsync: async () => {
      figma.currentPage = { ...page, id: '2:1' }; return component;
    } });
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  assert.equal(posts.at(-1).result.snapshot, null);
  assert.match(posts.at(-1).result.diagnostics[0].message, /page changed/i);
});

test('bound page polygon approval persists its exact feature and ignores unrelated selection', async () => {
  const { page, screen, outside, posts } = await scene();
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  screen.absoluteBoundingBox = { x: 0, y: 0, width: 800, height: 600 };
  screen.children.push({ id: 'poly', name: 'Triangle', type: 'POLYGON', pointCount: 3, x: 0, y: 0, width: 1, height: 1,
    visible: true, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, absoluteRenderBounds: { x: 0, y: 0, width: 1, height: 1 },
    exportAsync: async () => png });
  await figma.ui.onmessage({ type: 'bind-page-screen', pageId: page.id, alias: 'MainMenu' });
  page.selection = [outside];
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  const diagnostic = posts.at(-1).result.diagnostics.find(item => item.property === 'decorative-shape');
  assert.ok(diagnostic.fingerprint);
  await figma.ui.onmessage({ type: 'approve-decorative-fallback', pageId: page.id, nodeId: 'poly',
    feature: 'decorative-shape', fingerprint: diagnostic.fingerprint });
  assert.equal(posts.at(-1).type, 'fallback-approved');
  await figma.ui.onmessage({ type: 'capture-page-publication', pageId: page.id, namespace: 'design' });
  assert.deepEqual(posts.at(-1).result.diagnostics, []);
  assert.equal(posts.at(-1).result.snapshot.nodes[1].fallback.feature, 'decorative-shape');
});
