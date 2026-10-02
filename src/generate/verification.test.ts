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
// Confronté au schéma publié à chaque appel : voir conformance.ts.
import { generateResolution } from './conformance.ts';

const ORDER = node('text', 'Commande CMD-1');
const BUTTON = node('button', 'Valider');
const TREE = node('group', 'page', [ORDER, BUTTON]);
const FOUND: ResolveOutcome = { found: true, node: BUTTON, usedFallback: false };

/** Un écran figé, à l'adresse choisie par le test : seule l'adresse varie ici. */
class FakeDriver implements Driver {
  readonly platform: Platform;
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
  readonly #found: ResolveOutcome;

  constructor(location: string, root: UINode = TREE, found: ResolveOutcome = FOUND, platform: Platform = 'web') {
    this.#location = location;
    this.#root = root;
    this.#found = found;
    this.platform = platform;
  }

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async observe(): Promise<UISnapshot> {
    return {
      platform: this.platform,
      at: new Date().toISOString(),
      location: this.#location,
      viewport: { x: 0, y: 0, width: 1280, height: 800 },
      root: this.#root,
    };
  }
  async resolve(): Promise<ResolveOutcome> {
    return this.#found;
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
      const reported = result.steps[1]?.warnings.join(' | ') ?? '';
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
      result.steps[0]?.warnings.some((reason) => /urlEquals ".*" is saved as an absolute URL: pass baseUrl/.test(reason)),
      String(result.steps[0]?.rejections.join(' | ')),
    );
  });
});

/**
 * Un chemin d'origine écrit par le modèle — « / », « /orders » — se résolvait
 * contre la racine du serveur, pas contre la base : sous une base à préfixe,
 * « / » affirmait une page hors de l'application. Il suit désormais la même
 * règle que `navigate`.
 */
describe('urlEquals écrit en chemin d\'origine', () => {
  const KEY = "l'adresse est la bonne";
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ouvrir la page
    expect: ${JSON.stringify(KEY)}
`);

  async function stored(location: string, baseUrl: string, value: string, check: Check['check'] = 'urlEquals') {
    const result = await generateResolution({
      scenario,
      driver: new FakeDriver(location),
      provider: new ScriptedProvider([{ actions: [CLICK], assertions: { [KEY]: { check, value } } }]),
      baseUrl,
      attemptsPerStep: 1,
    });
    assert.equal(result.status, 'complete', String(result.steps[0]?.rejections.join(' | ')));
    return result.resolution.steps['s1']?.assertions?.[KEY];
  }

  it('écrit « . » pour « / » à la racine de la base, comme navigate', async () => {
    assert.deepEqual(await stored('http://127.0.0.1:5173/', 'http://127.0.0.1:5173/', '/'), {
      check: 'urlEquals',
      value: '.',
    });
  });

  it('rend un chemin de l\'application relatif à la base', async () => {
    assert.deepEqual(await stored('http://127.0.0.1:5173/orders?id=3', 'http://127.0.0.1:5173', '/orders?id=3'), {
      check: 'urlEquals',
      value: 'orders?id=3',
    });
    assert.deepEqual(await stored('http://127.0.0.1:5173/app/orders', 'http://127.0.0.1:5173/app/', '/app/orders'), {
      check: 'urlEquals',
      value: 'orders',
    });
  });

  it('garde un chemin hors de la base, et ne touche ni urlContains ni un gabarit', async () => {
    assert.deepEqual(await stored('http://127.0.0.1:5173/login', 'http://127.0.0.1:5173/app/', '/login'), {
      check: 'urlEquals',
      value: '/login',
    });
    assert.deepEqual(await stored('http://127.0.0.1:5173/login', 'http://127.0.0.1:5173/', '/login', 'urlContains'), {
      check: 'urlContains',
      value: '/login',
    });
    process.env['QAI_TEST_PATH'] = 'orders';
    try {
      assert.deepEqual(
        await stored('http://127.0.0.1:5173/orders', 'http://127.0.0.1:5173/', '/{{env.QAI_TEST_PATH}}'),
        { check: 'urlEquals', value: '/{{env.QAI_TEST_PATH}}' },
      );
    } finally {
      delete process.env['QAI_TEST_PATH'];
    }
  });
});

/**
 * Une vérification qui retrouve sa cible par la valeur qu'elle affirme, ou une
 * capture par la valeur qu'elle lit, fige la donnée et égare le motif d'échec.
 * Signalées, pas refusées : avec le vrai modèle, le refus produisait pire — la
 * valeur abandonnée au profit d'un `visible`, ou le mauvais élément capturé.
 */
describe('cibles trouvées par leur propre valeur', () => {
  const PRICE = node('text', '39,00 €');
  const COUNT = node('text', '1');
  const CART = node('link', 'Panier 1', [COUNT]);
  const QUANTITY = node('textbox', 'Quantité 1', [], { value: '1' });
  const TOTAL = node('group', 'Total', [PRICE]);
  const SCREEN = node('group', 'page', [CART, TOTAL, QUANTITY, BUTTON]);
  const KEY = 'le panier affiche 1 article';

  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter au panier
    expect: ${JSON.stringify(KEY)}
`);

  async function assess(...checks: unknown[]) {
    const [first, ...rest] = checks;
    const result = await generateResolution({
      scenario,
      driver: new FakeDriver('http://app.test/', SCREEN),
      provider: new ScriptedProvider([
        { actions: [CLICK], assertions: { [KEY]: first } },
        ...rest.map((check) => ({ assertions: { [KEY]: check } })),
      ]),
      attemptsPerStep: checks.length,
    });
    return { result, rejections: result.steps[0]?.rejections ?? [], warnings: result.steps[0]?.warnings ?? [] };
  }

  const tautologies: [string, unknown][] = [
    ['textEquals, nom exact', { check: 'textEquals', target: { role: 'text', name: '1' }, value: '1' }],
    ['textContains, nom qui contient la valeur', { check: 'textContains', target: { role: 'link', name: 'Panier 1' }, value: '1' }],
    ['textContains, fragment contains', { check: 'textContains', target: { role: 'link', name: { contains: 'Panier 1' } }, value: 'Panier 1' }],
    ['numberEquals, valeur numérique', { check: 'numberEquals', target: { role: 'link', name: 'Panier 1' }, value: 1 }],
    ['numberEquals, même nombre écrit autrement', { check: 'numberEquals', target: { role: 'text', name: '39,00 €' }, value: '39.00' }],
  ];

  for (const [label, check] of tautologies) {
    it(`signale une assertion trouvée par sa valeur, sans la refuser (${label})`, async () => {
      const { result, rejections, warnings } = await assess(check);
      assert.equal(result.status, 'complete', rejections.join(' | '));
      assert.match(warnings.join(' | '), /is located by the very value it asserts .*: when that value changes, replay reports "no element"/);
      assert.doesNotMatch(rejections.join(' | '), /very value/, 'un avertissement n\'est pas un rejet');
      assert.deepEqual(result.resolution.steps['s1']?.assertions?.[KEY], check);
    });
  }

  /**
   * Le refus rendait au modèle une consigne qui l'a poussé, mesuré, vers un
   * `visible` sur une cible structurelle : vert quand la valeur est fausse.
   * Rien de ce signalement ne doit donc repartir vers le modèle.
   */
  it('ne renvoie pas le signalement au modèle', async () => {
    const provider = new ScriptedProvider([
      { actions: [CLICK], assertions: { [KEY]: { check: 'textEquals', target: { role: 'text', name: '1' }, value: '1' } } },
    ]);
    const result = await generateResolution({
      scenario,
      driver: new FakeDriver('http://app.test/', SCREEN),
      provider,
      attemptsPerStep: 2,
    });
    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 1, 'aucun tour supplémentaire');
  });

  it('ne recopie pas dans le refus une valeur venue de l\'environnement', async () => {
    process.env['QAI_TEST_BADGE'] = 'S3CR3T-badge';
    try {
      const result = await generateResolution({
        scenario,
        driver: new FakeDriver('http://app.test/', node('group', 'page', [node('text', 'S3CR3T-badge'), BUTTON])),
        provider: new ScriptedProvider([
          {
            actions: [CLICK],
            assertions: {
              [KEY]: { check: 'textEquals', target: { role: 'text', name: '{{env.QAI_TEST_BADGE}}' }, value: '{{env.QAI_TEST_BADGE}}' },
            },
          },
        ]),
        attemptsPerStep: 1,
      });
      const reported = result.steps[0]?.warnings.join(' | ') ?? '';
      assert.match(reported, /located by the very value it asserts \("\*\*\*"\)/);
      assert.equal(result.status, 'complete');
      assert.doesNotMatch(reported, /S3CR3T/);
    } finally {
      delete process.env['QAI_TEST_BADGE'];
    }
  });

  it('ne signale ni une cible structurelle, ni une saisie comparée par sa valeur', async () => {
    const structural = { check: 'textEquals', target: { role: 'text', within: { role: 'link', name: { contains: 'Panier' } } }, value: '1' };
    const { result, rejections, warnings } = await assess(structural);
    assert.equal(result.status, 'complete', rejections.join(' | '));
    assert.deepEqual(result.resolution.steps['s1']?.assertions?.[KEY], structural);
    assert.deepEqual(warnings, []);

    // Le texte comparé d'un champ est sa valeur, pas son libellé : rien de tautologique.
    const field = { check: 'textEquals', target: { role: 'textbox', name: 'Quantité 1' }, value: '1' };
    assert.equal((await assess(field)).result.status, 'complete');
  });

  const CAPTURED = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ouvrir le panier
    capture:
      prix: le prix total
`);

  async function capture(...specs: unknown[]) {
    const [first, ...rest] = specs;
    const result = await generateResolution({
      scenario: CAPTURED,
      driver: new FakeDriver('http://app.test/', SCREEN),
      provider: new ScriptedProvider([
        { actions: [CLICK], captures: { prix: first } },
        ...rest.map((spec) => ({ captures: { prix: spec } })),
      ]),
      attemptsPerStep: specs.length,
    });
    return { result, rejections: result.steps[0]?.rejections ?? [], warnings: result.steps[0]?.warnings ?? [] };
  }

  for (const [label, spec] of [
    ['texte, nom exact', { from: { role: 'text', name: '39,00 €' }, extract: 'text' }],
    ['nombre, nom exact', { from: { role: 'text', name: '39,00 €' }, extract: 'number' }],
    ['nombre, fragment qui porte le nombre', { from: { role: 'text', name: { contains: '39,00' } }, extract: 'number' }],
  ] as const) {
    it(`signale une capture trouvée par la valeur qu'elle lit, sans la refuser (${label})`, async () => {
      const { result, rejections, warnings } = await capture(spec);
      assert.equal(result.status, 'complete', rejections.join(' | '));
      assert.doesNotMatch(rejections.join(' | '), /very value/);
      assert.match(warnings.join(' | '), /capture "prix" is located by the very value it reads .*: when that value changes, replay reports "target not found"/);
    });
  }

  it('ne signale ni une capture située par sa structure, ni par un libellé partiel', async () => {
    const structural = { from: { role: 'text', within: { role: 'group', name: 'Total' } }, extract: 'number' };
    const first = await capture(structural);
    assert.equal(first.result.status, 'complete');
    assert.deepEqual(first.result.resolution.steps['s1']?.captures, { prix: structural });
    assert.deepEqual(first.warnings, []);

    const partial = { from: { role: 'text', name: { contains: '€' } }, extract: 'number' };
    const second = await capture(partial);
    assert.equal(second.result.status, 'complete');
    assert.deepEqual(second.warnings, []);
  });
});

/**
 * Le repli ne sert que le jour où `primary` se perd. S'il porte l'identifiant
 * d'un autre nœud — la cellule autour du bouton, vu sur iOS avec le vrai
 * modèle — ce jour-là le geste part ailleurs, sans erreur.
 */
describe('repli qui désigne un autre élément', () => {
  const TRACK = node('button', 'Suivre le colis');
  const CELL = node('listitem', 'Commande 1042', [TRACK], { testId: 'order_1042' });
  const OWNED = node('button', 'Payer', [], { testId: 'pay' });
  const SCREEN = node('group', 'page', [CELL, OWNED]);
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: suivre le colis
`);

  for (const platform of ['web', 'ios'] as const) {
    it(`refuse l'identifiant du conteneur, puis accepte la correction (${platform})`, async () => {
      const primary = { role: 'button', name: 'Suivre le colis' } as const;
      const result = await generateResolution({
        scenario,
        driver: new FakeDriver(
          platform === 'web' ? 'http://app.test/' : 'com.example.shop/Commandes',
          SCREEN,
          { found: true, node: TRACK, usedFallback: false },
          platform,
        ),
        provider: new ScriptedProvider([
          { actions: [{ kind: 'click', target: { primary, fallback: { testId: 'order_1042' } } }] },
          { actions: [{ kind: 'click', target: { primary, fallback: { accessibilityId: 'order_1042' } } }] },
          { actions: [{ kind: 'click', target: { primary } }] },
        ]),
      });

      assert.equal(result.status, 'complete');
      const rejections = result.steps[0]?.rejections ?? [];
      assert.equal(rejections.length, 2);
      for (const reason of rejections) {
        assert.match(reason, /action 0: fallback "order_1042" is the identifier of another element \(the targeted element carries none\)/);
      }
      assert.deepEqual(result.resolution.steps['s1']?.actions, [{ kind: 'click', target: { primary } }]);
    });
  }

  it('accepte l\'identifiant du nœud trouvé, ou celui qu\'il hérite dans l\'arbre présenté', async () => {
    const target = { primary: { role: 'button', name: 'Payer' }, fallback: { testId: 'pay' } } as const;
    const own = await generateResolution({
      scenario,
      driver: new FakeDriver('http://app.test/', SCREEN, { found: true, node: OWNED, usedFallback: false }),
      provider: new ScriptedProvider([{ actions: [{ kind: 'click', target }] }]),
      attemptsPerStep: 1,
    });
    assert.equal(own.status, 'complete', String(own.steps[0]?.rejections.join(' | ')));

    // Le pilote décrit le bouton sans l'identifiant de son emballage anonyme ;
    // l'arbre présenté au modèle le lui a fait hériter — le même élément.
    const described = node('button', 'Payer');
    const inherited = await generateResolution({
      scenario,
      driver: new FakeDriver('http://app.test/', SCREEN, { found: true, node: described, usedFallback: false }),
      provider: new ScriptedProvider([{ actions: [{ kind: 'click', target }] }]),
      attemptsPerStep: 1,
    });
    assert.equal(inherited.status, 'complete', String(inherited.steps[0]?.rejections.join(' | ')));
  });
});

/**
 * Le décodage contraint n'est pas une garantie : en mode JSON simple, le
 * modèle a glissé un `fallback` dans la cible d'une assertion, et QAI l'a
 * versionné dans un fichier que son schéma refuse. Chaque forme fautive est
 * rendue au modèle avec la clé en cause.
 */
describe('forme stricte des propositions', () => {
  const KEY = 'la commande est affichée';
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: valider la commande
    expect: ${JSON.stringify(KEY)}
    capture:
      numero: le numéro de commande
`);
  const CAPTURE = { numero: { from: { role: 'text', within: { role: 'group', name: 'page' } , nth: 0 }, extract: 'text' } };

  async function propose(output: Record<string, unknown>) {
    const result = await generateResolution({
      scenario,
      driver: new FakeDriver('http://app.test/'),
      provider: new ScriptedProvider([
        { captures: CAPTURE, assertions: { [KEY]: SHOWN }, ...output },
        { captures: CAPTURE, assertions: { [KEY]: SHOWN } },
        { actions: [CLICK], captures: CAPTURE, assertions: { [KEY]: SHOWN } },
      ]),
      attemptsPerStep: 3,
    });
    return { result, first: result.steps[0]?.rejections[0] ?? '' };
  }

  const ACTION_CASES: [string, unknown, RegExp][] = [
    ['clé inconnue sur un geste', { kind: 'click', target: { primary: { role: 'button', name: 'Valider' } }, force: true }, /action 0: click has an unknown key "force"/],
    ['repli dans primary', { kind: 'click', target: { primary: { role: 'button', name: 'Valider', fallback: { testId: 'x' } } } }, /action 0: target\.primary has an unknown key "fallback": a locator only takes role, name, nth, within — a fallback belongs to an action target/],
    ['valeur absente', { kind: 'fill', target: { primary: { role: 'button', name: 'Valider' } } }, /action 0: fill needs "value"/],
    ['rôle inconnu', { kind: 'click', target: { primary: { role: 'bouton', name: 'Valider' } } }, /action 0: target\.primary\.role "bouton" is not a known role/],
    ['nom mal formé', { kind: 'click', target: { primary: { role: 'button', name: { equals: 'Valider' } } } }, /target\.primary\.name must be a string or \{ "contains": "\.\.\." \}/],
    ['within mal formé', { kind: 'click', target: { primary: { role: 'button', within: { role: 'list', nth: -1 } } } }, /target\.primary\.within\.nth must be an integer ≥ 0/],
    ['geste inconnu', { kind: 'tap', target: { primary: { role: 'button' } } }, /action 0: unknown gesture "tap"/],
    ['direction de swipe', { kind: 'swipe', direction: 'diagonal' }, /swipe "direction" must be up, down, left or right/],
  ];

  for (const [label, action, message] of ACTION_CASES) {
    it(`refuse un geste mal formé (${label}), puis accepte la correction`, async () => {
      const { result, first } = await propose({ actions: [action] });
      assert.match(first, message);
      assert.equal(result.status, 'complete');
    });
  }

  const CHECK_CASES: [string, unknown, RegExp][] = [
    ['repli dans la cible', { check: 'visible', target: { role: 'text', name: { contains: 'CMD-' }, fallback: { testId: 'order' } } }, /assertion "la commande est affichée": target has an unknown key "fallback"/],
    ['valeur oubliée', { check: 'textContains', target: { role: 'text', name: { contains: 'CMD-' } } }, /assertion "la commande est affichée": textContains needs a "value" — the text or number it compares the target to/],
    ['valeur jamais comparée', { check: 'visible', target: { role: 'text', name: { contains: 'CMD-' } }, value: 'CMD-1' }, /visible compares no value, so "value" would never be checked/],
    ['compte nul', { check: 'countAtLeast', target: { role: 'text' }, value: 0 }, /countAtLeast needs an integer "value" ≥ 1 \(0 is true on any screen\)/],
    ['état inconnu', { check: 'stateIs', target: { role: 'button', name: 'Valider' }, value: 'enabled' }, /stateIs needs a "value" among checked, disabled, selected/],
    ['cible sur une adresse', { check: 'urlEquals', value: '.', target: { role: 'text' } }, /urlEquals has an unknown key "target" — it bears on the address/],
    ['vérification inconnue', { check: 'textMatches', target: { role: 'text' }, value: 'x' }, /unknown check "textMatches"/],
    ['pas un objet', null, /assertion "la commande est affichée" has no "check"/],
  ];

  for (const [label, check, message] of CHECK_CASES) {
    it(`refuse une assertion mal formée (${label}), puis accepte la correction`, async () => {
      const { result, first } = await propose({ actions: [CLICK], assertions: { [KEY]: check } });
      assert.match(first, message);
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: SHOWN });
    });
  }

  it('refuse une capture mal formée, puis accepte la correction', async () => {
    const { result, first } = await propose({
      actions: [CLICK],
      captures: { numero: { from: { role: 'text', nth: 0, fallback: { testId: 'n' } }, extract: 'text' } },
    });
    assert.match(first, /capture "numero": from has an unknown key "fallback"/);
    assert.equal(result.status, 'complete');

    const extract = await propose({ actions: [CLICK], captures: { numero: { from: { role: 'text', nth: 0 }, extract: 'html' } } });
    assert.match(extract.first, /capture "numero" needs "extract": text, value or number/);
  });
});

/**
 * Sur iOS, la consigne décrivait `navigate` comme un CHEMIN et `urlEquals`
 * comme relatif à la racine, et le schéma ignorait `swipe` : le modèle était
 * poussé vers des gestes refusés. Ce qui diffère réellement — ce qu'est une
 * adresse — suit maintenant la plateforme.
 */
describe('génération selon la plateforme', () => {
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: valider
`);

  async function requestFor(platform: Platform): Promise<ModelRequest> {
    const provider = new ScriptedProvider([{ actions: [CLICK] }]);
    await generateResolution({
      scenario,
      driver: new FakeDriver(platform === 'web' ? 'http://app.test/' : 'com.example.shop/Commandes', TREE, FOUND, platform),
      provider,
      attemptsPerStep: 1,
    });
    return provider.requests[0] as ModelRequest;
  }

  function kinds(request: ModelRequest): string[] {
    const properties = request.responseSchema['properties'] as Record<string, { items: { oneOf: { properties: { kind: { const: string } } }[] } }>;
    return (properties['actions']?.items.oneOf ?? []).map((branch) => branch.properties.kind.const);
  }

  it('décrit des chemins sur le web, des liens profonds et l\'écran sur iOS', async () => {
    const web = await requestFor('web');
    assert.match(web.system ?? '', /Its "to" is a PATH relative to\s+the application root/);
    assert.match(web.system ?? '', /stored relative to its\s+root/);
    assert.doesNotMatch(web.system ?? '', /deep link/);

    const ios = await requestFor('ios');
    assert.doesNotMatch(ios.system ?? '', /PATH|relative to (its|the application) root/);
    assert.match(ios.system ?? '', /absolute deep link\s+\("myapp:\/\/orders"\) or "\." to relaunch the app/);
    assert.match(ios.system ?? '', /The location is "<bundle id>\/<navigation\s+bar title>"/);
    assert.doesNotMatch(JSON.stringify(ios.responseSchema), /relative to its root|relative to the application root/);
  });

  it('propose swipe, que le pilote qui ne sait pas glisser refuse à la vérification', async () => {
    assert.ok(kinds(await requestFor('ios')).includes('swipe'));

    const provider = new ScriptedProvider([{ actions: [{ kind: 'swipe', direction: 'up' }] }, { actions: [CLICK] }]);
    const result = await generateResolution({ scenario, driver: new FakeDriver('http://app.test/'), provider });
    assert.equal(result.status, 'complete');
    assert.match(result.steps[0]?.rejections[0] ?? '', /action 0: "swipe" is not supported on web/);
    assert.deepEqual(result.resolution.steps['s1']?.actions, [CLICK]);
  });
});
