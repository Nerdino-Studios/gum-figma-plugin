import { initialPanel, selectionPanel, type ViewKey } from './state';
import { isSceneToUi } from '../transport/messages';
import { BridgeClient } from '../transport/bridge-client';

const bridge = new BridgeClient();
let connectionStatus = 'Offline — enter a locally authorized challenge to pair.';

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
  content.textContent = active === 'connection' ? connectionStatus : panel[active];
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
        connectionStatus = `Paired; ${result.workspaces.length} registered workspaces (registration is not available yet).`;
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
  if (!isSceneToUi(event.data?.pluginMessage)) return;
  panel.selection = selectionPanel(event.data.pluginMessage.names);
  if (active === 'selection') render();
});
render();
