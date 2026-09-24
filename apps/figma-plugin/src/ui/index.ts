import { initialPanel, selectionPanel, type ViewKey } from './state';
import { isSceneToUi } from '../transport/messages';
import { BridgeClient, type Workspace } from '../transport/bridge-client';
import { hashBytes } from '../hash';
import { builtinCatalog } from '../document/mappings';

const bridge = new BridgeClient();
let connectionStatus = 'Connecting to local Gum bridge…';
let workspaceId: string | undefined;
let workspaces: Workspace[] = [];
let connecting = false;
async function connect(): Promise<void> {
  if (connecting) return;
  connecting = true;
  connectionStatus = 'Connecting to local Gum bridge…'; render();
  try {
    const result = await bridge.workspaces();
    workspaces = result.workspaces;
    if (!workspaces.some(item => item.id === workspaceId)) {
      if (workspaceId) { stale = true; publishedId = undefined; }
      workspaceId = workspaces[0]?.id;
    }
    connectionStatus = workspaces.length
      ? `Connected to local Gum bridge. Publishing to ${workspaces.find(item => item.id === workspaceId)?.label} (${workspaceId}). Select a workspace below.`
      : 'Connected; no workspaces registered. Run gumbridge sample init --directory <new-absolute-directory> locally, then reconnect.';
  } catch {
    connectionStatus = 'Offline — start gumbridge serve locally, then click Reconnect to local bridge. Publication and preview unavailable.';
  }
  connecting = false; render();
}
let namespace = '';
let retained: string | null = null;
let associated = false;
let setupRequired = false;
let busy = false;
let alias = '';
let mappingStatus = 'Associate a design namespace to edit mappings.';
let selectedIds: string[] = [];
let publicationStatus = 'Unpublished — select a frame and workspace, then capture and publish.';
let publishedId: string | undefined;
let previewUrl: string | undefined;
let previewIdentity = '';
let stale = false;
let sourceRevision = 0;
let captureRevision = 0;
let captureWorkspace: string | undefined;
let publishedStale = false;
let fallbackCandidate: { nodeId: string; fingerprint: string; message: string } | undefined;

const panel = initialPanel();
let active: ViewKey = 'selection';
const navigation = document.querySelector<HTMLElement>('#navigation')!;
const content = document.querySelector<HTMLElement>('#content')!;

function render(): void {
  navigation.replaceChildren();
  for (const tab of panel.tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tab.title;
    button.setAttribute('aria-current', active === tab.key ? 'page' : 'false');
    button.addEventListener('click', () => { active = tab.key; render(); });
    navigation.append(button);
  }
  content.textContent = setupRequired ? publicationStatus : active === 'connection' ? connectionStatus : active === 'preview' ? publicationStatus : panel[active];
  if (setupRequired) return;
  if (active === 'mappings') {
    const intro = document.createElement('p');
    intro.textContent = `${builtinCatalog.catalogId}@${builtinCatalog.revision} (offline). ${mappingStatus}`;
    content.append(intro);
    for (const control of builtinCatalog.controls) {
      const item = document.createElement('p');
      item.textContent = `${control.label}: ${control.available ? `available (${control.properties.join(', ')})` : 'adapter pending; unavailable'}`;
      content.append(item);
    }
    if (associated && selectedIds.length === 1) {
      const name = document.createElement('input');
      name.setAttribute('aria-label', 'Stable public alias');
      name.placeholder = 'Public alias'; name.value = alias;
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Catalog control');
      for (const control of builtinCatalog.controls) {
        const option = document.createElement('option');
        option.value = control.id; option.textContent = control.label; option.disabled = control.id !== 'native.frame';
        select.append(option);
      }
      select.value = 'native.frame';
      const save = document.createElement('button');
      save.textContent = 'Save mapping';
      save.addEventListener('click', () => {
        alias = name.value.trim();
        parent.postMessage({ pluginMessage: { type: 'save-mapping', alias, controlId: select.value } }, '*');
      });
      content.append(name, select, save);
    }
  }
  if (active === 'preview' && fallbackCandidate) {
    const approval = document.createElement('button');
    approval.textContent = `Approve decorative PNG fallback for ${fallbackCandidate.nodeId} (loses editability and resolution independence)`;
    approval.addEventListener('click', () => {
      if (!fallbackCandidate) return;
      parent.postMessage({ pluginMessage: { type: 'approve-decorative-fallback', nodeId: fallbackCandidate.nodeId, fingerprint: fallbackCandidate.fingerprint } }, '*');
      fallbackCandidate = undefined;
      publicationStatus = 'Checking scoped fallback approval…'; render();
    });
    content.append(approval);
  }
  if (active === 'preview' && previewUrl) {
    const identity = document.createElement('p');
    identity.textContent = `${stale ? 'Stale — source or workspace changed. ' : ''}${previewIdentity}`;
    const image = document.createElement('img');
    image.src = previewUrl; image.alt = 'Native Gum staged preview'; image.style.maxWidth = '100%';
    content.append(identity, image);
  }
  if (active === 'preview' || active === 'mappings') {
    if (active === 'preview' && workspaceId && publishedId) {
      const preview = document.createElement('button');
      preview.textContent = 'Render published snapshot in Gum';
      preview.disabled = busy;
      preview.addEventListener('click', async () => {
        if (busy || !workspaceId || !publishedId) return;
        const revision = sourceRevision;
        const requestedWorkspace = workspaceId;
        const requestedSnapshot = publishedId;
        busy = true; publicationStatus = 'Rendering staged Gum preview…'; render();
        try {
          const result = await bridge.preview(requestedWorkspace, requestedSnapshot);
          if (workspaceId !== requestedWorkspace || publishedId !== requestedSnapshot) throw new Error('Preview request superseded by a different publication or workspace.');
          if (hashBytes(new Uint8Array(result.png)) !== result.outputHash || !result.png.slice(0, 8).every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i])) throw new Error('Preview PNG output hash mismatch.');
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(new Blob([new Uint8Array(result.png)], { type: 'image/png' }));
          previewIdentity = `Snapshot ${requestedSnapshot}; target ${result.targetHash}; output ${result.outputHash}; artifact ${result.artifactId}. Staged only — target unchanged.`;
          stale = publishedStale || sourceRevision !== revision;
          publicationStatus = stale ? 'Source changed during preview — republish before treating it as current.' : 'Native Gum preview ready (not applied or runtime verified).';
        } catch (error) { stale = true; publicationStatus = `Preview unavailable: ${error instanceof Error ? error.message : 'Bridge offline'}`; }
        busy = false; render();
      });
      content.append(preview);
    }
    if (!associated) {
      const note = document.createElement('p');
      note.textContent = retained ? `Retained namespace: ${retained}. Choose how to associate this document (copies may retain metadata).` : 'Choose a namespace association for this document.';
      const newButton = document.createElement('button');
      newButton.textContent = 'New design namespace';
      newButton.addEventListener('click', () => {
        if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
          publicationStatus = 'Namespace unavailable: this iframe has no suitable random source.';
          render();
          return;
        }
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            const next = 'design-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            if (next === retained) continue;
            parent.postMessage({ pluginMessage: { type: 'associate-namespace', mode: 'new', namespace: next } }, '*');
            return;
          }
        } catch { /* No usable random bytes; report the failure in the panel. */ }
        publicationStatus = 'Namespace unavailable: could not create a distinct namespace.';
        render();
      });
      const continueButton = document.createElement('button');
      continueButton.textContent = 'Continue known design';
      continueButton.disabled = !retained;
      continueButton.addEventListener('click', () => {
        parent.postMessage({ pluginMessage: { type: 'associate-namespace', mode: 'continue', namespace: retained } }, '*');
      });
      content.append(note, newButton, continueButton);
      return;
    }
    if (active === 'mappings' || !workspaceId) return;
    const identity = document.createElement('input');
    identity.setAttribute('aria-label', 'Associated design namespace');
    identity.readOnly = true;
    identity.value = namespace;

    const name = document.createElement('input');
    name.setAttribute('aria-label', 'Public alias for selected frame');
    name.placeholder = 'Public alias (e.g. MainMenu)';
    name.value = alias;
    name.addEventListener('change', () => { alias = name.value.trim(); });
    content.append(identity, name);
    const button = document.createElement('button');
    button.textContent = 'Capture selection and publish';
    button.addEventListener('click', () => {
      if (busy) return;
      alias = name.value.trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(namespace) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
        publicationStatus = 'Unpublished: enter a path-free design namespace and valid public alias.'; render(); return;
      }
      if (!workspaceId) { publicationStatus = 'Unpublished: select a workspace before capture.'; render(); return; }
      busy = true;
      captureWorkspace = workspaceId;
      captureRevision = sourceRevision;
      button.disabled = true;
      publicationStatus = 'Capturing selection…';
      render();
      parent.postMessage({ pluginMessage: { type: 'capture-publication', namespace, alias } }, '*');
    });
    button.disabled = busy;
    content.append(button);
  }
  if (active === 'connection') {
    const button = document.createElement('button');
    button.textContent = 'Reconnect to local bridge';
    button.disabled = connecting || busy;
    button.addEventListener('click', () => { if (!busy) void connect(); });
    content.append(button);
    if (workspaces.length) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Publication workspace');
      for (const workspace of workspaces) {
        const option = document.createElement('option');
        option.value = workspace.id;
        option.textContent = workspace.label;
        select.append(option);
      }
      select.value = workspaceId ?? '';
      select.disabled = busy;
      select.addEventListener('change', () => {
        if (busy) { render(); return; }
        if (workspaceId !== select.value) { workspaceId = select.value; stale = true; publishedId = undefined; publicationStatus = 'Unpublished for selected workspace — capture and publish.'; connectionStatus = `Connected to local Gum bridge. Publishing to ${workspaces.find(item => item.id === workspaceId)?.label} (${workspaceId}). Select a workspace below.`; }
        render();
      });
      content.append(select);
    }
  }
}

window.addEventListener('message', event => {
  // Figma forwards scene messages under pluginMessage. No commands are accepted from this iframe.
  const message: unknown = event.data?.pluginMessage;
  if (typeof message === 'object' && message !== null && 'type' in message) {
    if (message.type === 'mapping-state' && 'mappings' in message && Array.isArray(message.mappings) &&
        'selectedIds' in message && Array.isArray(message.selectedIds)) {
      selectedIds = message.selectedIds.filter((id): id is string => typeof id === 'string');
      const entry = message.mappings.find((item: { nodeId?: string }) => item.nodeId === selectedIds[0]);
      alias = typeof entry?.alias === 'string' ? entry.alias : '';
      mappingStatus = `Selected ${selectedIds.length} node(s). ${'diagnostics' in message && Array.isArray(message.diagnostics) && message.diagnostics.length ? message.diagnostics.join('; ') : 'Mappings ready; custom target catalogs remain unresolved until connected.'}`;
      render(); return;
    }
    if (message.type === 'mapping-saved') {
      sourceRevision++;
      if (publishedId) { stale = true; publishedStale = true; publicationStatus = 'Mapping changed — republish before treating this preview as current.'; }
      mappingStatus = `Saved stable alias ${'alias' in message ? String(message.alias) : ''}. Rename the Figma layer without changing this alias.`;
      parent.postMessage({ pluginMessage: { type: 'read-mappings' } }, '*'); render(); return;
    }
    if (message.type === 'mapping-error') { mappingStatus = 'message' in message ? String(message.message) : 'Mapping unavailable'; render(); return; }
    if (message.type === 'source-changed') {
      sourceRevision++;
      if (publishedId) { stale = true; publishedStale = true; publicationStatus = 'Source changed — republish before treating this preview as current.'; render(); }
      return;
    }
    if (message.type === 'plugin-setup-required' && 'message' in message) {
      setupRequired = true;
      publicationStatus = `Setup required: ${String(message.message)}`;
      render(); return;
    }
    if (message.type === 'namespace-association' && 'retained' in message) {
      retained = typeof message.retained === 'string' ? message.retained : null;
      associated = false; namespace = ''; render(); return;
    }
    if (message.type === 'namespace-associated' && 'namespace' in message && typeof message.namespace === 'string') {
      namespace = message.namespace; retained = namespace; associated = true;
      parent.postMessage({ pluginMessage: { type: 'read-mappings' } }, '*'); render(); return;
    }
    if (message.type === 'fallback-approved') { publicationStatus = 'Decorative fallback approved for this exact node and feature. Capture again to publish.'; render(); return; }
    if (message.type === 'fallback-error' && 'message' in message) { publicationStatus = `Fallback not approved: ${String(message.message)}`; render(); return; }
    if (message.type === 'namespace-error' && 'message' in message) {
      publicationStatus = `Unpublished: ${String(message.message)}`; render(); return;
    }
  }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'capture-result' &&
      'result' in message && typeof message.result === 'object' && message.result !== null && 'snapshot' in message.result && 'diagnostics' in message.result) {
    const result = message.result as { snapshot: { snapshotId: string; schemaVersion: { major: 1; minor: 0 } } | null; assets: { hash: string; bytes: Uint8Array }[]; diagnostics: { code: string; message: string; nodeId?: string; fingerprint?: string; property?: string }[] };
    fallbackCandidate = result.diagnostics.find((d): d is { code: string; message: string; nodeId: string; fingerprint: string; property: string } =>
      d.property === 'effects/strokes' && !!d.fingerprint && !!d.nodeId && d.message.startsWith('Decorative raster fallback'));
    const requestedWorkspace = captureWorkspace;
    captureWorkspace = undefined;
    if (!result.snapshot || result.diagnostics.length || !requestedWorkspace || workspaceId !== requestedWorkspace) {
      busy = false;
      publicationStatus = `Unpublished: ${result.diagnostics.map(item => `${item.code}: ${item.message}`).join('; ') || 'Capture unavailable or workspace changed. Capture again for the selected workspace.'}`;
      render(); return;
    }
    publicationStatus = 'Uploading and finalizing…'; render();
    void bridge.publish(requestedWorkspace, { snapshot: result.snapshot, assets: result.assets }).then(published => {
      if (workspaceId !== requestedWorkspace) throw new Error('Publication completed for previous workspace; select it before preview.');
      busy = false;
      publishedId = published.snapshotId;
      publishedStale = sourceRevision !== captureRevision;
      stale = true;
      publicationStatus = `Published ${published.snapshotId} to workspace ${requestedWorkspace}. Render a staged Gum preview; no target apply.`;
      render();
    }).catch(error => { busy = false; publicationStatus = `Unpublished: ${error instanceof Error ? error.message : 'Bridge unavailable'}`; render(); });
    return;
  }
  if (!isSceneToUi(message)) return;
  sourceRevision++;
  if (publishedId) {
    stale = true; publishedStale = true;
    publicationStatus = 'Source changed — republish before treating this preview as current.';
  }
  panel.selection = selectionPanel(message.names);
  if (associated) parent.postMessage({ pluginMessage: { type: 'read-mappings' } }, '*');
  render();
});
render();
void connect();
