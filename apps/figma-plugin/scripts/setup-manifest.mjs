import { readFile, writeFile, open } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const localUrl = new URL('manifest.json', root);
const template = JSON.parse(await readFile(new URL('manifest.template.json', root), 'utf8'));
const [sourcePath, extra] = process.argv.slice(2);
if (!sourcePath || extra) throw new Error('Usage: npm run setup:manifest -- /path/to/Figma/New-Plugin/manifest.json');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
if (!validId(source?.id)) throw new Error('Figma-generated manifest must contain a nonempty valid plugin ID. Create a New Plugin in Figma first.');
let local;
try { local = await readFile(localUrl, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (local !== undefined) {
  const existing = JSON.parse(local);
  if (existing.id !== undefined && existing.id !== source.id) throw new Error('Plugin ID conflict: local manifest already has a different ID; refusing to replace it.');
  // Leave existing permissions and entry paths untouched; build validates supported permissions.
  if (existing.id === source.id) { console.log('Local plugin ID already configured; no changes.'); process.exit(0); }
  if (JSON.stringify(existing) !== JSON.stringify(template)) throw new Error('Local manifest differs from template; refusing to replace it.');
  await writeFile(localUrl, JSON.stringify({ ...template, id: source.id }, null, 2) + '\n');
} else {
  // Exclusive creation prevents overwriting a manifest created by another setup process.
  const handle = await open(localUrl, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ ...template, id: source.id }, null, 2) + '\n'); }
  finally { await handle.close(); }
}
console.log('Local development plugin ID configured. Run npm run build --prefix apps/figma-plugin.');
