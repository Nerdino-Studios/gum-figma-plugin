import { initialPanel, selectionPanel, type ViewKey } from './state';
import { isSceneToUi } from '../transport/messages';

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
  content.textContent = panel[active];
}

window.addEventListener('message', event => {
  // Figma forwards scene messages under pluginMessage. No commands are accepted from this iframe.
  if (!isSceneToUi(event.data?.pluginMessage)) return;
  panel.selection = selectionPanel(event.data.pluginMessage.names);
  if (active === 'selection') render();
});
render();
