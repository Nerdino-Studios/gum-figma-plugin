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
const find = (element, text) => element.children.find(child => child.textContent === text);

let panelCount = 0;
async function panel(cryptoValue) {
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
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export class BridgeClient { async pair() {} async workspaces() { return { workspaces: [{ id: "workspace", label: "Sample" }] }; } }', loader: 'js' }));
    } }] });
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64') + '#' + ++panelCount);
  find(navigation, 'Connection').listeners.click();
  const form = content.children.find(child => child.tag === 'form');
  form.children[0].value = 'challenge';
  await form.listeners.submit({ preventDefault() {} });
  find(navigation, 'Preview and changes').listeners.click();
  return { content, messages, receive: pluginMessage => listeners.message({ data: { pluginMessage } }) };
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
  const alias = ui.content.children.find(child => child.tag === 'input' && child.placeholder);
  alias.value = 'MainMenu';
  find(ui.content, 'Capture selection and publish').listeners.click();
  assert.deepEqual(ui.messages.at(-1), { type: 'capture-publication', namespace: first.namespace, alias: 'MainMenu' });
});

test('iframe without a suitable random source reports failure instead of posting an invalid namespace', async () => {
  const ui = await panel({});
  ui.receive({ type: 'namespace-association', retained: null });
  find(ui.content, 'New design namespace').listeners.click();
  assert.equal(ui.messages.length, 0);
  assert.match(ui.content.textContent, /namespace unavailable/i);
});
