export const tabs = [
  { key: 'selection', title: 'Selection' },
  { key: 'mappings', title: 'Mappings' },
  { key: 'preview', title: 'Preview and changes' },
  { key: 'connection', title: 'Connection' },
] as const;

export type ViewKey = (typeof tabs)[number]['key'];

export function selectionPanel(names: readonly string[]): string {
  return names.length === 0
    ? 'Select a frame or component, create a design normally, or use Create sample design (unavailable until the sample creator is implemented).'
    : `Selected: ${names.join(', ')}. Export and analysis are unavailable in this shell.`;
}

export function initialPanel() {
  return {
    tabs,
    selection: selectionPanel([]),
    mappings: 'Built-in offline catalog available. Associate a namespace and select a frame to save a stable public alias. Target-specific mappings require a resolved project catalog.',
    preview: 'Preview requires a local bridge, a published snapshot and a configured workspace. Publish requires a local bridge and a selected export root. Neither action is available in this shell.',
    connection: 'Offline — no workspace selected; not connected to a local bridge. Start gumbridge serve locally, then reconnect.',
  };
}
