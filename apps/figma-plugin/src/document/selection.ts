import type { SceneToUi } from '../transport/messages';

// Read only the current selection. No document writes or conversion occur on startup.
export function readSelection(): SceneToUi {
  return { type: 'selection-changed', names: figma.currentPage.selection.map(node => node.name) };
}
