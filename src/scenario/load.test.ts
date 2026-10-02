import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { parseScenario, ScenarioError } from './load.ts';

/**
 * Une clé inconnue ignorée faisait d'une faute de frappe une perte silencieuse :
 * `Do:` à côté d'un `expect` donnait une étape qui ne fait que vérifier, sans
 * son geste. Le chargeur la refuse, comme le schéma.
 */
describe('chargeur de scénario : clés inconnues', () => {
  const cases: [string, string, RegExp][] = [
    [
      'une étape « Do: » avec expect',
      `
id: t
title: t
steps:
  - id: s1
    Do: ajouter au panier
    expect: le panier contient un article
`,
      /step "s1": unknown key "Do" — did you mean "do"\? \(allowed: id, do, per_platform, only, expect, capture\)/,
    ],
    [
      'une étape « does: » avec expect',
      `
id: t
title: t
steps:
  - id: s1
    does: ajouter au panier
    expect: le panier contient un article
`,
      /step "s1": unknown key "does" — did you mean "do"\?/,
    ],
    [
      'un « Id: » d\'étape',
      `
id: t
title: t
steps:
  - Id: s1
    do: agir
`,
      /step 0: unknown key "Id" — did you mean "id"\?/,
    ],
    [
      'une clé de premier niveau',
      `
id: t
title: t
platform: [web]
steps:
  - id: s1
    do: agir
`,
      /scenario: unknown key "platform" — did you mean "platforms"\? \(allowed: id, title, tags, platforms, given, steps\)/,
    ],
    [
      'une clé de given',
      `
id: t
title: t
given:
  fixture: [client-fr]
steps:
  - id: s1
    do: agir
`,
      /given: unknown key "fixture" — did you mean "fixtures"\? \(allowed: fixtures, state\)/,
    ],
    [
      'une clé sans parenté',
      `
id: t
title: t
steps:
  - id: s1
    do: agir
    description: rien
`,
      /step "s1": unknown key "description" \(allowed: /,
    ],
  ];

  for (const [label, raw, message] of cases) {
    it(`refuse ${label}`, () => {
      assert.throws(() => parseScenario(raw), (error: unknown) => {
        assert.ok(error instanceof ScenarioError);
        assert.match(error.message, message);
        return true;
      });
    });
  }

  it('dit la même chose que le schéma publié', async () => {
    const schema: unknown = JSON.parse(await readFile('schema/scenario.schema.json', 'utf8'));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema as object);
    for (const [, raw] of cases) {
      assert.equal(validate(parse(raw)), false, raw);
    }
  });

  it('accepte toutes les clés connues', () => {
    const scenario = parseScenario(`
id: t
title: t
tags: [a]
platforms: [web]
given:
  fixtures: [f]
  state: anonyme
steps:
  - id: s1
    do: agir
    per_platform:
      web: cliquer
    only: [web]
    expect: x
    capture:
      prix: le prix
`);
    assert.equal(scenario.steps[0]?.do, 'agir');
  });
});
