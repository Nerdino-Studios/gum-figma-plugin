// Only the document root holds the association. Never put pairing credentials here.
const key = 'gumbridge.designNamespace.v1';
const valid = (value: string) => /^[A-Za-z0-9_-]{1,100}$/.test(value);
export function retainedNamespace(root: { getPluginData(key: string): string }): string | null {
  const value = root.getPluginData(key);
  return valid(value) ? value : null;
}
export function associateNamespace(root: { setPluginData(key: string, value: string): void },
  mode: 'new' | 'continue', value: string, previous: string | null): string {
  if (!valid(value) || (mode === 'new' && previous === value)) throw new Error('Choose a distinct path-free namespace');
  root.setPluginData(key, value);
  return value;
}
