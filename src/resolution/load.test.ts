import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadResolution, parseResolution, ResolutionError } from './load.ts';
import { serializeResolution } from './save.ts';
import { OBSERVATION_VERSION, RESOLUTION_VERSION, requiredVersion } from './types.ts';

const SCHEMA = 'schema/resolution.schema.json';
const EXAMPLES = [
  'examples/.qai/resolutions/checkout-guest.web.json',
  'examples/.qai/resolutions/compte-connecte.web.json',
  'examples/.qai/resolutions/cart-confirmation.web.json',
  'examples/.qai/resolutions/library-loan.web.json',
];

function document(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scenario: 't',
    platform: 'web',
    recordedAt: '2026-01-01T00:00:00Z',
    steps: { s1: { actions: [{ kind: 'navigate', to: '/' }], healedAt: null } },
    ...extra,
  });
}

/**
 * Sans numéro de format, un changement d'observation transformerait des
 * résolutions périmées en faux verts. Ces tests fixent les deux bouts du
 * contrat : les fichiers d'avant le champ restent lisibles, un fichier trop
 * récent est refusé bruyamment.
 */
describe('version de format d\'une résolution', () => {
  it('lit un fichier sans champ version comme une v1', () => {
    assert.equal(parseResolution(document()).version, 1);
  });

  it('les résolutions d\'exemple du dépôt sont à la version qu\'exige leur contenu', async () => {
    // Régénérées avec l'outil : livrer un exemple périmé déclencherait
    // l'avertissement de version chez quiconque le copie comme point de départ.
    // Pas plus haut non plus : l'auto-test de l'action les rejoue avec la
    // dernière version publiée de QAI, qui peut ne pas lire la plus récente.
    for (const path of EXAMPLES) {
      const resolution = await loadResolution(path);
      assert.equal(resolution.version, requiredVersion(resolution), path);
      assert.ok((resolution.version ?? 1) >= OBSERVATION_VERSION, path);
    }
  });

  it('accepte la version courante', () => {
    assert.equal(parseResolution(document({ version: RESOLUTION_VERSION })).version, RESOLUTION_VERSION);
  });

  it('refuse une version future plutôt que de deviner', () => {
    assert.throws(
      () => parseResolution(document({ version: RESOLUTION_VERSION + 1 })),
      (error: unknown) =>
        error instanceof ResolutionError && /upgrade QAI/.test(error.message),
    );
  });

  it('refuse une version qui n\'est pas un entier positif', () => {
    assert.throws(() => parseResolution(document({ version: 'deux' })), ResolutionError);
    assert.throws(() => parseResolution(document({ version: 0 })), ResolutionError);
    assert.throws(() => parseResolution(document({ version: 1.5 })), ResolutionError);
  });

  it('estampille au moins la version d\'observation, même sur un fichier chargé sans elle', () => {
    // On n'écrit qu'après avoir résolu ou réparé les cibles contre
    // l'observation d'aujourd'hui : conserver « version: 1 » mentirait sur ce
    // que le fichier contient, et se tairait sur lui-même le jour du changement.
    assert.match(
      serializeResolution(parseResolution(document())),
      new RegExp(`"version": ${OBSERVATION_VERSION}`),
    );
  });

  /**
   * La v3 n'est estampillée que là où le sens l'exige : une réparation en CI
   * d'un fichier v2 ne doit pas le rendre illisible pour un QAI qui lit la v2.
   */
  it('n\'estampille la v3 que pour un contenu qui en use', () => {
    const stamp = (steps: unknown) =>
      parseResolution(serializeResolution(parseResolution(document({ version: 2, steps })))).version;
    const click = { kind: 'navigate', to: '/' };

    assert.equal(stamp({ s1: { actions: [click] } }), OBSERVATION_VERSION);
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlEquals', value: 'http://h/x' } } } }),
      OBSERVATION_VERSION,
      'un urlEquals absolu a le même sens en v2',
    );
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlContains', value: 'x' } } } }),
      OBSERVATION_VERSION,
      'urlContains n\'a pas changé de sens',
    );
    assert.equal(stamp({ s1: { actions: [] } }), RESOLUTION_VERSION);
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlEquals', value: 'orders' } } } }),
      RESOLUTION_VERSION,
    );
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlEquals', value: '{{adresse}}' } } } }),
      RESOLUTION_VERSION,
      'un gabarit sans schéma peut se résoudre en valeur relative',
    );
  });
});

/**
 * Le schéma sert à l'outillage d'édition, le chargeur au runtime : deux
 * vérificateurs du même format, qui dérivent si personne ne les confronte.
 */
describe('schéma de résolution', () => {
  it('accepte les résolutions d\'exemple, y compris réécrites', async () => {
    const schema: unknown = JSON.parse(await readFile(SCHEMA, 'utf8'));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema as object);

    for (const path of EXAMPLES) {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(validate(raw), true, `${path} : ${JSON.stringify(validate.errors, null, 2)}`);

      const rewritten: unknown = JSON.parse(serializeResolution(await loadResolution(path)));
      assert.equal(
        validate(rewritten),
        true,
        `${path} réécrit : ${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
  });

  it('accepte les deux formes de la v3 : actions vides et urlEquals relatif', async () => {
    const schema: unknown = JSON.parse(await readFile(SCHEMA, 'utf8'));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema as object);
    const raw = document({
      version: 3,
      steps: {
        s1: {
          actions: [],
          assertions: { "l'adresse est l'historique": { check: 'urlEquals', value: 'orders?tab=history' } },
          healedAt: null,
        },
      },
    });

    const doc: unknown = JSON.parse(serializeResolution(parseResolution(raw)));
    assert.equal(validate(doc), true, JSON.stringify(validate.errors, null, 2));
    assert.deepEqual(parseResolution(raw).steps['s1']?.actions, []);
  });
});
