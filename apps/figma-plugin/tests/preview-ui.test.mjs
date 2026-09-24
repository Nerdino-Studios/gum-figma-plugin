import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute() {}
}
const find = (element, text) => element.children.find(child => child.textContent === text);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('selection changes immediately label a visible successful preview stale', async () => {
  const navigation = new Element();
  const content = new Element();
  globalThis.document = { querySelector: selector => selector === '#navigation' ? navigation : content, createElement: tag => new Element(tag) };
  const listeners = {};
  globalThis.window = { addEventListener: (event, callback) => { listeners[event] = callback; } };
  globalThis.parent = { postMessage() {} };
  globalThis.URL.createObjectURL = () => 'blob:preview';
  globalThis.URL.revokeObjectURL = () => {};
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const outputHash = 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', png)), byte => byte.toString(16).padStart(2, '0')).join('');
  const compiled = await build({ entryPoints: ['src/ui/index.ts'], absWorkingDir: new URL('../', import.meta.url).pathname, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'bridge-fake', setup(builder) {
    builder.onResolve({ filter: /bridge-client/ }, () => ({ path: 'bridge', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export class BridgeClient {
      async pair() {} async workspaces() { return { workspaces: [{ id: 'workspace', label: 'Sample' }] }; }
      async publish() { return { snapshotId: 'sha256:snapshot' }; }
      async preview() { if (globalThis.previewFailure) throw new Error(globalThis.previewFailure); return { png: new Uint8Array([137,80,78,71,13,10,26,10]), outputHash: '${outputHash}', targetHash: 'sha256:target', artifactId: 'sha256:artifact' }; }
    }`, loader: 'js' }));
  } }] });
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
  find(navigation, 'Connection').listeners.click();
  const form = content.children.find(child => child.tag === 'form');
  form.children[0].value = 'challenge';
  await form.listeners.submit({ preventDefault() {} });
  listeners.message({ data: { pluginMessage: { type: 'namespace-associated', namespace: 'design' } } });
  find(navigation, 'Preview and changes').listeners.click();
  listeners.message({ data: { pluginMessage: { type: 'capture-result', result: { snapshot: { snapshotId: 'sha256:snapshot' }, assets: [], diagnostics: [] } } } });
  await flush();
  await find(content, 'Render published snapshot in Gum').listeners.click();
  assert.match(content.textContent, /ready/);
  assert.match(content.children.find(child => child.tag === 'p').textContent, /Snapshot/);
  listeners.message({ data: { pluginMessage: { type: 'selection-changed', names: ['Other frame'] } } });
  assert.match(content.textContent, /Source changed/);
  assert.match(content.children.find(child => child.tag === 'p').textContent, /Stale.*Snapshot/);
  globalThis.previewFailure = 'VALIDATION_FAILED at gumcli check: <img src=x onerror=alert(1)> /private/tmp/missing.gumx';
  await find(content, 'Render published snapshot in Gum').listeners.click();
  assert.match(content.textContent, /gumcli check: <img src=x onerror=alert\(1\)> \/private\/tmp\/missing.gumx/);
  assert.equal(content.children.filter(child => child.tag === 'img').length, 1); // retained native preview only
  delete globalThis.previewFailure;
});
