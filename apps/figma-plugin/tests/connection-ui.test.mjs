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
  setAttribute() {}
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test('opening offline then reconnecting lists selectable registered workspaces without pairing', async () => {
  const navigation = new Element();
  const content = new Element();
  globalThis.document = { querySelector: key => key === '#navigation' ? navigation : content, createElement: tag => new Element(tag) };
  globalThis.window = { addEventListener() {} };
  let online = false;
  globalThis.bridgeOnline = () => online;
  const compiled = await build({ entryPoints: ['src/ui/index.ts'], absWorkingDir: new URL('../', import.meta.url).pathname,
    bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'fake', setup(builder) {
      builder.onResolve({ filter: /bridge-client/ }, () => ({ path: 'bridge', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export class BridgeClient {
        async workspaces() { if (!globalThis.bridgeOnline()) throw new Error('offline'); return { workspaces: [
          { id: 'a', label: 'Sample workspace' }, { id: 'b', label: 'Second workspace' }] }; }
      }`, loader: 'js' }));
    } }] });
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
  await flush();
  navigation.children.find(item => item.textContent === 'Connection').listeners.click();
  assert.match(content.textContent, /Offline.*gumbridge serve/);
  assert.equal(content.children.length, 1);
  online = true;
  content.children[0].listeners.click();
  await flush();
  assert.match(content.textContent, /Connected.*Sample workspace/);
  const select = content.children.find(item => item.tag === 'select');
  assert.deepEqual(select.children.map(option => option.textContent), ['Sample workspace', 'Second workspace']);
  assert.equal(select.value, 'a');
  select.value = 'b'; select.listeners.change();
  assert.match(content.textContent, /Second workspace/);
  delete globalThis.bridgeOnline;
});

test('capture on A cannot publish to B when workspace changes before scene capture returns', async () => {
  const navigation = new Element();
  const content = new Element();
  globalThis.document = { querySelector: key => key === '#navigation' ? navigation : content, createElement: tag => new Element(tag) };
  const listeners = {};
  globalThis.window = { addEventListener: (event, callback) => { listeners[event] = callback; } };
  const posted = [];
  const published = [];
  globalThis.parent = { postMessage: message => posted.push(message.pluginMessage) };
  globalThis.capturePublished = published;
  const compiled = await build({ entryPoints: ['src/ui/index.ts'], absWorkingDir: new URL('../', import.meta.url).pathname,
    bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'fake', setup(builder) {
      builder.onResolve({ filter: /bridge-client/ }, () => ({ path: 'bridge', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export class BridgeClient {
        async workspaces() { return { workspaces: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }; }
        async publish(workspace) { globalThis.capturePublished.push(workspace); return { snapshotId: 'sha256:snapshot' }; }
      }`, loader: 'js' }));
    } }] });
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
  await flush();
  listeners.message({ data: { pluginMessage: { type: 'namespace-associated', namespace: 'design' } } });
  navigation.children.find(item => item.textContent === 'Preview and changes').listeners.click();
  const alias = content.children.find(item => item.tag === 'input' && !item.readOnly);
  alias.value = 'MainMenu';
  content.children.find(item => item.textContent === 'Capture selection and publish').listeners.click();
  assert.equal(posted.at(-1).type, 'capture-publication');
  navigation.children.find(item => item.textContent === 'Connection').listeners.click();
  const select = content.children.find(item => item.tag === 'select');
  assert.equal(select.disabled, true);
  select.value = 'b'; select.listeners.change(); // even a synthetic change must not switch the pinned destination
  listeners.message({ data: { pluginMessage: { type: 'capture-result', result: { snapshot: { snapshotId: 'sha256:snapshot' }, assets: [], diagnostics: [] } } } });
  await flush();
  assert.deepEqual(published, ['a']);
  assert.match(content.textContent, /A/);
  delete globalThis.capturePublished;
});
