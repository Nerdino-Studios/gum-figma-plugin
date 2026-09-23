import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(check) {
  const dir = await mkdtemp(join(tmpdir(), 'gum-figma-setup-'));
  try {
    await cp(join(root, 'manifest.template.json'), join(dir, 'manifest.template.json'));
    await mkdir(join(dir, 'scripts'));
    await cp(join(root, 'scripts/setup-manifest.mjs'), join(dir, 'scripts/setup-manifest.mjs'));
    const source = join(dir, 'figma-generated.json');
    const local = join(dir, 'manifest.json');
    const run = () => execFileSync(process.execPath, [join(dir, 'scripts/setup-manifest.mjs'), source], { cwd: dir, encoding: 'utf8' });
    await check({ dir, source, local, run });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('setup refuses missing and invalid Figma-generated ID without changing local manifest', async () => {
  await fixture(async ({ source, local, run }) => {
    assert.throws(run, /ENOENT|manifest/i);
    await writeFile(source, JSON.stringify({ name: 'New Plugin' }));
    assert.throws(run, /ID/i);
    await writeFile(source, JSON.stringify({ id: '  ' }));
    assert.throws(run, /ID/i);
    await writeFile(source, JSON.stringify({ id: 123 }));
    assert.throws(run, /ID/i);
    await assert.rejects(readFile(local));
  });
});

test('setup imports only assigned ID, preserving repository entry paths and loopback permission; repeated setup is a no-op', async () => {
  await fixture(async ({ source, local, run }) => {
    await writeFile(source, JSON.stringify({ id: '123456789012345678', main: 'other.js', networkAccess: { allowedDomains: ['*'] } }));
    run();
    const text = await readFile(local, 'utf8');
    const expected = JSON.parse(await readFile(join(root, 'manifest.template.json'), 'utf8'));
    assert.deepEqual(JSON.parse(text), { ...expected, id: '123456789012345678' });
    run();
    assert.equal(await readFile(local, 'utf8'), text);
    assert.equal(Object.hasOwn(expected, 'id'), false);
  });
});

test('setup refuses conflicting local ID byte-for-byte', async () => {
  await fixture(async ({ source, local, run }) => {
    const text = JSON.stringify({ ...JSON.parse(await readFile(join(root, 'manifest.template.json'), 'utf8')), id: 'first-id' }) + '\n';
    await writeFile(local, text);
    await writeFile(source, JSON.stringify({ id: 'second-id' }));
    assert.throws(run, /conflict/i);
    assert.equal(await readFile(local, 'utf8'), text);
  });
});

test('startup reports missing plugin identity instead of throwing on private data access', async () => {
  const posts = [];
  globalThis.__html__ = '';
  globalThis.figma = {
    root: { getPluginData: () => { throw Error('Cannot get private plugin data in a plugin without an ID'); } },
    currentPage: { selection: [], on() {}, off() {} }, showUI() {}, on() {},
    ui: { postMessage: message => posts.push(message), onmessage: null },
  };
  await import('../src/index.ts?missing-id-setup');
  assert.equal(posts.at(-1).type, 'plugin-setup-required');
  assert.match(posts.at(-1).message, /Figma.*ID|plugin ID/i);
  await figma.ui.onmessage({ type: 'associate-namespace', mode: 'new', namespace: 'example' });
  assert.equal(posts.at(-1).type, 'namespace-error');
});
