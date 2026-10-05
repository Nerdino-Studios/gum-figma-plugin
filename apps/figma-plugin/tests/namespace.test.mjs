import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retainedNamespace, associateNamespace } from '../src/document/namespace.ts';

test('document namespace persists across launches but requires explicit continued association', async () => {
  const data = new Map();
  const root = { getPluginData: key => data.get(key) ?? '', setPluginData: (key, value) => data.set(key, value) };
  const posts = [];
  globalThis.__html__ = '';
  globalThis.figma = {
    root, currentPage: { selection: [], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null },
  };
  await import('../src/index.ts?launch=1');
  assert.equal(posts.at(-1).retained, null);
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'new-design' });
  assert.equal(retainedNamespace(root), 'new-design');
  assert.equal(posts.at(-1).namespace, 'new-design');
  posts.length = 0;
  await import('../src/index.ts?launch=2');
  assert.equal(posts.at(-1).retained, 'new-design');
  await figma.ui.onmessage({ type: 'capture-publication', namespace: 'new-design', alias: 'Main' });
  assert.equal(posts.at(-1).result.snapshot, null); // no silent claim of copied metadata
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'continue', namespace: 'wrong' });
  assert.equal(posts.at(-1).type, 'namespace-error');
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'continue', namespace: 'new-design' });
  assert.equal(posts.at(-1).namespace, 'new-design');
  assert.throws(() => associateNamespace(root, 'new', 'new-design', retainedNamespace(root)), /distinct/);
});
