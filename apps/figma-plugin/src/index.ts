import { retainedNamespace, associateNamespace } from './document/namespace.ts';
import { readSelection } from './document/selection.ts';
import { captureCurrentSelection } from './document/extraction.ts';

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });
figma.ui.postMessage(readSelection());
figma.ui.postMessage({ type: 'namespace-association', retained: retainedNamespace(figma.root) });
let associated: string | null = null;
figma.on('selectionchange', () => figma.ui.postMessage(readSelection()));
figma.ui.onmessage = async (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'associate-namespace' &&
      'mode' in message && (message.mode === 'new' || message.mode === 'continue') &&
      'namespace' in message && typeof message.namespace === 'string') {
    try {
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
