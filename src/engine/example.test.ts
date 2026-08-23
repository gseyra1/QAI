import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadResolution } from '../resolution/load.ts';
import { loadScenario, parseScenario, ScenarioError } from '../scenario/load.ts';
import { checkConsistency, formatIssue } from './consistency.ts';

const SCENARIO = 'examples/checkout-guest.qai.yaml';
const RESOLUTION = 'examples/.qai/resolutions/checkout-guest.web.json';

describe('les fichiers d\'exemple', () => {
  it('sont chargés par le moteur tel qu\'il est écrit', async () => {
    const scenario = await loadScenario(SCENARIO);
    assert.equal(scenario.id, 'checkout-guest');
    assert.equal(scenario.steps.length, 9);
    assert.ok(scenario.tags?.includes('critical-path'));
  });

  it('forment une paire cohérente, sans dérive', async () => {
    const scenario = await loadScenario(SCENARIO);
    const resolution = await loadResolution(RESOLUTION);
    const issues = checkConsistency(scenario, resolution, 'web');
    assert.deepEqual(issues.map(formatIssue), []);
  });

  it('déclarent la même divergence de plateforme que la documentation', async () => {
    const scenario = await loadScenario(SCENARIO);
    const step = scenario.steps.find((candidate) => candidate.id === 's5');
    assert.deepEqual(Object.keys(step?.per_platform ?? {}).sort(), ['mobile', 'web']);
  });
});

describe('checkConsistency', () => {
  it('détecte une assertion reformulée dont la forme machine est restée en arrière', async () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: agir
    expect: le nouveau libellé
`);
    const resolution = {
      scenario: 't',
      platform: 'web' as const,
      recordedAt: '',
      steps: {
        s1: {
          actions: [{ kind: 'press' as const, key: 'Enter' }],
          assertions: {
            "l'ancien libellé": { check: 'visible' as const, target: { role: 'text' as const } },
          },
        },
      },
    };

    const issues = checkConsistency(scenario, resolution, 'web');
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.kind, 'missing-assertion');
  });

  it('détecte une résolution orpheline', () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    do: agir\n');
    const issues = checkConsistency(
      scenario,
      {
        scenario: 't',
        platform: 'web',
        recordedAt: '',
        steps: {
          s1: { actions: [{ kind: 'press', key: 'Enter' }] },
          s9: { actions: [{ kind: 'press', key: 'Enter' }] },
        },
      },
      'web',
    );
    assert.deepEqual(issues, [{ kind: 'orphan-step', stepId: 's9' }]);
  });
});

describe('parseScenario', () => {
  it('rejette la clé « on », que YAML 1.1 transformerait en booléen', () => {
    assert.throws(
      () => parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    do: x\n    on:\n      web: y\n'),
      (error: unknown) => error instanceof ScenarioError && /per_platform/.test(error.message),
    );
  });

  it('rejette un identifiant d\'étape dupliqué', () => {
    assert.throws(
      () => parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    do: x\n  - id: s1\n    do: y\n'),
      (error: unknown) => error instanceof ScenarioError && /duplicate/.test(error.message),
    );
  });

  it('rejette une étape sans intention', () => {
    assert.throws(
      () => parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n'),
      (error: unknown) => error instanceof ScenarioError && /neither do nor per_platform/.test(error.message),
    );
  });
});
