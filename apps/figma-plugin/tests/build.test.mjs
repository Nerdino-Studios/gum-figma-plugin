import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
test('development manifest and both build artifacts are loadable without an invented ID', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
  const manifest = JSON.parse(await readFile(new URL('manifest.template.json', root), 'utf8'));
  assert.deepEqual(manifest.editorType, ['figma']);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.equal(Object.hasOwn(manifest, 'id'), false);
  const scene = await readFile(new URL(manifest.main, root), 'utf8');
  const ui = await readFile(new URL(manifest.ui, root), 'utf8');
  assert.match(scene, /showUI/);
  assert.match(ui, /Selection/);
  assert.match(ui, /Preview and changes/);
  assert.doesNotMatch(ui, /UI_BUNDLE/);
});
