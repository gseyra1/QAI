import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadResolution } from '../resolution/load.ts';
import { loadScenario, parseScenario, ScenarioError } from '../scenario/load.ts';
import type { Step } from '../scenario/types.ts';
import { isVerificationOnly } from '../scenario/types.ts';
import type { ConsistencyIssue } from './consistency.ts';
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

  /**
   * Les deux sens d'une même garantie : une intention a au moins un geste,
   * une étape qui ne fait que vérifier n'en a aucun.
   */
  describe('actions et intention', () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: agir
  - id: s2
    expect: c'est affiché
`);
    const shown = { check: 'visible' as const, target: { role: 'text' as const } };
    const press = { kind: 'press' as const, key: 'Enter' };
    const resolution = (s1: number, s2: number) => ({
      scenario: 't',
      platform: 'web' as const,
      recordedAt: '',
      steps: {
        s1: { actions: Array.from({ length: s1 }, () => press) },
        s2: { actions: Array.from({ length: s2 }, () => press), assertions: { "c'est affiché": shown } },
      },
    });

    it('accepte une étape de vérification sans actions', () => {
      assert.deepEqual(checkConsistency(scenario, resolution(1, 0), 'web'), []);
    });

    it('signale une intention sans geste', () => {
      const issues = checkConsistency(scenario, resolution(0, 0), 'web');
      assert.deepEqual(issues, [{ kind: 'no-actions', stepId: 's1' }]);
      assert.match(formatIssue(issues[0] as ConsistencyIssue), /no actions, but the step has an intent/);
    });

    it('signale des gestes restés en cache sur une étape devenue simple vérification', () => {
      const issues = checkConsistency(scenario, resolution(1, 2), 'web');
      assert.deepEqual(issues, [{ kind: 'unexpected-actions', stepId: 's2', detail: '2' }]);
      assert.equal(
        formatIssue(issues[0] as ConsistencyIssue),
        'step "s2": verification-only step, but the cached resolution still has 2 action(s) — regenerate with "qai resolve"',
      );
    });
  });

  /**
   * Ni geste ni vérification sur la plateforme jouée : le chargeur ne peut pas
   * le voir, il ignore la plateforme. Le contrôle, lui, le refuse — même avec
   * un cache qui aurait l'air complet.
   */
  it('signale une étape qui n\'agit ni ne vérifie sur cette plateforme', () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    per_platform:
      ios: toucher Payer
`);
    const resolution = {
      scenario: 't',
      platform: 'web' as const,
      recordedAt: '',
      steps: { s1: { actions: [] } },
    };

    const issues = checkConsistency(scenario, resolution, 'web');
    assert.deepEqual(issues, [{ kind: 'empty-step', stepId: 's1', detail: 'web' }]);
    assert.match(formatIssue(issues[0] as ConsistencyIssue), /no intent and nothing to verify on web/);
    // Sur ios, l'étape a une intention : la règle ordinaire s'applique.
    assert.deepEqual(checkConsistency(scenario, { ...resolution, platform: 'ios' }, 'ios'), [
      { kind: 'no-actions', stepId: 's1' },
    ]);
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

  /**
   * Rejouer une résolution web sur iOS — et y réécrire les réparations —
   * produirait un fichier « web » plein de cibles iOS.
   */
  it('refuse une résolution écrite pour une autre plateforme', () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    do: agir\n');
    const issues = checkConsistency(
      scenario,
      { scenario: 't', platform: 'web', recordedAt: '', steps: { s1: { actions: [{ kind: 'press', key: 'Enter' }] } } },
      'ios',
    );
    assert.deepEqual(issues, [{ kind: 'platform-mismatch', stepId: '*', detail: 'web ≠ ios' }]);
    assert.match(formatIssue(issues[0] as (typeof issues)[number]), /written for another platform \(web ≠ ios\)/);
  });

  it('refuse hors du web une navigation par chemin relatif, sans URL de base', () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    do: agir\n');
    const navigations = ['/cart', '.', '/', 'acme://orders', 'localhost:3000/x'].map((to) => ({
      kind: 'navigate' as const,
      to,
    }));
    const resolution = { scenario: 't', platform: 'ios' as const, recordedAt: '', steps: { s1: { actions: navigations } } };
    assert.deepEqual(checkConsistency(scenario, resolution, 'ios'), [
      { kind: 'relative-navigate', stepId: 's1', detail: '/cart' },
      { kind: 'relative-navigate', stepId: 's1', detail: 'localhost:3000/x' },
    ]);
    // Sur le web, le chemin relatif est la forme normale.
    assert.deepEqual(checkConsistency(scenario, { ...resolution, platform: 'web' }, 'web'), []);
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

  it('rejette une étape qui n\'agit ni ne vérifie', () => {
    assert.throws(
      () => parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n'),
      (error: unknown) =>
        error instanceof ScenarioError &&
        /neither do nor per_platform, nor expect or capture/.test(error.message),
    );
    // Une liste d'attentes vide ne vérifie rien : ce n'est pas une étape.
    assert.throws(
      () => parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: []\n'),
      ScenarioError,
    );
  });

  /**
   * Une intention présente mais vide, ignorée, ferait de l'étape une simple
   * vérification : son geste disparaîtrait sans un mot.
   */
  it('rejette une intention vide plutôt que de l\'ignorer', () => {
    const shapes: [string, RegExp][] = [
      ['do: ""', /"do" must be a non-empty string/],
      ['do: "  "', /"do" must be a non-empty string/],
      ['do:', /"do" must be a non-empty string/],
      ['do: 42', /"do" must be a non-empty string/],
      ['per_platform: {}', /"per_platform" must map at least one platform/],
      ['per_platform:\n      web: ""', /per_platform\.web must be a non-empty string/],
      ['per_platform:\n      webb: cliquer', /unknown platform "webb"/],
      ['expect: ""', /"expect" must be a non-empty string/],
      ['expect:\n      - ""', /"expect" must be a non-empty string/],
    ];
    for (const [shape, message] of shapes) {
      // Une attente valide à côté : c'est l'intention vide qui doit être
      // refusée, pas l'absence de vérification.
      const extra = shape.startsWith('expect') ? '\n    do: agir' : '\n    expect: c\'est affiché';
      assert.throws(
        () => parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    ${shape}${extra}\n`),
        (error: unknown) => error instanceof ScenarioError && message.test(error.message),
        shape,
      );
    }
  });

  /**
   * « La commande figure dans l'historique » quand l'historique est déjà
   * affiché : sans cette forme, il fallait inventer un geste.
   */
  it('accepte une étape qui ne fait que vérifier', () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: payer
  - id: s2
    expect: la commande figure dans l'historique
  - id: s3
    capture:
      numero: le numéro de commande
`);
    assert.equal(scenario.steps[1]?.do, undefined);
    assert.equal(isVerificationOnly(scenario.steps[1] as Step, 'web'), true);
    assert.equal(isVerificationOnly(scenario.steps[2] as Step, 'web'), true);
    assert.equal(isVerificationOnly(scenario.steps[0] as Step, 'web'), false);
  });

  it('ne fait que vérifier là où aucune intention ne s\'applique', () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    per_platform:
      mobile: tirer pour rafraîchir
    expect: la liste est à jour
`);
    const step = scenario.steps[0] as Step;
    assert.equal(isVerificationOnly(step, 'web'), true);
    assert.equal(isVerificationOnly(step, 'ios'), false);
  });
});
