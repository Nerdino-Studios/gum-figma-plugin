import { builtinCatalog, loadMappings, resolveMapping, saveMapping } from './mappings.ts';

type Root = { getPluginData(key: string): string; setPluginData(key: string, value: string): void };
type Node = { id: string; name: string; type: string };
type Page<T extends Node> = { id: string; children: readonly T[]; selection: readonly Node[] };

// Page identity is local mapping metadata. The existing frame remains the canonical
// snapshot root, so conversion and wire contracts need no second page interpretation.
export function resolvePageScreen<T extends Node>(root: Root, namespace: string, page: Page<T>) {
  const mapping = loadMappings(root, namespace).find(entry => entry.pageId === page.id);
  if (!mapping) return null;
  const frame = page.children.find(node => node.id === mapping.nodeId && node.type === 'FRAME');
  if (!frame) throw new Error('Bound screen frame is missing or moved. Restore it before publishing this page.');
  const diagnostics = resolveMapping(mapping, builtinCatalog);
  if (diagnostics.length) throw new Error(diagnostics.join('; '));
  return { mapping, frame };
}

export function bindPageScreen<T extends Node>(root: Root, namespace: string, page: Page<T>, alias: string) {
  const selected = page.selection;
  if (selected.length !== 1 || selected[0].type !== 'FRAME' || !page.children.some(node => node === selected[0]))
    throw new Error('Select one top-level frame on this page to bind as its screen.');
  const existing = loadMappings(root, namespace);
  if (existing.some(entry => entry.pageId === page.id && entry.nodeId !== selected[0].id))
    throw new Error('This page is already bound to another frame; the existing screen binding was preserved.');
  if (existing.some(entry => entry.nodeId === selected[0].id && entry.pageId && entry.pageId !== page.id))
    throw new Error('This frame is already bound to another page; its binding was preserved.');
  saveMapping(root, namespace, selected[0].id, { alias, pageId: page.id, mode: 'generate',
    catalogId: builtinCatalog.catalogId, revision: builtinCatalog.revision, controlId: 'native.frame' });
  return resolvePageScreen(root, namespace, page)!;
}
