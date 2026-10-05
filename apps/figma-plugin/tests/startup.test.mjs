import { test } from 'node:test';
import assert from 'node:assert/strict';

test('dynamic-page startup observes only active page and switches listener on navigation', async () => {
  const events = new Map();
  const makePage = () => {
    const handlers = new Map();
    return { selection: [], on: (type, fn) => handlers.set(type, fn), off: (type, fn) => {
      assert.equal(handlers.get(type), fn); handlers.delete(type);
    }, handlers };
  };
  const first = makePage(); const second = makePage();
  const posts = [];
  globalThis.__html__ = '';
  globalThis.figma = { root: { getPluginData: () => '' }, currentPage: first, showUI() {},
    on: (type, fn) => { assert.notEqual(type, 'documentchange'); events.set(type, fn); },
    loadAllPagesAsync: () => { throw Error('must not load unrelated pages'); },
    ui: { postMessage: message => posts.push(message), onmessage: null } };
  await import('../src/index.ts?dynamic-page-startup');
  assert.equal(typeof figma.ui.onmessage, 'function');
  first.handlers.get('nodechange')({ nodeChanges: [] });
  assert.equal(posts.at(-1).type, 'source-changed');
  figma.currentPage = second;
  events.get('currentpagechange')();
  assert.equal(first.handlers.size, 0);
  assert.equal(second.handlers.size, 1);
  assert.equal(posts.at(-1).type, 'source-changed');
});
