import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUiCatalog,
  levelForModelId,
  modelForLevel,
  modelIdFromSearch,
} from '../src/catalog.mjs';
import {
  PORTRAIT_FIT_MARGIN_ASPECT,
  distanceLimitsForFit,
  fitDistanceForAspect,
} from '../src/cameraFraming.mjs';

const models = [
  { id: 'born-2-bogey-light' },
  { id: 'born-2-bogey-full' },
];
const catalog = createUiCatalog(models);

test('explicit metadata lists exactly the two Born 2 Bogey variants in order', () => {
  assert.deepEqual(catalog.levels.map((entry) => entry.level), ['light', 'full']);
  assert.equal(modelForLevel(catalog, 'full').id, 'born-2-bogey-full');
  assert.equal(levelForModelId(catalog, 'born-2-bogey-light'), 'light');
  assert.match(catalog.levels[0].label, /na telefon$/);
  assert.match(catalog.levels[1].label, /na komputer$/);
});

test('unknown and unconfigured IDs fail closed', () => {
  assert.equal(modelForLevel(catalog, 'medium'), null);
  assert.equal(levelForModelId(catalog, 'not-listed'), null);
  assert.throws(() => createUiCatalog([...models, { id: 'future-unmapped-model' }]), /Brak jawnej wersji/);
  assert.throws(() => createUiCatalog(models.slice(1)), /Brak jawnej pozycji/);
});

test('model query and root active model navigation are exact', () => {
  const known = new Set(models.map((model) => model.id));
  assert.deepEqual(modelIdFromSearch('?model=born-2-bogey-full', 'born-2-bogey-light', known), { modelId: 'born-2-bogey-full', missingId: null });
  assert.deepEqual(modelIdFromSearch('', 'born-2-bogey-light', known), { modelId: 'born-2-bogey-light', missingId: null });
  assert.deepEqual(modelIdFromSearch('?model=born-2-bogey-fulll', 'born-2-bogey-light', known), { modelId: null, missingId: 'born-2-bogey-fulll' });
});

test('portrait full-scene framing scales distance and clamps while preserving the desktop baseline', () => {
  assert.equal(PORTRAIT_FIT_MARGIN_ASPECT, 1.3);
  assert.equal(fitDistanceForAspect(3, true, 16 / 9), 3);
  assert.equal(fitDistanceForAspect(2.4, false, 0.626), 2.4);
  const portraitFit = fitDistanceForAspect(3, true, 0.626);
  assert.ok(Math.abs(portraitFit - (3 * 1.3) / 0.626) < 1e-9);
  const limits = distanceLimitsForFit(portraitFit, true, 0.4, 6, 3);
  assert.ok(Math.abs(limits.minimum / portraitFit - 0.4 / 3) < 1e-12);
  assert.ok(Math.abs(limits.maximum / portraitFit - 2) < 1e-12);
});
