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
    mappings: 'Mapping editor and built-in catalog are unavailable in this shell. No target mappings can be validated offline yet.',
    preview: 'Preview requires a local bridge, a published snapshot and a configured workspace. Publish requires a local bridge and a selected export root. Neither action is available in this shell.',
    connection: 'Offline — no workspace selected; not connected to a local bridge. Pairing and Sample workspace setup are not implemented yet.',
  };
}
