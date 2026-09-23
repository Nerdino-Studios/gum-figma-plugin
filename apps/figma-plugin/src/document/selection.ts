import type { SceneToUi } from '../transport/messages';

export interface SelectedNode { id: string; name: string; type: string }
export interface ExtractionDiagnostic { code: string; severity: 'error'; nodeId: string; property: string; message: string }

// Aliases are plugin-owned metadata, never derived from the mutable layer name.
export function readSelectedRoots(selection: readonly SelectedNode[], aliases: Readonly<Record<string, string>> = {}) {
  const roots: { id: string; name: string; alias?: string }[] = [];
  const diagnostics: ExtractionDiagnostic[] = [];
  for (const node of selection) {
    if (node.type !== 'FRAME') {
      diagnostics.push({ code: 'UNSUPPORTED_FEATURE', severity: 'error', nodeId: node.id, property: 'type', message: `Unsupported export root: ${node.type}` });
    } else {
      roots.push({ id: node.id, name: node.name, ...(aliases[node.id] ? { alias: aliases[node.id] } : {}) });
    }
  }
  return { roots, diagnostics };
}

// Read only the current selection. No document writes or conversion occur on startup.
export function readSelection(): SceneToUi {
  return { type: 'selection-changed', names: figma.currentPage.selection.map(node => node.name) };
}
