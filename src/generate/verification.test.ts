import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Action,
  Capabilities,
  Driver,
  Platform,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import { node } from '../engine/fixtures.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import type { Check } from '../resolution/types.ts';
import { parseScenario } from '../scenario/load.ts';
import { generateResolution } from './generate.ts';

const ORDER = node('text', 'Commande CMD-1');
const BUTTON = node('button', 'Valider');
const TREE = node('group', 'page', [ORDER, BUTTON]);
const FOUND: ResolveOutcome = { found: true, node: BUTTON, usedFallback: false };

/** Un écran figé, à l'adresse choisie par le test : seule l'adresse varie ici. */
class FakeDriver implements Driver {
  readonly platform: Platform = 'web';
  readonly capabilities: Capabilities = {
    hover: true,
    swipe: false,
    navigateByUrl: true,
    deepLink: true,
    dialogs: true,
  };

  readonly acted: Action[] = [];
  readonly #location: string;
  readonly #root: UINode;

  constructor(location: string, root: UINode = TREE) {
    this.#location = location;
    this.#root = root;
  }

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async observe(): Promise<UISnapshot> {
    return {
      platform: 'web',
      at: new Date().toISOString(),
      location: this.#location,
      viewport: { x: 0, y: 0, width: 1280, height: 800 },
      root: this.#root,
    };
  }
  async resolve(): Promise<ResolveOutcome> {
    return FOUND;
  }
  async act(action: Action): Promise<void> {
    this.acted.push(action);
  }
  async settle(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** Rend les réponses dans l'ordre, et garde chaque requête pour l'examen. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  readonly #outputs: unknown[];

  constructor(outputs: unknown[]) {
    this.#outputs = outputs;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const output = this.#outputs[this.requests.length - 1];
    assert.ok(output !== undefined, `réponse ${this.requests.length} non scénarisée`);
    return { output, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

const CLICK: Action = { kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } };
const SHOWN: Check = { check: 'visible', target: { role: 'text', name: { contains: 'CMD-' } } };

function asksForActions(request: ModelRequest): boolean {
  return 'actions' in (request.responseSchema['properties'] as object);
}

function firstText(request: ModelRequest): string {
  const part = request.messages[0]?.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

/**
 * La règle d'un vert qui prouve quelque chose, appliquée à l'étape qui ne fait
 * que vérifier : aucun geste demandé, aucun geste accepté, et zéro geste
 * toujours refusé là où il y a une intention à accomplir.
 */
describe('génération d\'une étape qui ne fait que vérifier', () => {
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: valider la commande
  - id: s2
    expect: la commande apparaît dans l'historique
`);

  it('ne demande aucune action et n\'en versionne aucune', async () => {
    const driver = new FakeDriver('http://app.test/');
    const provider = new ScriptedProvider([
      { actions: [CLICK] },
      { assertions: { "la commande apparaît dans l'historique": SHOWN } },
    ]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.resolution.steps['s2']?.actions, []);
    assert.deepEqual(result.resolution.steps['s2']?.assertions, {
      "la commande apparaît dans l'historique": SHOWN,
    });
    // Un seul geste joué : celui de s1.
    assert.equal(driver.acted.length, 1);

    const second = provider.requests[1] as ModelRequest;
    assert.equal(asksForActions(provider.requests[0] as ModelRequest), true);
    assert.equal(asksForActions(second), false, 'aucune action ne doit être demandée');
    assert.match(firstText(second), /only verifies the current screen/);
    // Les manques initiaux sont la question posée, pas un rejet.
    assert.deepEqual(result.steps[1]?.rejections, []);
  });

  it('refuse une proposition qui porte des actions, puis accepte la correction', async () => {
    const driver = new FakeDriver('http://app.test/');
    const provider = new ScriptedProvider([
      { actions: [CLICK] },
      { actions: [CLICK], assertions: { "la commande apparaît dans l'historique": SHOWN } },
      { assertions: { "la commande apparaît dans l'historique": SHOWN } },
    ]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.resolution.steps['s2']?.actions, []);
    assert.equal(driver.acted.length, 1, 'le geste inventé ne doit jamais être joué');
    assert.ok(
      result.steps[1]?.rejections.some((reason) => /return no "actions"/.test(reason)),
      String(result.steps[1]?.rejections.join(' | ')),
    );
  });

  /**
   * Le geste n'existe que sur mobile, et l'étape n'affirme rien : sur le web,
   * elle n'agit ni ne vérifie. Résolue, ce serait un vert qui ne prouve rien —
   * zéro geste, zéro assertion, compté comme passé au rejeu.
   */
  for (const [shape, yaml] of [
    ['per_platform sans le web', 'per_platform:\n      mobile: tirer pour rafraîchir'],
    ['per_platform qui ne nomme que ios', 'per_platform:\n      ios: toucher Payer'],
  ] as const) {
    it(`refuse une étape qui n'agit ni ne vérifie sur cette plateforme (${shape})`, async () => {
      const empty = parseScenario(`
id: t
title: t
steps:
  - id: s1
    ${yaml}
`);
      const provider = new ScriptedProvider([]);
      const result = await generateResolution({
        scenario: empty,
        driver: new FakeDriver('http://app.test/'),
        provider,
      });

      assert.equal(result.status, 'incomplete');
      assert.equal(result.steps[0]?.status, 'failed');
      assert.match(result.steps[0]?.rejections[0] ?? '', /nothing to verify on web/);
      assert.equal(result.resolution.steps['s1'], undefined);
      assert.equal(provider.requests.length, 0, 'rien à demander au modèle');
    });
  }

  it('refuse zéro action sur une étape qui a une intention', async () => {
    const driver = new FakeDriver('http://app.test/');
    const provider = new ScriptedProvider([
      { actions: [] },
      { actions: [CLICK] },
      { assertions: { "la commande apparaît dans l'historique": SHOWN } },
    ]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    assert.equal(result.resolution.steps['s1']?.actions.length, 1);
    assert.ok(
      result.steps[0]?.rejections.some((reason) => /"actions" is empty, but this step has an intent/.test(reason)),
      String(result.steps[0]?.rejections.join(' | ')),
    );
  });

  it('échoue plutôt que de versionner une intention sans geste', async () => {
    const provider = new ScriptedProvider([{ actions: [] }, { actions: [] }]);
    const result = await generateResolution({
      scenario,
      driver: new FakeDriver('http://app.test/'),
      provider,
      attemptsPerStep: 2,
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(result.steps[0]?.status, 'failed');
    assert.equal(result.resolution.steps['s1'], undefined);
  });
});

/**
 * Le même défaut que `navigate`, sur une assertion : l'adresse observée,
 * recopiée avec son port, passe ici et casse partout ailleurs.
 */
describe('vérifications d\'adresse rendues portables à la génération', () => {
  const KEY = "l'adresse est la bonne";
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ouvrir la page
    expect: ${JSON.stringify(KEY)}
`);

  async function generate(
    location: string,
    baseUrl: string | undefined,
    ...checks: Check[]
  ) {
    const [first, ...rest] = checks;
    const provider = new ScriptedProvider([
      { actions: [CLICK], assertions: { [KEY]: first } },
      ...rest.map((check) => ({ assertions: { [KEY]: check } })),
    ]);
    const result = await generateResolution({
      scenario,
      driver: new FakeDriver(location),
      provider,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      attemptsPerStep: 3,
    });
    return { result, stored: result.resolution.steps['s1']?.assertions?.[KEY] };
  }

  it('réécrit une adresse de la même origine relativement à la base', async () => {
    const url = 'http://127.0.0.1:5173/orders?id=3#top';
    const { result, stored } = await generate(url, 'http://127.0.0.1:5173/', {
      check: 'urlEquals',
      value: url,
    });

    assert.equal(result.status, 'complete');
    assert.deepEqual(stored, { check: 'urlEquals', value: 'orders?id=3#top' });
  });

  it('garde le préfixe de montage hors de la valeur, sous une base à préfixe', async () => {
    const url = 'http://127.0.0.1:5173/ecole/eleves/42';
    const { stored } = await generate(url, 'http://127.0.0.1:5173/ecole', { check: 'urlEquals', value: url });

    assert.deepEqual(stored, { check: 'urlEquals', value: 'eleves/42' });
  });

  it('garde un « ? » ou un « # » vide : sans eux, ce n\'est plus la même adresse', async () => {
    for (const url of ['http://127.0.0.1:5173/x?', 'http://127.0.0.1:5173/x#']) {
      const { result, stored } = await generate(url, 'http://127.0.0.1:5173/', { check: 'urlEquals', value: url });

      assert.equal(result.status, 'complete', String(result.steps[0]?.rejections.join(' | ')));
      assert.deepEqual(stored, { check: 'urlEquals', value: url.slice('http://127.0.0.1:5173/'.length) });
    }
  });

  it('écrit un chemin d\'origine pour une adresse hors du chemin de base', async () => {
    const url = 'http://127.0.0.1:5173/login?next=/ecole';
    const { stored } = await generate(url, 'http://127.0.0.1:5173/ecole/', {
      check: 'urlEquals',
      value: url,
    });

    assert.deepEqual(stored, { check: 'urlEquals', value: '/login?next=/ecole' });
  });

  it('écrit « . » pour la base elle-même', async () => {
    const { stored } = await generate('http://127.0.0.1:5173/ecole/', 'http://127.0.0.1:5173/ecole', {
      check: 'urlEquals',
      value: 'http://127.0.0.1:5173/ecole/',
    });

    assert.deepEqual(stored, { check: 'urlEquals', value: '.' });
  });

  /**
   * Une sous-chaîne ne se réécrit pas sans perdre son ancrage :
   * « http://h/orders » devenu « orders » serait vrai sur
   * « /login?next=/orders », la redirection même qu'elle devait attraper.
   * Rendue au modèle, jamais réécrite — y compris la racine écrite de toutes
   * les façons, qui deviendrait « / » ou « /app », contenues partout.
   */
  it('rend au modèle tout urlContains absolu de l\'application, puis accepte la correction', async () => {
    const values: [string, string][] = [
      ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/orders'],
      ['http://127.0.0.1:5173/ecole/', 'http://127.0.0.1:5173/ecole/'],
      ['http://127.0.0.1:5173/ecole/', 'http://127.0.0.1:5173/ecole'],
      ['http://127.0.0.1:5173/ecole/', 'http://127.0.0.1:5173/'],
      ['http://127.0.0.1:5173/ecole/', 'http://127.0.0.1:5173'],
    ];
    for (const [base, value] of values) {
      const { result, stored } = await generate(
        'http://127.0.0.1:5173/ecole/orders',
        base,
        { check: 'urlContains', value },
        { check: 'urlContains', value: '/orders' },
      );

      assert.equal(result.status, 'complete', value);
      assert.deepEqual(stored, { check: 'urlContains', value: '/orders' }, value);
      assert.ok(
        result.steps[0]?.rejections.some((reason) =>
          reason.includes(`urlContains "${value}" is an absolute address of the application`),
        ),
        String(result.steps[0]?.rejections.join(' | ')),
      );
    }
  });

  it('n\'affaiblit jamais en silence : un urlContains absolu répété fait échouer l\'étape', async () => {
    const url = 'http://localhost:5173/orders';
    const check: Check = { check: 'urlContains', value: url };
    const { result, stored } = await generate(url, 'http://localhost:5173/', check, check, check);

    assert.equal(result.status, 'incomplete');
    assert.equal(stored, undefined, 'rien n\'est versionné, surtout pas « orders »');
  });

  /**
   * Sans schéma, une valeur échappe à la réécriture des adresses absolues —
   * mais elle peut épingler l'hôte, ou tenir dans la base et donc être vraie
   * sur chaque page de l'application.
   */
  it('rend au modèle un urlContains lié à l\'hôte ou contenu dans la base', async () => {
    const cases: [string, RegExp][] = [
      ['127.0.0.1:5173/ecole/orders', /names the host "127\.0\.0\.1:5173"/],
      ['', /only names the application/],
      ['/', /only names the application/],
      ['/ecole', /only names the application/],
      ['127.0.0.1', /only names the application/],
    ];
    for (const [value, reason] of cases) {
      const { result, stored } = await generate(
        'http://127.0.0.1:5173/ecole/orders',
        'http://127.0.0.1:5173/ecole/',
        { check: 'urlContains', value },
        { check: 'urlContains', value: '/orders' },
      );

      assert.equal(result.status, 'complete', value);
      assert.deepEqual(stored, { check: 'urlContains', value: '/orders' }, value);
      assert.ok(
        result.steps[0]?.rejections.some((rejection) => reason.test(rejection)),
        `${value}: ${result.steps[0]?.rejections.join(' | ')}`,
      );
    }
  });

  it('garde une adresse d\'une autre origine telle quelle', async () => {
    const url = 'https://auth.example.com/login';
    const { stored } = await generate(url, 'http://127.0.0.1:5173/', { check: 'urlEquals', value: url });

    assert.deepEqual(stored, { check: 'urlEquals', value: url });
  });

  it('ne touche pas un gabarit', async () => {
    process.env['QAI_TEST_ORDER'] = '42';
    try {
      const value = 'http://127.0.0.1:5173/orders/{{env.QAI_TEST_ORDER}}';
      const { result, stored } = await generate('http://127.0.0.1:5173/orders/42', 'http://127.0.0.1:5173/', {
        check: 'urlEquals',
        value,
      });

      assert.equal(result.status, 'complete');
      assert.deepEqual(stored, { check: 'urlEquals', value });
    } finally {
      delete process.env['QAI_TEST_ORDER'];
    }
  });

  it('masque un secret connu dans l\'avertissement', async () => {
    process.env['QAI_TEST_TOKEN'] = 'S3CR3T-tok';
    try {
      const withSecret = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: saisir le jeton QAI_TEST_TOKEN
  - id: s2
    expect: ${JSON.stringify(KEY)}
`);
      const url = 'http://127.0.0.1:5173/search?q=S3CR3T-tok';
      const provider = new ScriptedProvider([
        {
          actions: [{ kind: 'fill', target: { primary: { role: 'button', name: 'Valider' } }, value: '{{env.QAI_TEST_TOKEN}}' }],
        },
        { assertions: { [KEY]: { check: 'urlEquals', value: url } } },
      ]);
      const result = await generateResolution({
        scenario: withSecret,
        driver: new FakeDriver(url),
        provider,
      });

      assert.equal(result.status, 'complete', String(result.steps[1]?.rejections.join(' | ')));
      const reported = result.steps[1]?.rejections.join(' | ') ?? '';
      assert.match(reported, /is saved as an absolute URL/);
      assert.doesNotMatch(reported, /S3CR3T-tok/);
    } finally {
      delete process.env['QAI_TEST_TOKEN'];
    }
  });

  it('prévient, sans réécrire, quand aucune base n\'est donnée', async () => {
    const url = 'http://127.0.0.1:5173/orders';
    const { result, stored } = await generate(url, undefined, { check: 'urlEquals', value: url });

    assert.equal(result.status, 'complete');
    assert.deepEqual(stored, { check: 'urlEquals', value: url });
    assert.ok(
      result.steps[0]?.rejections.some((reason) => /urlEquals ".*" is saved as an absolute URL: pass baseUrl/.test(reason)),
      String(result.steps[0]?.rejections.join(' | ')),
    );
  });
});
