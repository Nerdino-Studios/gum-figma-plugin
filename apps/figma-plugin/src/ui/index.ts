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
  if (active === 'preview' && workspaceId) {
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
        workspaceId = result.workspaces[0]?.id;
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
    publicationStatus = 'Uploading and finalizing…'; render();
    void bridge.publish(workspaceId, { snapshot: result.snapshot, assets: result.assets }).then(published => {
      busy = false;
      publicationStatus = `Published ${published.snapshotId} to workspace ${workspaceId}. Stored capture only; no preview or conversion.`;
      render();
    }).catch(error => { busy = false; publicationStatus = `Unpublished: ${error instanceof Error ? error.message : 'Bridge unavailable'}`; render(); });
    return;
  }
  if (!isSceneToUi(message)) return;
  panel.selection = selectionPanel(message.names);
  if (active === 'selection') render();
});
render();
