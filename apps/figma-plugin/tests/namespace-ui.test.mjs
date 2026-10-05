import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute() {}
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
const find = (element, text) => descendants(element).find(child => child.textContent === text);

let panelCount = 0;
async function panel(cryptoValue, offline = false) {
  const navigation = new Element();
  const content = new Element();
  const messages = [];
  const listeners = {};
  globalThis.document = { querySelector: selector => selector === '#navigation' ? navigation : content, createElement: tag => new Element(tag) };
  globalThis.window = { addEventListener: (event, callback) => { listeners[event] = callback; } };
  globalThis.parent = { postMessage: message => messages.push(message.pluginMessage) };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoValue });
  const compiled = await build({ entryPoints: ['src/ui/index.ts'], absWorkingDir: new URL('../', import.meta.url).pathname,
    bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'bridge-fake', setup(builder) {
      builder.onResolve({ filter: /bridge-client/ }, () => ({ path: 'bridge', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: offline
        ? 'export class BridgeClient { async workspaces() { throw new Error("offline"); } }'
        : 'export class BridgeClient { async workspaces() { return { workspaces: [{ id: "workspace", label: "Sample" }] }; } async registeredControls() { return { controls: [{ controlId: "ExistingButton", hash: "sha256:" + "b".repeat(64) }] }; } }', loader: 'js' }));
    } }] });
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64') + '#' + ++panelCount);
  find(navigation, 'Connection').listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  find(navigation, 'Publish').listeners.click();
  return { content, messages, receive: pluginMessage => listeners.message({ data: { pluginMessage } }), navigation };
}

test('iframe without randomUUID creates distinct path-free namespace and preserves known design continuation and capture', async () => {
  let counter = 0;
  const ui = await panel({ getRandomValues: bytes => { bytes.fill(++counter); return bytes; } });
  ui.receive({ type: 'namespace-association', retained: 'known-design' });
  find(ui.content, 'New design namespace').listeners.click();
  const first = ui.messages.at(-1);
  assert.equal(first.type, 'associate-namespace');
  assert.equal(first.mode, 'new');
  assert.match(first.namespace, /^[A-Za-z0-9_-]{1,100}$/);
  assert.notEqual(first.namespace, 'known-design');
  find(ui.content, 'New design namespace').listeners.click();
  assert.notEqual(ui.messages.at(-1).namespace, first.namespace);
  find(ui.content, 'Continue known design').listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'associate-namespace', mode: 'continue', namespace: 'known-design' });
  ui.receive({ type: 'namespace-associated', namespace: first.namespace });
  ui.receive({ type: 'page-screen-state', pageId: 'page', pageName: 'Menu', binding: null, diagnostics: [] });
  ui.receive({ type: 'mapping-state', selectedIds: ['frame'], selectedTypes: ['FRAME'], mappings: [], diagnostics: [] });
  const alias = ui.content.children.find(child => child.tag === 'input');
  alias.value = 'MainMenu';
  find(ui.content, 'Bind selected frame to page').listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'bind-page-screen', pageId: 'page', alias: 'MainMenu' });
  ui.receive({ type: 'page-screen-state', pageId: 'page', pageName: 'Menu', binding: { frameId: 'frame', frameName: 'Design', alias: 'MainMenu' }, diagnostics: [] });
  find(ui.content, 'Publish').listeners.click();
  const capture = ui.messages.at(-1);
  assert.match(capture.requestId, /^\d+$/);
  assert.deepEqual(capture, { type: 'capture-page-publication', requestId: capture.requestId, pageId: 'page', namespace: first.namespace, workspaceId: 'workspace' });
});

test('offline blank-document mapping panel associates namespace and saves stable alias without workspace', async () => {
  const ui = await panel({ getRandomValues: bytes => { bytes.fill(1); return bytes; } }, true);
  ui.receive({ type: 'namespace-association', retained: null });
  assert.deepEqual(ui.navigation.children.map(child => child.textContent), ['Connection', 'Publish']);
  find(ui.content, 'New design namespace').listeners.click();
  const namespace = ui.messages.at(-1).namespace;
  ui.receive({ type: 'namespace-associated', namespace });
  ui.receive({ type: 'page-screen-state', pageId: 'page', pageName: 'Menu', binding: null, diagnostics: [] });
  ui.receive({ type: 'mapping-state', selectedIds: ['1:2'], selectedTypes: ['FRAME'], mappings: [], diagnostics: [] });
  const alias = ui.content.children.find(child => child.tag === 'input' && child.placeholder === 'Screen name');
  alias.value = 'MainMenu';
  find(ui.content, 'Bind selected frame to page').listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'bind-page-screen', pageId: 'page', alias: 'MainMenu' });
  assert.equal(find(ui.content, 'Publish').disabled, true);
});

test('iframe exposes registered referenced component option only for a selected component', async () => {
  const ui = await panel({ getRandomValues: bytes => { bytes.fill(1); return bytes; } });
  ui.receive({ type: 'namespace-associated', namespace: 'ns' });
  find(ui.navigation, 'Publish').listeners.click();
  ui.receive({ type: 'mapping-state', selectedIds: ['component'], selectedTypes: ['COMPONENT'], mappings: [], diagnostics: [] });
  const selector = descendants(ui.content).find(child => child.tag === 'select');
  assert.ok(selector.children.some(option => option.value === 'reference:ExistingButton'));
  selector.value = 'reference:ExistingButton';
  const input = descendants(ui.content).find(child => child['aria-label'] === 'Stable public alias' || child.placeholder === 'Public alias');
  input.value = 'ExistingButton';
  find(ui.content, 'Save mapping').listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'save-mapping', alias: 'ExistingButton', controlId: 'ExistingButton',
    mode: 'reference', workspaceId: 'workspace' });
});

test('iframe without a suitable random source reports failure instead of posting an invalid namespace', async () => {
  const ui = await panel({});
  ui.receive({ type: 'namespace-association', retained: null });
  find(ui.content, 'New design namespace').listeners.click();
  assert.equal(ui.messages.length, 0);
  assert.match(ui.content.textContent, /namespace unavailable/i);
});
