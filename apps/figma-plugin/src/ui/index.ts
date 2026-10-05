import { initialPanel } from './state';
import { isSceneToUi } from '../transport/messages';
import { BridgeClient, type Workspace, type RegisteredControl } from '../transport/bridge-client';

const bridge = new BridgeClient();
const navigation = document.querySelector<HTMLElement>('#navigation')!;
const content = document.querySelector<HTMLElement>('#content')!;
let active: 'connection' | 'publish' = 'publish';
let connecting = false, connected = false, busy = false, associated = false, setupRequired = false;
let connectionStatus = 'Connecting to local Gum bridge…';
let publicationStatus = 'Bind this page to a screen frame once, then publish the whole screen to FRB2.';
let workspaces: Workspace[] = [], workspaceId: string | undefined;
let registeredControls: RegisteredControl[] = [];
let namespace = '', retained: string | null = null, selectedAlias = '', selectedType = '';
let selectedIds: string[] = [];
let pageId = '', pageName = '';
let binding: { frameId: string; frameName: string; alias: string } | null = null;
let bindingError = '', mappingStatus = '', revision = 0, sequence = 0;
let currentOperation = 0;
let pending: { requestId: string; operation: number; pageId: string; workspaceId: string; revision: number; alias: string } | undefined;
let fallbackCandidate: { nodeId: string; property: string; fingerprint: string; message: string } | undefined;

function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button'; element.textContent = label; element.disabled = disabled;
  element.addEventListener('click', action);
  return element;
}
function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement('p'); element.textContent = text; return element;
}
function invalidate(): void {
  revision++;
  if (busy) publicationStatus = 'Source changed — publish again before running the updated screen.';
}
async function refreshControls(target: string): Promise<void> {
  registeredControls = [];
  try {
    const catalog = await bridge.registeredControls(target);
    if (workspaceId === target && connected) registeredControls = catalog.controls;
  } catch { /* A screen can still generate when existing references are unavailable. */ }
  render();
}
async function connect(): Promise<void> {
  if (connecting || busy) return;
  connecting = true; connectionStatus = 'Connecting to local Gum bridge…'; render();
  try {
    workspaces = (await bridge.workspaces()).workspaces;
    if (!workspaces.some(item => item.id === workspaceId)) workspaceId = workspaces[0]?.id;
    connected = true;
    connectionStatus = workspaces.length ? 'Connected to local Gum bridge.'
      : 'Connected; no workspaces registered. Run gumbridge sample init --directory <new-absolute-directory> locally, then reconnect.';
    registeredControls = [];
    if (workspaceId) await refreshControls(workspaceId);
  } catch { connected = false; connectionStatus = 'Offline — start gumbridge serve locally, then click Reconnect to local bridge.'; }
  connecting = false; render();
}
function associateNew(): void {
  try {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error('No suitable random source');
    for (let attempt = 0; attempt < 3; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const next = 'design-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      if (next === retained) continue;
      parent.postMessage({ pluginMessage: { type: 'associate-namespace', mode: 'new', namespace: next } }, '*'); return;
    }
  } catch { /* Report unavailable identity rather than inventing a namespace. */ }
  publicationStatus = 'Namespace unavailable: could not create a distinct namespace.'; render();
}
function publish(): void {
  if (busy || !connected || !workspaceId || !associated || !binding || !pageId || bindingError) return;
  const operation = ++sequence;
  currentOperation = operation;
  pending = { requestId: String(operation), operation, pageId, workspaceId, revision, alias: binding.alias };
  busy = true; fallbackCandidate = undefined; publicationStatus = `Capturing ${binding.alias}…`; render();
  parent.postMessage({ pluginMessage: { type: 'capture-page-publication', requestId: pending.requestId, pageId, namespace, workspaceId } }, '*');
}
function render(): void {
  navigation.replaceChildren();
  for (const tab of initialPanel().tabs) {
    const item = button(tab.title, () => { active = tab.key; render(); });
    item.setAttribute('aria-current', active === tab.key ? 'page' : 'false'); navigation.append(item);
  }
  content.textContent = setupRequired ? publicationStatus : active === 'connection' ? connectionStatus : publicationStatus;
  if (setupRequired) return;
  if (active === 'connection') {
    content.append(button(connected ? 'Reconnect to local bridge' : 'Connect to local bridge', () => void connect(), connecting || busy));
    if (workspaces.length) {
      const picker = document.createElement('select'); picker.setAttribute('aria-label', 'Publication workspace');
      for (const workspace of workspaces) {
        const option = document.createElement('option'); option.value = workspace.id; option.textContent = workspace.label; picker.append(option);
      }
      picker.value = workspaceId ?? ''; picker.disabled = busy;
      picker.addEventListener('change', () => {
        if (busy) { render(); return; }
        if (workspaceId !== picker.value) {
          workspaceId = picker.value; registeredControls = []; invalidate();
          publicationStatus = 'Workspace changed — publish this page to the selected workspace.';
          if (workspaceId && connected) void refreshControls(workspaceId);
        }
        render();
      });
      content.append(paragraph(`Target: ${workspaces.find(item => item.id === workspaceId)?.label ?? 'Choose a workspace'}`), picker);
    }
    return;
  }
  content.append(paragraph(pageName ? `Page: ${pageName}` : 'Open the page containing your screen design.'));
  if (!associated) {
    content.append(paragraph(retained ? 'Continue this known design, or create a new association for a copied document.' : 'Associate this document once to keep screen names stable.'),
      button('New design namespace', associateNew), button('Continue known design', () => {
        parent.postMessage({ pluginMessage: { type: 'associate-namespace', mode: 'continue', namespace: retained } }, '*');
      }, !retained));
    return;
  }
  if (binding) content.append(paragraph(`Screen: ${binding.alias} · Frame: ${binding.frameName}`));
  else {
    content.append(paragraph(bindingError || 'Select one top-level frame to use as this page’s screen.'));
    const name = document.createElement('input'); name.setAttribute('aria-label', 'Screen name');
    name.placeholder = 'Screen name'; name.value = selectedAlias;
    content.append(name, button('Bind selected frame to page', () => {
      parent.postMessage({ pluginMessage: { type: 'bind-page-screen', pageId, alias: name.value.trim() } }, '*');
    }, busy || selectedIds.length !== 1 || selectedType !== 'FRAME' || !pageId));
  }
  if (!connected || !workspaceId) content.append(paragraph(connected ? 'Choose a registered workspace in Connection.' : 'Connect to the local bridge to publish. Screen binding works offline.'));
  content.append(button('Publish', publish, busy || !binding || !!bindingError || !connected || !workspaceId));
  if (fallbackCandidate) {
    content.append(button(`Approve decorative PNG fallback for ${fallbackCandidate.nodeId} (loses editability and resolution independence)`, () => {
      if (!fallbackCandidate) return;
      parent.postMessage({ pluginMessage: { type: 'approve-decorative-fallback', pageId, nodeId: fallbackCandidate.nodeId, feature: fallbackCandidate.property, fingerprint: fallbackCandidate.fingerprint } }, '*');
      fallbackCandidate = undefined; publicationStatus = 'Checking scoped fallback approval…'; render();
    }, busy));
  }
  if (selectedIds.length === 1 && selectedType === 'COMPONENT') {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Component mappings'; details.append(summary);
    const name = document.createElement('input'); name.setAttribute('aria-label', 'Stable public alias'); name.placeholder = 'Public alias'; name.value = selectedAlias;
    const control = document.createElement('select'); control.setAttribute('aria-label', 'Catalog control');
    const generated = document.createElement('option'); generated.value = 'native.frame'; generated.textContent = 'Generate component'; control.append(generated);
    for (const registered of registeredControls) {
      const option = document.createElement('option'); option.value = `reference:${registered.controlId}`; option.textContent = `Reference existing: ${registered.controlId}`; control.append(option);
    }
    control.value = 'native.frame';
    details.append(paragraph(mappingStatus), name, control, button('Save mapping', () => {
      const reference = control.value.startsWith('reference:');
      parent.postMessage({ pluginMessage: reference ? { type: 'save-mapping', alias: name.value.trim(), controlId: control.value.slice(10), mode: 'reference', workspaceId }
        : { type: 'save-mapping', alias: name.value.trim(), controlId: 'native.frame' } }, '*');
    }, busy));
    content.append(details);
  }
}
window.addEventListener('message', event => {
  const message = event.data?.pluginMessage;
  if (typeof message !== 'object' || message === null) return;
  if (message.type === 'plugin-setup-required') { setupRequired = true; publicationStatus = `Setup required: ${String(message.message)}`; render(); return; }
  if (message.type === 'namespace-association') {
    retained = typeof message.retained === 'string' ? message.retained : null;
    associated = false; namespace = ''; binding = null; pending = undefined; busy = false; currentOperation = ++sequence; render(); return;
  }
  if (message.type === 'namespace-associated' && typeof message.namespace === 'string') {
    namespace = message.namespace; retained = namespace; associated = true; binding = null; invalidate();
    parent.postMessage({ pluginMessage: { type: 'read-mappings' } }, '*'); render(); return;
  }
  if (message.type === 'page-screen-state' && typeof message.pageId === 'string' && typeof message.pageName === 'string') {
    const nextBinding = message.binding && typeof message.binding.frameId === 'string' && typeof message.binding.frameName === 'string' && typeof message.binding.alias === 'string' ? message.binding : null;
    const changedPage = pageId && pageId !== message.pageId;
    if (changedPage || binding?.frameId !== nextBinding?.frameId || binding?.alias !== nextBinding?.alias) {
      invalidate();
      if (changedPage) { pending = undefined; busy = false; currentOperation = ++sequence; publicationStatus = 'Bind this page to a screen frame, then publish.'; fallbackCandidate = undefined; }
    }
    pageId = message.pageId; pageName = message.pageName; binding = nextBinding;
    bindingError = Array.isArray(message.diagnostics) ? message.diagnostics.filter((value: unknown) => typeof value === 'string').join('; ') : '';
    render(); return;
  }
  if (message.type === 'page-screen-error' || message.type === 'namespace-error') { publicationStatus = String(message.message); render(); return; }
  if (message.type === 'mapping-state' && Array.isArray(message.selectedIds) && Array.isArray(message.mappings)) {
    selectedIds = message.selectedIds.filter((value: unknown) => typeof value === 'string');
    selectedType = Array.isArray(message.selectedTypes) ? message.selectedTypes[0] ?? '' : '';
    const mapping = message.mappings.find((item: { nodeId: string }) => item.nodeId === selectedIds[0]);
    selectedAlias = typeof mapping?.alias === 'string' ? mapping.alias : '';
    mappingStatus = Array.isArray(message.diagnostics) ? message.diagnostics.join('; ') : ''; render(); return;
  }
  if (message.type === 'mapping-saved') {
    invalidate(); mappingStatus = `Saved stable alias ${String(message.alias)}.`;
    parent.postMessage({ pluginMessage: { type: 'read-mappings' } }, '*'); render(); return;
  }
  if (message.type === 'mapping-error') { mappingStatus = String(message.message); render(); return; }
  if (message.type === 'source-changed') {
    invalidate(); publicationStatus = 'Source changed — publish again to run the updated screen.'; render(); return;
  }
  if (message.type === 'fallback-approved' || message.type === 'fallback-error') {
    publicationStatus = message.type === 'fallback-approved' ? 'Decorative fallback approved. Publish again.' : String(message.message); render(); return;
  }
  if (message.type === 'capture-result') {
    const capture = pending;
    if (!capture || message.requestId !== capture.requestId) return;
    pending = undefined;
    const result = message.result;
    const current = () => currentOperation === capture.operation && pageId === capture.pageId && workspaceId === capture.workspaceId;
    if (!current()) return;
    if (!result?.snapshot || !Array.isArray(result.diagnostics) || result.diagnostics.length) {
      busy = false;
      const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
      fallbackCandidate = diagnostics.find((item: { property?: string; fingerprint?: string; nodeId?: string; message?: string }) => ['effects/strokes', 'decorative-shape'].includes(item.property ?? '') && item.fingerprint && item.nodeId && item.message?.startsWith('Decorative raster fallback'));
      publicationStatus = `Unpublished: ${diagnostics.map((item: { nodeId?: string; property?: string; message: string }) => `${item.nodeId ? `${item.nodeId}${item.property ? ` · ${item.property}` : ''}: ` : ''}${item.message}`).join('; ') || 'Capture unavailable'}`; render(); return;
    }
    publicationStatus = 'Publishing the captured screen…'; render();
    void (async () => {
      let published = false;
      try {
        if (revision !== capture.revision) throw new Error('Source changed — publish again.');
        const receipt = await bridge.publish(capture.workspaceId, { snapshot: result.snapshot, assets: result.assets });
        published = true;
        if (!current()) return;
        if (revision !== capture.revision) throw new Error('Source changed — publish again.');
        if (receipt.status !== 'published') throw new Error('The published snapshot is blocked; resolve its diagnostics first.');
        publicationStatus = `Published ${capture.alias}. Starting FRB2…`; render();
        const runtime = await bridge.run(capture.workspaceId, receipt.snapshotId);
        if (!current()) return;
        publicationStatus = revision !== capture.revision ? 'Source changed — publish again to update FRB2.'
          : `Running in FRB2: ${capture.alias}. Snapshot ${receipt.snapshotId}; output ${runtime.outputHash}. Staged runtime; target files unchanged.`;
      } catch (error) {
        if (current()) publicationStatus = `${published ? 'Published; launch unavailable' : 'Unpublished'}: ${error instanceof Error ? error.message : 'Bridge unavailable'}`;
      } finally { if (current()) { busy = false; render(); } }
    })();
    return;
  }
  if (isSceneToUi(message)) {
    if (associated) parent.postMessage({ pluginMessage: { type: 'read-mappings' } }, '*');
    render();
  }
});
render();
void connect();
