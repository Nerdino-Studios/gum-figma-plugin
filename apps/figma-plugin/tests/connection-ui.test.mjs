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
  const catalogRequests = [];
  globalThis.recordCatalog = id => catalogRequests.push(id);
  const compiled = await build({ entryPoints: ['src/ui/index.ts'], absWorkingDir: new URL('../', import.meta.url).pathname,
    bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'fake', setup(builder) {
      builder.onResolve({ filter: /bridge-client/ }, () => ({ path: 'bridge', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export class BridgeClient {
        async workspaces() { if (!globalThis.bridgeOnline()) throw new Error('offline'); return { workspaces: [
          { id: 'a', label: 'Sample workspace' }, { id: 'b', label: 'Second workspace' }] }; }
        async registeredControls(id) { globalThis.recordCatalog(id); return { controls: [] }; }
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
  assert.match(content.textContent, /Connected/);
  assert.ok(content.children.some(child => /Sample workspace/.test(child.textContent)));
  const select = content.children.find(item => item.tag === 'select');
  assert.deepEqual(select.children.map(option => option.textContent), ['Sample workspace', 'Second workspace']);
  assert.equal(select.value, 'a');
  select.value = 'b'; select.listeners.change();
  await flush();
  assert.ok(content.children.some(child => /Second workspace/.test(child.textContent)));
  assert.deepEqual(catalogRequests, ['a', 'b']);
  delete globalThis.bridgeOnline;
  delete globalThis.recordCatalog;
});
