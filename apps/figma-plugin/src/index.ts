import { retainedNamespace, associateNamespace } from './document/namespace.ts';
import { readSelection } from './document/selection.ts';
import { captureSelection, type SourceNode } from './document/extraction.ts';
import { builtinCatalog, loadMappings, saveMapping, aliasesForSelection, resolveMapping } from './document/mappings.ts';
import { BridgeClient } from './transport/bridge-client.ts';
import { bindPageScreen, resolvePageScreen } from './document/page-screens.ts';

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
function postPageScreen(): void {
  if (!metadataAvailable || !associated || !figma.currentPage.id) return;
  try {
    const screen = resolvePageScreen(figma.root, associated, figma.currentPage);
    figma.ui.postMessage({ type: 'page-screen-state', pageId: figma.currentPage.id, pageName: figma.currentPage.name,
      binding: screen ? { frameId: screen.frame.id, frameName: screen.frame.name, alias: screen.mapping.alias } : null,
      diagnostics: [] });
  } catch (error) {
    figma.ui.postMessage({ type: 'page-screen-state', pageId: figma.currentPage.id, pageName: figma.currentPage.name,
      binding: null, diagnostics: [error instanceof Error ? error.message : 'Page binding unavailable'] });
  }
}
type FallbackApproval = { nodeId: string; feature: string; fingerprint: string };
const approvalKey = 'decorativeFallbackApprovalsV1';
function approvals(): FallbackApproval[] {
  try {
    const value: unknown = JSON.parse(figma.root.getPluginData(approvalKey) || '[]');
    return Array.isArray(value) ? value.filter((entry): entry is FallbackApproval =>
      typeof entry === 'object' && entry !== null && typeof entry.nodeId === 'string' &&
      ['effects/strokes', 'decorative-shape'].includes(entry.feature) && typeof entry.fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(entry.fingerprint)) : [];
  } catch { return []; }
}
figma.on('selectionchange', () => { postPageScreen(); figma.ui.postMessage(readSelection()); });
let observedPage = figma.currentPage;
const onNodeChange = () => { postPageScreen(); figma.ui.postMessage({ type: 'source-changed' }); };
observedPage.on('nodechange', onNodeChange);
figma.on('currentpagechange', () => {
  observedPage.off('nodechange', onNodeChange);
  observedPage = figma.currentPage;
  observedPage.on('nodechange', onNodeChange);
  postPageScreen();
  figma.ui.postMessage({ type: 'source-changed' });
});
figma.ui.onmessage = async (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'bind-page-screen') {
    try {
      if (!metadataAvailable || !associated || retainedNamespace(figma.root) !== associated) throw new Error('Associate this design before binding a screen');
      if (!('pageId' in message) || message.pageId !== figma.currentPage.id) throw new Error('Page changed; bind the current page instead');
      if (!('alias' in message) || typeof message.alias !== 'string') throw new Error('Enter a valid screen name');
      bindPageScreen(figma.root, associated, figma.currentPage, message.alias);
      postPageScreen();
    } catch (error) { figma.ui.postMessage({ type: 'page-screen-error', message: error instanceof Error ? error.message : 'Screen binding failed' }); }
    return;
  }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'read-mappings') {
    try {
      if (!metadataAvailable || !associated || retainedNamespace(figma.root) !== associated) throw new Error('Associate this design to read mappings');
      postPageScreen();
      const mappings = loadMappings(figma.root, associated);
      figma.ui.postMessage({ type: 'mapping-state', catalog: builtinCatalog, mappings,
        selectedIds: figma.currentPage.selection.map(node => node.id), selectedTypes: figma.currentPage.selection.map(node => node.type), diagnostics: mappings.filter(m => m.mode === 'generate').flatMap(m => resolveMapping(m, builtinCatalog)) });
    } catch (error) { figma.ui.postMessage({ type: 'mapping-error', message: error instanceof Error ? error.message : 'Mappings unavailable' }); }
    return;
  }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'save-mapping') {
    try {
      if (!metadataAvailable || !associated || retainedNamespace(figma.root) !== associated) throw new Error('Associate this design before mapping');
      const selected = figma.currentPage.selection;
      if (selected.length !== 1 || !['FRAME', 'COMPONENT'].includes(selected[0].type)) throw new Error('Select one frame or component to map');
      if (!('alias' in message) || typeof message.alias !== 'string' || !('controlId' in message) || typeof message.controlId !== 'string') throw new Error('Invalid mapping request');
      const reference = 'mode' in message && message.mode === 'reference';
      if (reference && selected[0].type !== 'COMPONENT') throw new Error('INVALID_CONTROL_CONTRACT: reference mapping requires a component');
      if (reference && (!('workspaceId' in message) || typeof message.workspaceId !== 'string' || message.alias !== message.controlId))
        throw new Error('INVALID_CONTROL_CONTRACT: reference alias must name a registered control in the selected workspace');
      if (reference) {
        const catalog = await new BridgeClient().registeredControls('workspaceId' in message ? message.workspaceId as string : '');
        const control = catalog.controls.find(control => control.controlId === message.controlId);
        if (!control) throw new Error('UNRESOLVED_COMPONENT: target control is not registered');
        if (selected[0].width !== control.width || selected[0].height !== control.height)
          throw new Error('INVALID_CONTROL_CONTRACT: reference placeholder dimensions must match the registered native control');
      }
      const entry = { alias: message.alias, mode: reference ? 'reference' as const : 'generate' as const,
        catalogId: reference ? 'gumbridge.registered' : builtinCatalog.catalogId,
        revision: reference ? '1' : builtinCatalog.revision, controlId: message.controlId };
      if (!reference && entry.controlId !== 'native.frame') throw new Error('INVALID_CONTROL_CONTRACT: generated FRAME or COMPONENT requires native.frame; child text/images follow extraction rules');
      if (!reference) {
        const errors = resolveMapping({ ...entry, nodeId: selected[0].id }, builtinCatalog);
        if (errors.length) throw new Error(errors.join('; '));
      }
      saveMapping(figma.root, associated, selected[0].id, entry);
      figma.ui.postMessage({ type: 'mapping-saved', alias: entry.alias });
    } catch (error) { figma.ui.postMessage({ type: 'mapping-error', message: error instanceof Error ? error.message : 'Mapping failed' }); }
    return;
  }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'associate-namespace' &&
      'mode' in message && (message.mode === 'new' || message.mode === 'continue') &&
      'namespace' in message && typeof message.namespace === 'string') {
    try {
      if (!metadataAvailable) throw new Error('Plugin metadata unavailable: configure a Figma-assigned plugin ID before associating a document.');
      const retained = retainedNamespace(figma.root);
      if (message.mode === 'continue' && retained !== message.namespace) throw new Error('Known namespace does not match retained document metadata');
      associated = associateNamespace(figma.root, message.mode, message.namespace, retained);
      postPageScreen();
      figma.ui.postMessage({ type: 'namespace-associated', namespace: associated });
    } catch (error) {
      figma.ui.postMessage({ type: 'namespace-error', message: error instanceof Error ? error.message : 'Association failed' });
    }
    return;
  }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'approve-decorative-fallback' &&
      'nodeId' in message && typeof message.nodeId === 'string' && 'fingerprint' in message && typeof message.fingerprint === 'string') {
    try {
      if (!metadataAvailable || !associated || retainedNamespace(figma.root) !== associated) throw new Error('Associate this design before approving fallback');
      if ('pageId' in message && message.pageId !== figma.currentPage.id) throw new Error('Page changed; publish again');
      const screen = 'pageId' in message ? resolvePageScreen(figma.root, associated, figma.currentPage) : null;
      const selected = screen ? [screen.frame] : figma.currentPage.selection;
      if (selected.length !== 1) throw new Error('Select one export root');
      const feature = 'feature' in message ? message.feature : 'effects/strokes';
      if (feature !== 'effects/strokes' && feature !== 'decorative-shape') throw new Error('Unsupported fallback feature');
      const current = await captureSelection(selected as unknown as SourceNode[], associated, figma, {}, { [selected[0].id]: 'Review' });
      if (!current.diagnostics.some(d => d.nodeId === message.nodeId && d.property === feature && d.fingerprint === message.fingerprint))
        throw new Error('Source changed; capture again before approving');
      const next = [...approvals().filter(a => a.nodeId !== message.nodeId),
        { nodeId: message.nodeId, feature, fingerprint: message.fingerprint }];
      figma.root.setPluginData(approvalKey, JSON.stringify(next));
      figma.ui.postMessage({ type: 'fallback-approved', nodeId: message.nodeId });
    } catch (error) { figma.ui.postMessage({ type: 'fallback-error', message: error instanceof Error ? error.message : 'Approval failed' }); }
    return;
  }
  if (typeof message !== 'object' || message === null || !('type' in message) ||
      !['capture-publication', 'capture-page-publication'].includes(String(message.type)) ||
      !('namespace' in message) || typeof message.namespace !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.namespace)) return;
  const pageCapture = message.type === 'capture-page-publication';
  if (!pageCapture && (!('alias' in message) || typeof message.alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(message.alias))) return;
  try {
    if (!metadataAvailable) throw new Error('Plugin metadata unavailable: configure a Figma-assigned plugin ID before capture.');
    if (!associated || associated !== message.namespace || retainedNamespace(figma.root) !== associated)
      throw new Error('Choose New design namespace or Continue known design before capture');
    const capturedPage = figma.currentPage;
    if (pageCapture && (!('pageId' in message) || message.pageId !== capturedPage.id)) throw new Error('Page changed; publish the current page instead');
    const pageScreen = pageCapture ? resolvePageScreen(figma.root, associated, capturedPage) : null;
    if (pageCapture && !pageScreen) throw new Error('Bind a screen frame to this page before publishing');
    const selected = pageScreen ? [pageScreen.frame] : capturedPage.selection;
    const publicAlias = pageScreen ? pageScreen.mapping.alias : 'alias' in message ? message.alias : '';
    const mappings = loadMappings(figma.root, associated);
    const aliases = aliasesForSelection(mappings, selected.map(node => node.id));
    if (!selected.length || selected.some(node => node.type !== 'FRAME' || !aliases[node.id]) || aliases[selected[0].id] !== publicAlias)
      throw new Error('Save the public alias for every selected frame in Mappings before publishing');
    const mismatch = mappings.filter(m => selected.some(node => node.id === m.nodeId)).flatMap(m => resolveMapping(m, builtinCatalog));
    if (mismatch.length) throw new Error(mismatch.join('; '));
    if (mappings.some(m => selected.some(node => node.id === m.nodeId) && m.controlId !== 'native.frame'))
      throw new Error('INVALID_CONTROL_CONTRACT: a selected FRAME must map to native.frame');
    const rootMappings = mappings.filter(m => selected.some(node => node.id === m.nodeId)).map(m => ({
      rootId: m.nodeId, mode: 'generate' as const, catalogId: m.catalogId, revision: m.revision, controlId: 'native.frame' as const }));
    const referenceMappings = mappings.filter(m => m.mode === 'reference');
    const catalog = referenceMappings.length && 'workspaceId' in message && typeof message.workspaceId === 'string'
      ? await new BridgeClient().registeredControls(message.workspaceId) : null;
    const componentMappings = Object.fromEntries(mappings.filter(m => !selected.some(node => node.id === m.nodeId))
      .filter(m => m.mode === 'reference' ? m.catalogId === 'gumbridge.registered' && m.revision === '1' &&
        m.controlId === m.alias && catalog?.controls.some(c => c.controlId === m.controlId) :
        m.controlId === 'native.frame' && !resolveMapping(m, builtinCatalog).length)
      .map(m => [m.nodeId, m.mode === 'reference' ? { alias: m.alias, mode: 'reference' as const,
        controlId: m.controlId, targetWidth: catalog!.controls.find(c => c.controlId === m.controlId)!.width,
        targetHeight: catalog!.controls.find(c => c.controlId === m.controlId)!.height } :
        { alias: m.alias, mode: 'generate' as const }]));
    const result = await captureSelection(selected as unknown as SourceNode[], message.namespace, figma, {}, aliases, approvals(), rootMappings, componentMappings);
    if (pageCapture && (figma.currentPage !== capturedPage || associated !== message.namespace || retainedNamespace(figma.root) !== associated))
      throw new Error('Page changed during capture; publish the current page again');
    if (pageCapture && resolvePageScreen(figma.root, associated!, capturedPage)?.frame !== pageScreen?.frame)
      throw new Error('Page screen binding changed during capture; publish again');
    figma.ui.postMessage({ type: 'capture-result', ...('requestId' in message ? { requestId: message.requestId } : {}), result });
  } catch (error) {
    figma.ui.postMessage({ type: 'capture-result', ...('requestId' in message ? { requestId: message.requestId } : {}), result: { snapshot: null, assets: [], diagnostics: [
      { code: 'VALIDATION_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Capture failed' },
    ] } });
  }
};
