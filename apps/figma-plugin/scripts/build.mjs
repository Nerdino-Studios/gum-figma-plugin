import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
await mkdir(dist, { recursive: true });
await build({ entryPoints: [new URL('src/index.ts', root).pathname], outfile: new URL('code.js', dist).pathname,
  bundle: true, platform: 'browser', target: 'es2022', format: 'iife' });
const ui = await build({ entryPoints: [new URL('src/ui/index.ts', root).pathname], bundle: true,
  platform: 'browser', target: 'es2022', format: 'iife', write: false });
const template = await readFile(new URL('src/ui/index.html', root), 'utf8');
const bundle = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(new URL('ui.html', dist), template.replace('/* UI_BUNDLE */', bundle));
const manifestUrl = new URL('manifest.json', root);
const templateUrl = new URL('manifest.template.json', root);
try {
  await copyFile(templateUrl, manifestUrl, constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
// Preserve Figma's locally assigned ID. Upgrade only the previous known development
// endpoint; never silently replace user-maintained network permissions.
const localText = await readFile(manifestUrl, 'utf8');
const local = JSON.parse(localText);
const network = local.networkAccess;
const allowed = network?.allowedDomains;
const domains = network?.devAllowedDomains;
if (JSON.stringify(allowed) !== '["none"]' ||
    !Array.isArray(domains) || domains.length !== 1 ||
    !['http://127.0.0.1:48931', 'http://localhost:48931'].includes(domains[0])) {
  throw new Error('Local manifest network permissions differ from the supported template. Preserve its ID and set networkAccess to {"allowedDomains":["none"],"devAllowedDomains":["http://localhost:48931"]} before importing.');
}
if (domains[0] !== 'http://localhost:48931') {
  network.devAllowedDomains = ['http://localhost:48931'];
  await writeFile(manifestUrl, JSON.stringify(local, null, 2) + '\n');
}
console.log('Built dist/code.js and dist/ui.html; import manifest.json as a development plugin.');
