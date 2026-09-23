import { retainedNamespace, associateNamespace } from './document/namespace.ts';
import { readSelection } from './document/selection.ts';
import { captureCurrentSelection } from './document/extraction.ts';

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });
figma.ui.postMessage(readSelection());
let metadataAvailable = true;
try {
  figma.ui.postMessage({ type: 'namespace-association', retained: retainedNamespace(figma.root) });
} catch (error) {
  metadataAvailable = false;
  figma.ui.postMessage({ type: 'plugin-setup-required', message: error instanceof Error && /plugin without an ID/i.test(error.message)
    ? 'This development plugin needs a Figma-assigned plugin ID. Create a New Plugin in Figma, then run npm run setup:manifest --prefix apps/figma-plugin -- /path/to/figma/manifest.json; rebuild and reimport apps/figma-plugin/manifest.json.'
    : 'Plugin metadata is unavailable. Check your development plugin ID and reimport the local manifest.' });
}
let associated: string | null = null;
figma.on('selectionchange', () => figma.ui.postMessage(readSelection()));
let observedPage = figma.currentPage;
const onNodeChange = () => figma.ui.postMessage({ type: 'source-changed' });
observedPage.on('nodechange', onNodeChange);
figma.on('currentpagechange', () => {
  observedPage.off('nodechange', onNodeChange);
  observedPage = figma.currentPage;
  observedPage.on('nodechange', onNodeChange);
  figma.ui.postMessage({ type: 'source-changed' });
});
figma.ui.onmessage = async (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'associate-namespace' &&
      'mode' in message && (message.mode === 'new' || message.mode === 'continue') &&
      'namespace' in message && typeof message.namespace === 'string') {
    try {
      if (!metadataAvailable) throw new Error('Plugin metadata unavailable: configure a Figma-assigned plugin ID before associating a document.');
      const retained = retainedNamespace(figma.root);
      if (message.mode === 'continue' && retained !== message.namespace) throw new Error('Known namespace does not match retained document metadata');
      associated = associateNamespace(figma.root, message.mode, message.namespace, retained);
      figma.ui.postMessage({ type: 'namespace-associated', namespace: associated });
    } catch (error) {
      figma.ui.postMessage({ type: 'namespace-error', message: error instanceof Error ? error.message : 'Association failed' });
    }
    return;
  }
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'capture-publication' ||
      !('namespace' in message) || typeof message.namespace !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.namespace) ||
      !('alias' in message) || typeof message.alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(message.alias)) return;
  try {
    if (!metadataAvailable) throw new Error('Plugin metadata unavailable: configure a Figma-assigned plugin ID before capture.');
    if (!associated || associated !== message.namespace || retainedNamespace(figma.root) !== associated)
      throw new Error('Choose New design namespace or Continue known design before capture');
    const selected = figma.currentPage.selection;
    const aliases = selected.length === 1 ? { [selected[0].id]: message.alias } : {};
    const result = await captureCurrentSelection(message.namespace, aliases);
    figma.ui.postMessage({ type: 'capture-result', result });
  } catch (error) {
    figma.ui.postMessage({ type: 'capture-result', result: { snapshot: null, assets: [], diagnostics: [
      { code: 'VALIDATION_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Capture failed' },
    ] } });
  }
};
