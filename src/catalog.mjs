// Explicit UI list of the two published Born 2 Bogey variants.
// Additions must be listed here deliberately; model IDs are never inferred from suffixes.
export const LEVEL_DEFINITIONS = Object.freeze([
  Object.freeze({ modelId: 'born-2-bogey-light', level: 'light', label: 'Lekka — na telefon' }),
  Object.freeze({ modelId: 'born-2-bogey-full', level: 'full', label: 'Pełna jakość — na komputer' }),
]);

export function createUiCatalog(models) {
  const modelById = new Map(models.map((model) => [model.id, model]));
  const levels = LEVEL_DEFINITIONS.map((entry) => {
    const model = modelById.get(entry.modelId);
    if (!model) throw new Error(`Brak jawnej pozycji interfejsu w manifeście: ${entry.modelId}.`);
    return { ...entry, model };
  });
  const configured = new Set(LEVEL_DEFINITIONS.map((entry) => entry.modelId));
  const unconfigured = models.filter((model) => !configured.has(model.id));
  if (unconfigured.length) throw new Error(`Brak jawnej wersji w interfejsie: ${unconfigured.map((model) => model.id).join(', ')}.`);
  return { levels, modelById };
}

export function levelForModelId(catalog, modelId) {
  return catalog.levels.find((entry) => entry.modelId === modelId)?.level ?? null;
}

export function modelForLevel(catalog, level) {
  return catalog.levels.find((entry) => entry.level === level)?.model ?? null;
}

export function modelIdFromSearch(search, activeModel, knownIds) {
  const requested = new URLSearchParams(search).get('model');
  if (!requested) return { modelId: activeModel, missingId: null };
  return knownIds.has(requested) ? { modelId: requested, missingId: null } : { modelId: null, missingId: requested };
}
