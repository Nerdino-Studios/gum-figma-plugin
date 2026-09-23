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
try {
  await copyFile(new URL('manifest.template.json', root), new URL('manifest.json', root), constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
console.log('Built dist/code.js and dist/ui.html; import manifest.json as a development plugin.');
