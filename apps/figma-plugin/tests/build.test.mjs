import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function withPluginBuild(check) {
  const dir = await mkdtemp(join(tmpdir(), 'gum-figma-manifest-'));
  try {
    for (const name of ['scripts', 'src', 'manifest.template.json']) {
      await cp(join(root, name), join(dir, name), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const build = () => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir });
    await check(dir, build);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('fresh build generates a Figma-importable manifest basename and build artifacts without an invented ID', async () => {
  await withPluginBuild(async (dir, build) => {
    build();
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.editorType, ['figma']);
    assert.deepEqual(manifest.networkAccess, { allowedDomains: ['none'], devAllowedDomains: ['http://localhost:48931'] });
    assert.equal(manifest.documentAccess, 'dynamic-page');
    assert.equal(Object.hasOwn(manifest, 'id'), false);
    assert.equal(manifest.main, 'dist/code.js');
    assert.equal(manifest.ui, 'dist/ui.html');
    const scene = await readFile(join(dir, manifest.main), 'utf8');
    const ui = await readFile(join(dir, manifest.ui), 'utf8');
    assert.match(scene, /showUI/);
    assert.match(ui, /Selection/);
    assert.match(ui, /Preview and changes/);
    assert.match(ui, /Pair and request workspaces/);
    assert.match(ui, /v1\/pair/);
    assert.doesNotMatch(scene, /v1\/pair|Bearer /);
    assert.doesNotMatch(ui, /UI_BUNDLE/);
  });
});

test('rebuild upgrades only the known stale loopback permission and preserves local ID', async () => {
  await withPluginBuild(async (dir, build) => {
    const previous = JSON.parse(await readFile(join(dir, 'manifest.template.json'), 'utf8'));
    previous.id = 'figma-assigned-id';
    previous.networkAccess.devAllowedDomains = ['http://127.0.0.1:48931'];
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(previous));
    build();
    const updated = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(updated.id, previous.id);
    assert.deepEqual(updated.networkAccess, { allowedDomains: ['none'], devAllowedDomains: ['http://localhost:48931'] });
  });
});

test('rebuild preserves an existing current local Figma-assigned manifest byte for byte', async () => {
  await withPluginBuild(async (dir, build) => {
    const current = JSON.parse(await readFile(join(dir, 'manifest.template.json'), 'utf8'));
    current.id = 'figma-assigned-id';
    const local = JSON.stringify(current) + '\n';
    await writeFile(join(dir, 'manifest.json'), local);
    build();
    build();
    assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), local);
  });
});
