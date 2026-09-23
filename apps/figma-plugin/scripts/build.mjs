import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

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
console.log('Built dist/code.js and dist/ui.html; import manifest.template.json as a development plugin.');
