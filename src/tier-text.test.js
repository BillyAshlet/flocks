import test from 'node:test';
import assert from 'node:assert/strict';
import { createParameterRegistry } from './experiment-config.js';
import { TIER_TEXT } from './tier-text.js';
import { TIERS, tierConfig, tierPanelScope } from './tiers.js';

function texOf(model, config) {
  const pieces = [];
  for (const section of model.sections) {
    for (const source of section.formulas ?? []) {
      pieces.push(typeof source === 'function' ? source(config) : source);
    }
    for (const item of [...(section.live ?? []), ...(section.where ?? [])]) pieces.push(item.tex);
  }
  return pieces.join(' ');
}

// A symbol the reader can click must open a slider that this tier's panel
// actually shows; otherwise the click does nothing.
test('every formula symbol names a parameter shown at its tier', () => {
  for (const { number } of TIERS) {
    const model = TIER_TEXT[number]?.model;
    if (!model) continue;
    const config = tierConfig(number);
    const scope = tierPanelScope(number);
    const registry = new Set(
      createParameterRegistry(config).map((spec) => spec.path.replace(/^schools\.\d+\./, 'schools.*.'))
    );
    const paths = [...texOf(model, config).matchAll(/\\htmlData\{param=([^}]+)\}/g)].map(
      (match) => match[1]
    );
    assert.ok(paths.length > 0, `tier ${number} has linked symbols`);
    for (const path of new Set(paths)) {
      assert.ok(registry.has(path), `tier ${number}: ${path} is not a parameter`);
      const field = /^schools\.\*\.(.+)$/.exec(path)?.[1];
      const shown = field
        ? scope.showSchoolField(field)
        : scope.showGlobal({ path }) || path.startsWith('perception.') && path.endsWith('RadiusFactor');
      assert.ok(shown, `tier ${number}: ${path} is not in the panel`);
    }
  }
});

test('every formula group names its symbols', () => {
  for (const { number } of TIERS) {
    for (const section of TIER_TEXT[number]?.model?.sections ?? []) {
      if (!section.formulas?.length) continue;
      assert.ok(section.where?.length, `tier ${number}: "${section.title}" has no where list`);
      for (const row of section.where) {
        assert.ok(row.tex && row.name, `tier ${number}: "${section.title}" row lacks tex or name`);
      }
    }
  }
});

test('live values read from a tier config without throwing', async () => {
  const { deriveExperiment } = await import('./experiment-model.js');
  for (const { number } of TIERS) {
    const model = TIER_TEXT[number]?.model;
    if (!model) continue;
    const config = tierConfig(number);
    const state = {
      config,
      school: config.schools[0],
      derived: deriveExperiment(config).schools[0],
    };
    for (const section of model.sections) {
      for (const item of [...(section.live ?? []), ...(section.where ?? [])]) {
        if (!item.value) continue;
        assert.ok(Number.isFinite(Number(item.value(state))), `tier ${number}: ${item.tex}`);
      }
    }
  }
});
