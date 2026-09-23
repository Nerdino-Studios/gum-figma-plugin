export type SceneToUi = { type: 'selection-changed'; names: string[] };

export function isSceneToUi(value: unknown): value is SceneToUi {
  if (typeof value !== 'object' || value === null || !('type' in value) || !('names' in value)) return false;
  return value.type === 'selection-changed' && Array.isArray(value.names) && value.names.every(name => typeof name === 'string');
}
