export const tabs = [
  { key: 'connection', title: 'Connection' },
  { key: 'publish', title: 'Publish' },
] as const;
export type ViewKey = (typeof tabs)[number]['key'];
export function initialPanel() { return { tabs }; }
