import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; this.value = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const find = (element, text) => element.children.find(child => child.textContent === text);
let sequence = 0;
async function panel(overrides = {}) {
  const navigation = new Element(), content = new Element(), listeners = {}, messages = [], calls = [];
  globalThis.document = { querySelector: selector => selector === '#navigation' ? navigation : content, createElement: tag => new Element(tag) };
  globalThis.window = { addEventListener: (name, callback) => listeners[name] = callback };
  globalThis.parent = { postMessage: ({ pluginMessage }) => messages.push(pluginMessage) };
  globalThis.publishUiBridge = {
    async workspaces() { return { workspaces: [{ id: 'workspace', label: 'Sample workspace' }] }; },
    async registeredControls() { return { controls: [] }; },
    async publish(workspaceId, bundle) { calls.push(['publish', workspaceId, bundle.snapshot.snapshotId]); return { snapshotId: bundle.snapshot.snapshotId, status: 'published' }; },
    async run(workspaceId, snapshotId) { calls.push(['run', workspaceId, snapshotId]); return { status: 'running', runtimeId: 'runtime-id', targetHash: 'sha256:target', outputHash: 'sha256:output' }; },
    ...overrides,
  };
  const compiled = await build({ entryPoints: ['src/ui/index.ts'], absWorkingDir: new URL('../', import.meta.url).pathname,
    bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'bridge-fake', setup(builder) {
      builder.onResolve({ filter: /bridge-client/ }, () => ({ path: 'bridge', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export class BridgeClient {
        workspaces() { return globalThis.publishUiBridge.workspaces(); }
        registeredControls() { return globalThis.publishUiBridge.registeredControls(); }
        publish(...args) { return globalThis.publishUiBridge.publish(...args); }
        run(...args) { return globalThis.publishUiBridge.run(...args); }
      }`, loader: 'js' }));
    } }] });
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64') + '#' + ++sequence);
  await flush();
  const receive = pluginMessage => listeners.message({ data: { pluginMessage } });
  receive({ type: 'namespace-associated', namespace: 'design' });
  receive({ type: 'page-screen-state', pageId: 'page-one', pageName: 'Menu', binding: { frameId: 'frame-one', frameName: 'Design frame', alias: 'MainMenu' }, diagnostics: [] });
  find(navigation, 'Publish').listeners.click();
  const captured = (diagnostics = []) => receive({ type: 'capture-result', requestId: messages.findLast(message => message.type === 'capture-page-publication').requestId,
    result: { snapshot: diagnostics.length ? null : { snapshotId: 'sha256:snapshot' }, assets: [], diagnostics } });
  return { navigation, content, messages, calls, receive, captured };
}

test('two sections publish the bound page once and launch its exact stored snapshot without screenshots', async () => {
  const ui = await panel();
  assert.deepEqual(ui.navigation.children.map(child => child.textContent), ['Connection', 'Publish']);
  const button = find(ui.content, 'Publish');
  button.listeners.click(); button.listeners.click();
  assert.equal(ui.messages.filter(message => message.type === 'capture-page-publication').length, 1);
  assert.equal(ui.messages.at(-1).pageId, 'page-one');
  ui.captured(); await flush();
  assert.deepEqual(ui.calls, [['publish', 'workspace', 'sha256:snapshot'], ['run', 'workspace', 'sha256:snapshot']]);
  assert.match(ui.content.textContent, /Running.*FRB2.*MainMenu/);
  assert.equal(ui.content.children.some(child => child.tag === 'img'), false);
  ui.receive({ type: 'selection-changed', names: ['Different child'] });
  assert.match(ui.content.textContent, /Running/);
  assert.doesNotMatch(ui.content.textContent, /Source changed/);
});

test('capture diagnostics stop publication and runtime launch', async () => {
  const ui = await panel();
  find(ui.content, 'Publish').listeners.click();
  ui.captured([{ code: 'UNSUPPORTED_FEATURE', message: 'Rounded corners are not captured' }]);
  await flush();
  assert.deepEqual(ui.calls, []);
  assert.match(ui.content.textContent, /Rounded corners/);
  assert.equal(find(ui.content, 'Publish').disabled, false);
});

test('page switching invalidates an outstanding capture and does not publish its late result', async () => {
  const ui = await panel();
  find(ui.content, 'Publish').listeners.click();
  ui.receive({ type: 'page-screen-state', pageId: 'page-two', pageName: 'Other', binding: null, diagnostics: [] });
  ui.captured(); await flush();
  assert.deepEqual(ui.calls, []);
  assert.doesNotMatch(ui.content.textContent, /Running/);
  assert.equal(find(ui.content, 'Publish').disabled, true);
});

test('source changes while finalizing never launch the newly stale snapshot', async () => {
  let finish;
  const ui = await panel({ publish: () => new Promise(resolve => finish = resolve) });
  find(ui.content, 'Publish').listeners.click(); ui.captured();
  ui.receive({ type: 'source-changed' });
  finish({ snapshotId: 'sha256:snapshot', status: 'published' }); await flush();
  assert.deepEqual(ui.calls, []);
  assert.match(ui.content.textContent, /Source changed.*publish again/i);
});

test('runtime failure remains a published snapshot and exposes the launch error without claiming it runs', async () => {
  const ui = await panel({ run: async () => { throw new Error('FRB2 build failed'); } });
  find(ui.content, 'Publish').listeners.click(); ui.captured(); await flush();
  assert.match(ui.content.textContent, /Published.*FRB2 build failed/);
  assert.doesNotMatch(ui.content.textContent, /Running/);
});

test('offline page binding remains usable while publication and runtime are disabled', async () => {
  const ui = await panel({ workspaces: async () => { throw new Error('offline'); } });
  ui.receive({ type: 'page-screen-state', pageId: 'page-one', pageName: 'Menu', binding: null, diagnostics: [] });
  ui.receive({ type: 'mapping-state', selectedIds: ['frame-one'], selectedTypes: ['FRAME'], mappings: [], diagnostics: [] });
  const name = ui.content.children.find(child => child.tag === 'input'); name.value = 'MainMenu';
  find(ui.content, 'Bind selected frame to page').listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'bind-page-screen', pageId: 'page-one', alias: 'MainMenu' });
  assert.equal(find(ui.content, 'Publish').disabled, true);
  assert.deepEqual(ui.calls, []);
  find(ui.navigation, 'Connection').listeners.click();
  assert.match(ui.content.textContent, /Offline/);
  assert.equal(find(ui.content, 'Connect to local bridge').disabled, false);
});

test('a synthetic workspace change cannot redirect an in-flight page publication', async () => {
  const ui = await panel({ workspaces: async () => ({ workspaces: [{ id: 'workspace', label: 'A' }, { id: 'other', label: 'B' }] }) });
  find(ui.content, 'Publish').listeners.click();
  find(ui.navigation, 'Connection').listeners.click();
  const picker = ui.content.children.find(child => child.tag === 'select');
  assert.equal(picker.disabled, true);
  picker.value = 'other'; picker.listeners.change();
  ui.captured(); await flush();
  assert.deepEqual(ui.calls, [['publish', 'workspace', 'sha256:snapshot'], ['run', 'workspace', 'sha256:snapshot']]);
});

test('polygon diagnostic identifies the source and requests exact decorative-shape approval', async () => {
  const ui = await panel();
  find(ui.content, 'Publish').listeners.click();
  ui.captured([{ code: 'UNSUPPORTED_FEATURE', nodeId: 'poly', property: 'decorative-shape', fingerprint: 'sha256:fingerprint',
    message: 'Decorative raster fallback: loses editability and resolution independence.' }]);
  assert.match(ui.content.textContent, /poly.*decorative-shape/);
  const approve = ui.content.children.find(child => child.textContent.startsWith('Approve decorative PNG fallback'));
  assert.ok(approve);
  approve.listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'approve-decorative-fallback', pageId: 'page-one', nodeId: 'poly',
    feature: 'decorative-shape', fingerprint: 'sha256:fingerprint' });
  assert.deepEqual(ui.calls, []);
});
