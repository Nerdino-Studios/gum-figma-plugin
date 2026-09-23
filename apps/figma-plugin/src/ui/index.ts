import { initialPanel, selectionPanel, type ViewKey } from './state';
import { isSceneToUi } from '../transport/messages';
import { BridgeClient } from '../transport/bridge-client';

const bridge = new BridgeClient();
let connectionStatus = 'Offline — enter a locally authorized challenge to pair.';
let workspaceId: string | undefined;
let namespace = '';
let retained: string | null = null;
let associated = false;
let busy = false;
let alias = '';
let publicationStatus = 'Unpublished — select a frame, pair, then capture and publish.';
let publishedId: string | undefined;
let previewUrl: string | undefined;
let previewIdentity = '';
let stale = false;
let sourceRevision = 0;
let captureRevision = 0;
let publishedStale = false;

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
  content.textContent = active === 'connection' ? connectionStatus : active === 'preview' ? publicationStatus : panel[active];
  if (active === 'preview' && previewUrl) {
    const identity = document.createElement('p');
    identity.textContent = `${stale ? 'Stale — source or workspace changed. ' : ''}${previewIdentity}`;
    const image = document.createElement('img');
    image.src = previewUrl; image.alt = 'Native Gum staged preview'; image.style.maxWidth = '100%';
    content.append(identity, image);
  }
  if (active === 'preview' && workspaceId) {
    if (publishedId) {
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
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(result.png)));
          const hash = 'sha256:' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
          if (hash !== result.outputHash || !result.png.slice(0, 8).every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i])) throw new Error('Preview PNG output hash mismatch.');
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
        parent.postMessage({ pluginMessage: { type: 'associate-namespace', mode: 'new', namespace: crypto.randomUUID() } }, '*');
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
      busy = true;
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
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'text';
    input.required = true;
    input.maxLength = 64;
    input.placeholder = 'Local one-time challenge';
    input.setAttribute('aria-label', 'Local one-time challenge');
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Pair and request workspaces';
    form.append(input, button);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const challenge = input.value.trim();
      input.value = '';
      button.disabled = true;
      connectionStatus = 'Connecting…';
      render();
      try {
        await bridge.pair(challenge);
        const result = await bridge.workspaces();
        const nextWorkspace = result.workspaces[0]?.id;
        if (nextWorkspace !== workspaceId) stale = true;
        workspaceId = nextWorkspace;
        connectionStatus = result.workspaces.length === 0
          ? 'Paired; no workspaces yet. Run gumbridge sample init --directory <new-absolute-directory> locally.'
          : `Paired; publishing to ${result.workspaces[0].label} (${result.workspaces[0].id}). No conversion or preview is available.`;
      } catch (error) {
        connectionStatus = error instanceof Error ? error.message : 'Bridge unavailable; check the local host.';
      }
      render();
    });
    content.append(form);
  }
}

window.addEventListener('message', event => {
  // Figma forwards scene messages under pluginMessage. No commands are accepted from this iframe.
  const message: unknown = event.data?.pluginMessage;
  if (typeof message === 'object' && message !== null && 'type' in message) {
    if (message.type === 'source-changed') {
      sourceRevision++;
      if (publishedId) { stale = true; publishedStale = true; publicationStatus = 'Source changed — republish before treating this preview as current.'; render(); }
      return;
    }
    if (message.type === 'namespace-association' && 'retained' in message) {
      retained = typeof message.retained === 'string' ? message.retained : null;
      associated = false; namespace = ''; render(); return;
    }
    if (message.type === 'namespace-associated' && 'namespace' in message && typeof message.namespace === 'string') {
      namespace = message.namespace; retained = namespace; associated = true; render(); return;
    }
    if (message.type === 'namespace-error' && 'message' in message) {
      publicationStatus = `Unpublished: ${String(message.message)}`; render(); return;
    }
  }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'capture-result' &&
      'result' in message && typeof message.result === 'object' && message.result !== null && 'snapshot' in message.result && 'diagnostics' in message.result) {
    const result = message.result as { snapshot: { snapshotId: string; schemaVersion: { major: 1; minor: 0 } } | null; assets: { hash: string; bytes: Uint8Array }[]; diagnostics: { code: string; message: string }[] };
    if (!result.snapshot || result.diagnostics.length || !workspaceId) {
      busy = false;
      publicationStatus = `Unpublished: ${result.diagnostics.map(item => `${item.code}: ${item.message}`).join('; ') || 'Capture unavailable or no workspace paired.'}`;
      render(); return;
    }
    const requestedWorkspace = workspaceId;
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
  render();
});
render();
