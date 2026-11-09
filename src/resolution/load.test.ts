import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadResolution, parseResolution, ResolutionError } from './load.ts';
import { serializeResolution } from './save.ts';
import { FORMAT_FLOOR, OBSERVATION_VERSION, RESOLUTION_VERSION, observedUnder, requiredVersion } from './types.ts';

const SCHEMA = 'schema/resolution.schema.json';
const EXAMPLES = [
  'examples/.qai/resolutions/checkout-guest.web.json',
  'examples/.qai/resolutions/compte-connecte.web.json',
  'examples/.qai/resolutions/cart-confirmation.web.json',
  'examples/library/.qai/resolutions/library-loan.web.json',
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
      assert.ok((resolution.version ?? 1) >= FORMAT_FLOOR, path);
      assert.equal(resolution.observation, OBSERVATION_VERSION, path);
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

  it('estampille le plancher et l\'observation courante, même sur un fichier chargé sans eux', () => {
    // On n'écrit qu'après avoir résolu ou réparé les cibles contre
    // l'observation d'aujourd'hui : conserver « version: 1 » mentirait sur ce
    // que le fichier contient, et se tairait sur lui-même le jour du changement.
    const written = serializeResolution(parseResolution(document()));
    assert.match(written, new RegExp(`"version": ${FORMAT_FLOOR}`));
    assert.match(written, new RegExp(`"observation": ${OBSERVATION_VERSION}`));
  });

  /**
   * Un fichier écrit par 0.5.x porte la v2, la v3 ou la v4, sans champ
   * d'observation. Il doit se charger tel quel — pour que l'avertissement
   * d'observation périmée le désigne — et, une fois réécrit, garder la version
   * qu'exige son contenu en gagnant l'observation d'aujourd'hui.
   */
  it('relit les résolutions écrites par 0.5.x : v2, v3 et v4', () => {
    const from = { role: 'text' as const };
    const navigate = { kind: 'navigate', to: '/' };
    const written: Record<number, unknown> = {
      2: { s1: { actions: [navigate], assertions: { a: { check: 'visible', target: from } } } },
      3: { s1: { actions: [] }, s2: { actions: [navigate], assertions: { a: { check: 'urlEquals', value: 'orders' } } } },
      4: { s1: { actions: [navigate], captures: { c: { from, extract: 'text', after: 'Réf ' } } } },
    };
    for (const [version, steps] of Object.entries(written)) {
      const loaded = parseResolution(document({ version: Number(version), steps }));
      assert.equal(loaded.version, Number(version));
      assert.equal(loaded.observation, undefined);
      assert.ok(observedUnder(loaded) < OBSERVATION_VERSION, `v${version} doit être signalé`);

      const rewritten = parseResolution(serializeResolution(loaded));
      assert.equal(rewritten.version, Number(version), 'le contenu exige toujours la même version');
      assert.equal(rewritten.observation, OBSERVATION_VERSION);
    }
  });

  it('lit une observation plus récente sans la refuser, et refuse une observation invalide', () => {
    const later = parseResolution(document({ version: FORMAT_FLOOR, observation: OBSERVATION_VERSION + 1 }));
    assert.equal(later.observation, OBSERVATION_VERSION + 1);
    assert.throws(() => parseResolution(document({ observation: 'cinq' })), ResolutionError);
    assert.throws(() => parseResolution(document({ observation: 0 })), ResolutionError);
    assert.throws(() => parseResolution(document({ observation: 4.5 })), ResolutionError);
  });

  const stamp = (steps: unknown) =>
    parseResolution(serializeResolution(parseResolution(document({ version: 2, steps })))).version;
  const click = { kind: 'navigate', to: '/' };

  /**
   * La v3 n'est estampillée que là où le sens l'exige : une réparation en CI
   * d'un fichier v2 ne doit pas le rendre illisible pour un QAI qui lit la v2.
   */
  it('n\'estampille la v3 que pour un contenu qui en use', () => {
    assert.equal(stamp({ s1: { actions: [click] } }), FORMAT_FLOOR);
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlEquals', value: 'http://h/x' } } } }),
      FORMAT_FLOOR,
      'un urlEquals absolu a le même sens en v2',
    );
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlContains', value: 'x' } } } }),
      FORMAT_FLOOR,
      'urlContains n\'a pas changé de sens',
    );
    assert.equal(stamp({ s1: { actions: [] } }), 3);
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlEquals', value: 'orders' } } } }),
      3,
    );
    assert.equal(
      stamp({ s1: { actions: [click], assertions: { a: { check: 'urlEquals', value: '{{adresse}}' } } } }),
      3,
      'un gabarit sans schéma peut se résoudre en valeur relative',
    );
  });

  it("n'estampille la v4 que pour une capture bornée", () => {
    const from = { role: 'text' as const };
    assert.equal(
      stamp({ s1: { actions: [click], captures: { c: { from, extract: 'text' } } } }),
      FORMAT_FLOOR,
    );
    assert.equal(
      stamp({ s1: { actions: [click], captures: { c: { from, extract: 'text', after: 'Réf ' } } } }),
      RESOLUTION_VERSION,
    );
    assert.equal(
      stamp({ s1: { actions: [] }, s2: { actions: [click], captures: { c: { from, extract: 'text', before: ' €' } } } }),
      RESOLUTION_VERSION,
      "une étape v3 plus tôt ne cache pas l'exigence de la suivante",
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
