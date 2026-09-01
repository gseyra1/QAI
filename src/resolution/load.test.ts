import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadResolution, parseResolution, ResolutionError } from './load.ts';
import { serializeResolution } from './save.ts';
import { RESOLUTION_VERSION } from './types.ts';

const SCHEMA = 'schema/resolution.schema.json';
const EXAMPLES = [
  'examples/.qai/resolutions/checkout-guest.web.json',
  'examples/.qai/resolutions/compte-connecte.web.json',
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

  it('les résolutions d\'exemple du dépôt sont à la version courante', async () => {
    // Régénérées avec l'outil : livrer un exemple périmé déclencherait
    // l'avertissement de version chez quiconque le copie comme point de départ.
    for (const path of EXAMPLES) {
      assert.equal((await loadResolution(path)).version, RESOLUTION_VERSION, path);
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

  it('estampille toujours la version courante, même sur un fichier chargé sans elle', () => {
    // On n'écrit qu'après avoir résolu ou réparé les cibles contre
    // l'observation d'aujourd'hui : conserver « version: 1 » mentirait sur ce
    // que le fichier contient, et se tairait sur lui-même le jour du changement.
    assert.match(
      serializeResolution(parseResolution(document())),
      new RegExp(`"version": ${RESOLUTION_VERSION}`),
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
});
