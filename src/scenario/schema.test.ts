import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const SCHEMA = 'schema/scenario.schema.json';
const EXAMPLE = 'examples/checkout-guest.qai.yaml';

async function validator() {
  const schema: unknown = JSON.parse(await readFile(SCHEMA, 'utf8'));
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema as object);
}

/**
 * Le schéma sert à l'outillage d'édition, le chargeur au runtime : ce sont deux
 * vérificateurs distincts du même format, et ils dérivent si personne ne les
 * confronte. Ces tests sont ce qui les tient alignés.
 */
describe('schéma de scénario', () => {
  it('accepte le scénario d\'exemple', async () => {
    const validate = await validator();
    const doc: unknown = parse(await readFile(EXAMPLE, 'utf8'));
    assert.equal(validate(doc), true, JSON.stringify(validate.errors, null, 2));
  });

  it('refuse la clé « on », que YAML 1.1 transforme en booléen', async () => {
    const validate = await validator();
    assert.equal(
      validate({ id: 't', title: 't', steps: [{ id: 's1', on: { web: 'x' } }] }),
      false,
      'le schéma doit rejeter « on » comme le fait le chargeur',
    );
  });

  it('exige une intention sur chaque étape', async () => {
    const validate = await validator();
    assert.equal(validate({ id: 't', title: 't', steps: [{ id: 's1' }] }), false);
  });

  it('refuse un scénario sans étape', async () => {
    const validate = await validator();
    assert.equal(validate({ id: 't', title: 't', steps: [] }), false);
  });

  it('accepte per_platform, only, expect et capture', async () => {
    const validate = await validator();
    const doc = {
      id: 't',
      title: 't',
      tags: ['critical-path'],
      given: { fixtures: ['a'], state: 'anonyme' },
      steps: [
        { id: 's1', do: 'agir', per_platform: { web: 'cliquer' }, expect: ['a', 'b'] },
        { id: 's2', do: 'survoler', only: ['web'], capture: { prix: 'le prix' } },
      ],
    };
    assert.equal(validate(doc), true, JSON.stringify(validate.errors, null, 2));
  });
});
