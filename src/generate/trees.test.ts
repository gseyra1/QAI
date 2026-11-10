import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { fixture, FIXTURES } from '../driver/ios/fake-appium.ts';
import { readScreen } from '../driver/ios/source.ts';
import { pruneInteractive, prunesLikeBuiltIns } from '../driver/prune.ts';
import type {
  Action,
  Capabilities,
  Driver,
  LaunchTarget,
  ObserveOptions,
  PreparedState,
  ResolvedTarget,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import { evaluateCheck, readCapture, textOf, toNumber } from '../engine/assert.ts';
import { node } from '../engine/fixtures.ts';
import { matchNodes, matchOne } from '../engine/match.ts';
import { runScenario } from '../engine/run.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import type { CaptureSpec, Check } from '../resolution/types.ts';
import { parseScenario } from '../scenario/load.ts';
// Confronté au schéma publié à chaque appel : voir conformance.ts.
import { generateResolution } from './conformance.ts';
import { generateResolution as generateUnchecked } from './generate.ts';
import { tautologicalCheck } from './proposal.ts';
import { renderTree } from './render.ts';

/**
 * Un pilote tiers : `interactiveOnly` élague par les règles des intégrés, mais
 * rien ne le déclare. Il est lu comme en 0.5.0.
 */
class ThirdParty implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities: Capabilities = { hover: true, swipe: false, navigateByUrl: true, deepLink: true };
  readonly acted: Action[] = [];
  /** Chaque lecture, dans l'ordre : vrai pour une lecture élaguée. */
  readonly reads: boolean[] = [];
  readonly #screen: (acted: readonly Action[]) => UINode;

  constructor(screen: UINode | ((acted: readonly Action[]) => UINode)) {
    this.#screen = typeof screen === 'function' ? screen : () => screen;
  }

  protected tree(options: ObserveOptions | undefined): UINode {
    const root = this.#screen(this.acted);
    return options?.interactiveOnly === true ? pruneInteractive(root) : root;
  }

  async observe(options?: ObserveOptions): Promise<UISnapshot> {
    this.reads.push(options?.interactiveOnly === true);
    const root = this.tree(options);
    return { platform: 'web', at: '', location: 'http://app.test/', viewport: { x: 0, y: 0, width: 1280, height: 800 }, root };
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    const matched = matchNodes(this.#screen(this.acted), target.primary);
    return matched.length === 1
      ? { found: true, node: matched[0] as UINode, usedFallback: false }
      : { found: false, reason: matched.length === 0 ? 'no-match' : 'ambiguous', matches: matched.length };
  }

  async act(action: Action): Promise<void> {
    this.acted.push(action);
  }

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async settle(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** Élague comme les intégrés, et le déclare : une lecture complète, l'arbre montré en est tiré. */
class BuiltIn extends ThirdParty {
  override async observe(options?: ObserveOptions): Promise<UISnapshot> {
    return super.observe(options);
  }
}
prunesLikeBuiltIns(BuiltIn.prototype.observe);

/** Un pilote tiers qui n'élague pas : l'arbre complet, quelles que soient les options. */
class NoPruning extends ThirdParty {
  protected override tree(): UINode {
    return super.tree(undefined);
  }
}

/** Un pilote tiers qui ne fait que déléguer au pilote web. */
class Delegating implements Driver {
  readonly #inner: PlaywrightWebDriver;

  constructor(inner: PlaywrightWebDriver) {
    this.#inner = inner;
  }

  get platform() {
    return this.#inner.platform;
  }
  get capabilities() {
    return this.#inner.capabilities;
  }
  launch(target: LaunchTarget): Promise<void> {
    return this.#inner.launch(target);
  }
  applyState(state: PreparedState): Promise<void> {
    return this.#inner.applyState(state);
  }
  observe(options?: ObserveOptions): Promise<UISnapshot> {
    return this.#inner.observe(options);
  }
  resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    return this.#inner.resolve(target);
  }
  act(action: Action): Promise<void> {
    return this.#inner.act(action);
  }
  settle(timeoutMs?: number): Promise<void> {
    return this.#inner.settle(timeoutMs);
  }
  dispose(): Promise<void> {
    return this.#inner.dispose();
  }
}

/** Rend les réponses dans l'ordre ; un appel de trop fait échouer le test. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  readonly #outputs: unknown[];

  constructor(outputs: unknown[]) {
    this.#outputs = outputs;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const output = this.#outputs[this.requests.length - 1];
    assert.ok(output !== undefined, `réponse ${this.requests.length} non scénarisée`);
    return { output, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const capturing = parseScenario(`
id: t
title: t
steps:
  - id: s1
    capture:
      reference: la valeur affichée
`);

const reading = (from: unknown) => ({ captures: { reference: { from, extract: 'text' } } });
const capturedFrom = (result: Awaited<ReturnType<typeof generateResolution>>) =>
  result.resolution.steps['s1']?.captures?.['reference']?.from;
const expecting = (key: string) => parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: ${JSON.stringify(key)}\n`);

const page = (...children: UINode[]): UINode => node('group', 'page', children);
const unnamed = (): UINode => node('text', '');
/** Un conteneur qui a une boîte mais n'est pas visible : transparent, replié. */
const drawer = (...children: UINode[]): UINode => node('group', '', children, { state: { visible: false } });

/** Le refus quand l'arbre du modèle accepte et que l'arbre complet dément : une seule forme. */
const READS_ANOTHER =
  'replay would read another element: replay also sees the unnamed and hidden elements your tree leaves out. Name the element with { "contains": "..." } on a stable part of its name, or put it within a named container, rather than using nth.';
const CAPTURE_ELSEWHERE = `capture "reference": found on your tree, but ${READS_ANOTHER}`;
const NOT_FOUND = 'capture "reference": target not found or ambiguous on this screen';
const assertionElsewhere = (key: string) => `assertion "${key}": true on your tree, but ${READS_ANOTHER}`;

describe('deux arbres, pilote intégré : une capture lit le même élément sur les deux', () => {
  it('refuse une cible unique sur l\'arbre montré, ambiguë au rejeu, par le message fixe (#48)', async () => {
    const driver = new BuiltIn(page(unnamed(), node('text', 'Solde : 42')));
    const provider = new ScriptedProvider([
      reading({ role: 'text' }),
      // La position du rejeu : 0.5.0 la refusait, elle reste refusée.
      reading({ role: 'text', nth: 1 }),
      reading({ role: 'text', name: { contains: 'Solde' } }),
    ]);

    const result = await generateResolution({ scenario: capturing, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, [CAPTURE_ELSEWHERE, NOT_FOUND]);
    assert.deepEqual(capturedFrom(result), { role: 'text', name: { contains: 'Solde' } });
    // Le refus atteint le modèle.
    assert.ok(JSON.stringify(provider.requests[1]?.messages).includes(JSON.stringify(READS_ANOTHER).slice(1, -1)));
  });

  it('refuse une position qui lit un autre élément au rejeu (#48)', async () => {
    const driver = new BuiltIn(page(node('text', 'Order A is confirmed'), unnamed(), node('text', 'Order B is confirmed')));
    const provider = new ScriptedProvider([
      reading({ role: 'text', nth: 1 }),
      reading({ role: 'text', name: { contains: 'Order B' } }),
    ]);

    const result = await generateResolution({ scenario: capturing, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, [CAPTURE_ELSEWHERE]);
  });

  it('accepte une position qui lit le même élément sur les deux arbres, et le rejeu la passe', async () => {
    const screen = () => page(node('text', '42'), unnamed());
    const provider = new ScriptedProvider([reading({ role: 'text' }), reading({ role: 'text', nth: 0 })]);

    const result = await generateResolution({ scenario: capturing, driver: new BuiltIn(screen()), provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, [CAPTURE_ELSEWHERE]);
    assert.deepEqual(capturedFrom(result), { role: 'text', nth: 0 });
    const report = await runScenario({ scenario: capturing, resolution: result.resolution, driver: new BuiltIn(screen()), assertTimeoutMs: 0 });
    assert.equal(report.status, 'passed');
  });

  it('accepte ce que les deux arbres lisent pareil, comme 0.5.0', async () => {
    const driver = new BuiltIn(page(unnamed(), node('group', 'Solde', [node('text', '42')])));
    const provider = new ScriptedProvider([reading({ role: 'text', within: { role: 'group', name: 'Solde' } })]);

    const result = await generateResolution({ scenario: capturing, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, []);
  });

  it('ne lit jamais la copie cachée avant l\'élément montré, et ne conseille aucune position (C3)', async () => {
    const screen = page(drawer(node('text', '42'), node('text', 'Ancien')), unnamed(), node('text', '42'));
    const provider = new ScriptedProvider([
      reading({ role: 'text' }),
      reading({ role: 'text', name: '42' }),
      // Le troisième de l'arbre montré, l'élément visible : au rejeu, le texte sans nom.
      reading({ role: 'text', nth: 2 }),
      reading({ role: 'text', nth: 3 }),
    ]);

    const result = await generateResolution({ scenario: capturing, driver: new BuiltIn(screen), provider, attemptsPerStep: 4 });

    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.steps[0]?.rejections, [NOT_FOUND, NOT_FOUND, CAPTURE_ELSEWHERE, NOT_FOUND]);
  });

  it('refuse sur un pilote intégré ce qu\'un pilote tiers accepte, comme 0.5.0', async () => {
    // Une feuille nommée que l'élagage retire, lue la première au rejeu.
    const tree = () => page(node('group', '42'), node('text', '42'));
    const from = { name: '42', nth: 0 };

    const builtIn = await generateResolution({ scenario: capturing, driver: new BuiltIn(tree()), provider: new ScriptedProvider([reading(from)]), attemptsPerStep: 1 });
    const third = await generateResolution({ scenario: capturing, driver: new ThirdParty(tree()), provider: new ScriptedProvider([reading(from)]), attemptsPerStep: 1 });

    assert.deepEqual(builtIn.steps[0]?.rejections, [CAPTURE_ELSEWHERE]);
    assert.equal(third.status, 'complete');
  });
});

describe('deux arbres, pilote intégré : une assertion tient sur les deux et y lit les mêmes éléments', () => {
  it('refuse textEquals dont la première correspondance est une autre au rejeu, même vraie sur les deux', async () => {
    const KEY = 'le solde est 42';
    // Une feuille nommée que l'élagage retire, lue en premier au rejeu.
    const driver = new BuiltIn(page(node('group', '42'), node('text', '42')));
    const check: Check = { check: 'textEquals', target: { name: '42' }, value: '42' };
    const provider = new ScriptedProvider([
      { assertions: { [KEY]: check } },
      { assertions: { [KEY]: { ...check, target: { role: 'text', name: '42' } } } },
    ]);

    const result = await generateResolution({ scenario: expecting(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, [assertionElsewhere(KEY)]);
  });

  it('refuse numberEquals et stateIs dont la première correspondance est une autre au rejeu, même vrais sur les deux', async () => {
    const checked = { state: { visible: true, checked: true } };
    const cases: Array<[string, UINode, Check]> = [
      ['le solde vaut 42', page(node('group', '42'), node('text', '42')), { check: 'numberEquals', target: { name: '42' }, value: '42' }],
      ['la case est cochée', page(node('group', 'Agree', [], checked), node('checkbox', 'Agree', [], checked)), { check: 'stateIs', target: { name: 'Agree' }, value: 'checked' }],
    ];
    for (const [KEY, screen, check] of cases) {
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

      const result = await generateResolution({ scenario: expecting(KEY), driver: new BuiltIn(screen), provider, attemptsPerStep: 1 });

      assert.equal(result.status, 'incomplete', check.check);
      assert.deepEqual(result.steps[0]?.rejections, [assertionElsewhere(KEY)], check.check);
    }
  });

  it('refuse visible dont l\'élément montré n\'est pas lu au rejeu, même vrai sur les deux', async () => {
    const KEY = 'le solde est affiché';
    const driver = new BuiltIn(page(drawer(node('text', '42'), node('text', 'Ancien')), unnamed(), node('text', '42')));
    const provider = new ScriptedProvider([{ assertions: { [KEY]: { check: 'visible', target: { role: 'text', nth: 2 } } } }]);

    const result = await generateResolution({ scenario: expecting(KEY), driver, provider, attemptsPerStep: 1 });

    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.steps[0]?.rejections, [assertionElsewhere(KEY)]);
  });

  it('refuse un absent que le rejeu dément', async () => {
    const KEY = "aucune erreur n'est affichée";
    // Une alerte visible sans nom ni enfant : l'élagage la retire.
    const driver = new BuiltIn(page(node('alert', ''), node('text', 'Paiement')));
    const provider = new ScriptedProvider([{ assertions: { [KEY]: { check: 'absent', target: { role: 'alert' } } } }]);

    const result = await generateResolution({ scenario: expecting(KEY), driver, provider, attemptsPerStep: 1 });

    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.steps[0]?.rejections, [assertionElsewhere(KEY)]);
  });

  /** Une liste vide mais visible, que l'élagage retire : la liste 0 du modèle est la 1 du rejeu. */
  const lists = (): UINode =>
    page(
      node('list', ''),
      node('list', 'Wishlist', [node('listitem', 'Chair'), node('listitem', 'Desk')]),
      node('list', 'Cart', [node('listitem', 'Table'), node('listitem', 'Sofa'), node('listitem', 'Rug')]),
    );

  it('refuse un countAtLeast que le rejeu dément', async () => {
    const KEY = 'la liste a deux produits';
    const check: Check = { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', nth: 0 } }, value: 2 };
    const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

    const result = await generateResolution({ scenario: expecting(KEY), driver: new BuiltIn(lists()), provider, attemptsPerStep: 1 });

    assert.deepEqual(result.steps[0]?.rejections, [assertionElsewhere(KEY)]);
  });

  it('n\'exige d\'absent et de countAtLeast que de tenir sur les deux arbres', async () => {
    // La liste 1 du modèle est « Cart », celle du rejeu « Wishlist » : chacune tient.
    const within = { role: 'list', nth: 1 } as const;
    const checks: Check[] = [
      { check: 'countAtLeast', target: { role: 'listitem', within }, value: 2 },
      { check: 'absent', target: { role: 'listitem', name: 'Lamp', within } },
    ];
    for (const check of checks) {
      const KEY = 'le panier';
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

      const result = await generateResolution({ scenario: expecting(KEY), driver: new BuiltIn(lists()), provider, attemptsPerStep: 1 });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.deepEqual(result.steps[0]?.rejections, []);
    }
  });

  it('juge en temps linéaire une cible qui correspond à des dizaines de milliers d\'éléments', { timeout: 60_000 }, async () => {
    const KEY = 'le tableau est affiché';
    const cells = Array.from({ length: 80_000 }, (_, index) => node('cell', `C${index}`));
    const driver = new BuiltIn(page(node('table', 'Orders', [...cells, unnamed()])));
    const check: Check = { check: 'visible', target: { role: 'cell', within: { role: 'table', name: 'Orders' } } };
    const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

    const started = performance.now();
    const result = await generateUnchecked({ scenario: expecting(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    // Chercher chaque identifiant dans la liste entière coûtait n² : des minutes ici.
    assert.ok(performance.now() - started < 5_000, `${Math.round(performance.now() - started)} ms`);
  });
});

describe('deux arbres : les signalements', () => {
  it('garde le signalement de valeur figée que seul l\'arbre montré donne', async () => {
    const KEY = 'le stock est 40';
    // Au rejeu, une correspondance de plus porte une valeur : seul l'arbre montré signale.
    const driver = new BuiltIn(page(node('group', 'Stock 40', [], { value: '40' }), node('text', 'Stock 40')));
    const provider = new ScriptedProvider([
      { assertions: { [KEY]: { check: 'textContains', target: { name: { contains: '40' } }, value: '40' } } },
    ]);

    const result = await generateResolution({ scenario: expecting(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('is located by the very value it asserts')));
  });

  const comparing = (key: string, capture: string) =>
    parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: ${JSON.stringify(key)}\n    capture:\n      ${capture}: la référence\n`);
  const cannotFail = (key: string, capture: string) =>
    `assertion "${key}" compares {{${capture}}} with the element it was just read from: it cannot fail`;

  it('garde la comparaison avec soi-même que seul l\'arbre montré donne (C4)', async () => {
    const KEY = 'la commande {{reference}} est affichée';
    const driver = new BuiltIn(page(node('text', 'Order CMD-1'), unnamed()));
    const provider = new ScriptedProvider([
      {
        captures: { reference: { from: { role: 'text', name: { contains: 'Order' } }, extract: 'text', after: 'Order ' } },
        assertions: { [KEY]: { check: 'textContains', target: { role: 'text' }, value: '{{reference}}' } },
      },
    ]);

    const result = await generateResolution({ scenario: comparing(KEY, 'reference'), driver, provider });

    assert.equal(result.status, 'complete');
    assert.ok(result.steps[0]?.warnings.includes(cannotFail(KEY, 'reference')), JSON.stringify(result.steps[0]?.warnings));
  });

  it('signale la comparaison avec soi-même que seul l\'arbre du rejeu donne', async () => {
    const KEY = 'une référence {{ref}} est affichée';
    // Un emballage sans nom, à enfant unique, que l'élagage efface : le groupe 1 du
    // modèle est « Panel », celui du rejeu l'emballage de la référence capturée.
    const driver = new BuiltIn(page(node('group', '', [node('text', 'Ref 42')]), node('group', 'Panel', [node('text', 'Ref 42 copy')])));
    const provider = new ScriptedProvider([
      {
        captures: { ref: { from: { role: 'text', name: { contains: 'Ref' }, nth: 0 }, extract: 'text', after: 'Ref ' } },
        assertions: {
          [KEY]: { check: 'countAtLeast', target: { role: 'text', name: { contains: '{{ref}}' }, within: { role: 'group', nth: 1 } }, value: 1 },
        },
      },
    ]);

    const result = await generateResolution({ scenario: comparing(KEY, 'ref'), driver, provider });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.deepEqual(result.steps[0]?.warnings, [cannotFail(KEY, 'ref')]);
  });
});

describe('deux arbres : déjà vraie avant le geste', () => {
  const acting = (key: string, intent: string) =>
    parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    do: ${intent}\n    expect: ${JSON.stringify(key)}\n`);

  it('interroge une assertion déjà vraie avant sur l\'arbre du rejeu seulement', async () => {
    const KEY = 'la liste montre au moins 3 produits';
    // Un emplacement vide, que l'élagage retire : 2 produits montrés, 3 au rejeu.
    const driver = new BuiltIn((acted) =>
      page(
        node('list', 'Produits', [
          node('listitem', 'Chaise'),
          node('listitem', 'Table'),
          ...(acted.length > 0 ? [node('listitem', 'Lampe')] : []),
          node('listitem', ''),
        ]),
        node('button', 'Ajouter'),
      ),
    );
    const check: Check = { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', name: 'Produits' } }, value: 3 };
    const proposal = { actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Ajouter' } } }], assertions: { [KEY]: check } };
    const provider = new ScriptedProvider([proposal, proposal]);

    const result = await generateResolution({ scenario: acting(KEY, 'ajouter la lampe'), driver, provider });

    assert.equal(result.status, 'complete');
    assert.match(result.steps[0]?.rejections[0] ?? '', /is already true on the current screen, before any gesture/);
    assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('was already true before the gesture')));
  });

  it('interroge toujours, comme 0.5.0, une assertion déjà vraie avant sur l\'arbre montré seul', async () => {
    const KEY = "aucune erreur n'est affichée";
    // Avant le geste, une alerte sans nom que l'élagage retire : absente de l'arbre montré seulement.
    const driver = new BuiltIn((acted) => page(...(acted.length === 0 ? [node('alert', '')] : []), node('button', 'Fermer')));
    const proposal = {
      actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Fermer' } } }],
      assertions: { [KEY]: { check: 'absent', target: { role: 'alert' } } },
    };
    const provider = new ScriptedProvider([proposal, proposal]);

    const result = await generateResolution({ scenario: acting(KEY, 'fermer le message'), driver, provider });

    assert.equal(result.status, 'complete');
    assert.match(result.steps[0]?.rejections[0] ?? '', /is already true on the current screen, before any gesture/);
  });
});

describe('deux arbres : les lectures', () => {
  const KEY = 'le total est affiché';
  const total = (value: string) => ({ assertions: { [KEY]: { check: 'textEquals', target: { role: 'text', within: { role: 'group', name: 'Total' } }, value } } });
  const screen = () => page(node('group', 'Total', [node('text', '129')]), node('group', 'Interne, jamais montré'));

  it('lit un pilote intégré une fois par regard, en entier, et jamais l\'écran d\'avant d\'une étape qui ne fait que vérifier', async () => {
    const driver = new BuiltIn(screen());
    const provider = new ScriptedProvider([total('130'), total('129')]);

    const result = await generateResolution({ scenario: expecting(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    // Le regard d'où part la phase B, puis un par réponse ; aucun sur l'écran
    // d'avant, que 0.5.0 lisait sans s'en servir.
    assert.deepEqual(driver.reads, [false, false, false]);
    // L'arbre n'est pas renvoyé au second tour.
    assert.equal(JSON.stringify(provider.requests[1]?.messages.at(-1)).includes('Total'), false);
  });

  it('lit un pilote tiers comme 0.5.0 : élagué seulement, écran d\'avant compris', async () => {
    const driver = new ThirdParty(screen());
    const provider = new ScriptedProvider([total('130'), total('129')]);

    const result = await generateResolution({ scenario: expecting(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    // Compté sur 0.5.0 avec la même étape et les mêmes réponses.
    assert.deepEqual(driver.reads, [true, true, true, true]);
    // L'écran d'avant est lu, mais une étape sans geste n'est jamais interrogée sur lui.
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(result.steps[0]?.warnings, []);
  });

  it('envoie au modèle l\'arbre élagué, en phase A comme en phase B', async () => {
    const scenario = parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    do: valider\n    expect: ${JSON.stringify(KEY)}\n`);
    const tree = page(node('group', 'Total', [node('text', '129')]), node('group', 'Interne, jamais montré'), node('button', 'Valider'));
    const driver = new BuiltIn((acted) => (acted.length > 0 ? tree : page(node('button', 'Valider'), node('group', 'Interne, jamais montré'))));
    const click = { kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } };
    const provider = new ScriptedProvider([{ actions: [click], ...total('130') }, total('129')]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    const sent = JSON.stringify(provider.requests);
    assert.equal(sent.includes('Interne'), false);
    assert.ok(sent.includes(JSON.stringify(renderTree(pruneInteractive(tree))).slice(1, -1)));
  });
});

describe('deux arbres, pilote tiers : comme 0.5.0', () => {
  for (const [label, screen, from] of [
    ['cible unique sur sa lecture, ambiguë sur l\'arbre complet', page(unnamed(), node('text', 'Solde : 42')), { role: 'text' }],
    ['position qui lit un autre élément sur l\'arbre complet', page(node('text', 'A'), unnamed(), node('text', 'B')), { role: 'text', nth: 1 }],
  ] as const) {
    it(`juge sur sa seule lecture élaguée : ${label}`, async () => {
      const driver = new ThirdParty(screen);

      const result = await generateResolution({ scenario: capturing, driver, provider: new ScriptedProvider([reading(from)]) });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.steps[0]?.rejections, []);
      assert.ok(driver.reads.every((pruned) => pruned), JSON.stringify(driver.reads));
    });
  }

  it('fonctionne avec un pilote tiers qui n\'élague pas', async () => {
    const driver = new NoPruning(page(node('group', 'Solde', [unnamed(), node('text', '42')]), node('group', 'Note')));
    const within = { role: 'group', name: 'Solde' };
    const provider = new ScriptedProvider([reading({ role: 'text', within }), reading({ role: 'text', nth: 1, within })]);

    const result = await generateResolution({ scenario: capturing, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, [NOT_FOUND]);
    assert.deepEqual(capturedFrom(result), { role: 'text', nth: 1, within });
  });

  describe('une valeur vivante', () => {
    /** Un écran qui avance à chaque lecture, comme un minuteur. */
    const ticking = (screen: (tick: number) => UINode): ThirdParty => {
      let tick = 0;
      return new ThirdParty(() => screen((tick += 1)));
    };
    const KEY = 'the status shows the elapsed seconds';
    const comparing = (capture: string) =>
      parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n${capture}    expect: ${JSON.stringify(KEY)}\n`);
    /** Le même nombre en deux endroits, rendus ensemble à chaque lecture. */
    const status = (tick: number): UINode =>
      page(node('listitem', 'Timer', [node('text', `Updated ${700 + tick} s ago`)]), node('text', `Status: ${700 + tick} s`));
    /** Un minuteur et son récapitulatif, chacun suivi d'une icône sans nom que l'élagage retire. */
    const mirror = (tick: number): UINode =>
      page(
        node('group', 'Timer', [node('text', 'Elapsed'), node('text', String(700 + tick)), unnamed()]),
        node('group', 'Summary', [node('text', 'Total time'), node('text', String(700 + tick)), unnamed()]),
      );

    const cases: [string, string, (tick: number) => UINode, Record<string, unknown>, Check][] = [
      [
        'textContains sur un autre texte',
        '      elapsed: the elapsed seconds\n',
        status,
        { elapsed: { from: { role: 'text', name: { contains: 's ago' } }, extract: 'number' } },
        { check: 'textContains', target: { role: 'text', name: { contains: 'Status' } }, value: '{{elapsed}}' },
      ],
      [
        'textEquals par position, l\'icône après la valeur',
        '      elapsed: the elapsed seconds\n',
        mirror,
        { elapsed: { from: { role: 'text', nth: 1, within: { role: 'group', name: 'Timer' } }, extract: 'number' } },
        { check: 'textEquals', target: { role: 'text', nth: 1, within: { role: 'group', name: 'Summary' } }, value: '{{elapsed}}' },
      ],
    ];

    for (const [label, capture, screen, captures, check] of cases) {
      it(`accepte ${label}, sans signalement, et le rejeu le passe`, async () => {
        const scenario = comparing(capture);
        const provider = new ScriptedProvider([{ captures, assertions: { [KEY]: check } }]);

        const result = await generateResolution({ scenario, driver: ticking(screen), provider, attemptsPerStep: 1 });

        assert.equal(result.status, 'complete', JSON.stringify(result.steps));
        assert.deepEqual(result.steps[0]?.rejections, []);
        assert.deepEqual(result.steps[0]?.warnings, []);
        const report = await runScenario({ scenario, resolution: result.resolution, driver: ticking(screen), assertTimeoutMs: 0 });
        assert.equal(report.status, 'passed', JSON.stringify(report.steps));
      });
    }
  });
});

describe('deux arbres, sur un vrai navigateur', () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function open(body: string): Promise<{ driver: PlaywrightWebDriver; url: string }> {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="en"><body>${body}</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    await driver.launch({ entry: url });
    return { driver, url };
  }

  it('accepte un titre dans un emballage sans boîte, comme 0.5.0, et le rejeu le passe (C1)', async () => {
    const { driver, url } = await open(
      '<h2>Account</h2><div style="display:contents"><h1>Welcome back</h1><p>Your orders</p></div>',
    );
    try {
      const KEY = 'the page says Welcome back';
      const scenario = expecting(KEY);
      const provider = new ScriptedProvider([
        { assertions: { [KEY]: { check: 'visible', target: { role: 'heading', name: 'Welcome back' } } } },
      ]);

      const result = await generateResolution({ scenario, driver, provider, baseUrl: url });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.steps[0]?.rejections, []);
      const report = await runScenario({ scenario, resolution: result.resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
      assert.equal(report.status, 'passed');
    } finally {
      await driver.dispose();
    }
  });

  it('accepte textContains dans la n-ième ligne d\'un tableau à première cellule vide', async () => {
    const { driver, url } = await open(
      '<table><tr><th></th><th>Order</th><th>Status</th></tr><tr><td></td><td>CMD-1</td><td>Paid</td></tr><tr><td></td><td>CMD-2</td><td>Pending</td></tr></table>',
    );
    try {
      const KEY = 'the second order is pending';
      const check: Check = { check: 'textContains', target: { role: 'cell', within: { role: 'row', nth: 2 } }, value: 'Pending' };
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

      const result = await generateResolution({ scenario: expecting(KEY), driver, provider, baseUrl: url });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.steps[0]?.rejections, []);
    } finally {
      await driver.dispose();
    }
  });

  it('refuse countAtLeast qui ne tient que par un emplacement vide, comme 0.5.0', async () => {
    const { driver, url } = await open(
      '<ul aria-label="Products"><li>Chair</li><li>Table</li><li style="height:20px;border:1px solid #ccc"></li></ul>',
    );
    try {
      const KEY = 'the list shows at least 3 products';
      const check: Check = { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', name: 'Products' } }, value: 3 };
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }, { assertions: { [KEY]: check } }]);

      const result = await generateResolution({ scenario: expecting(KEY), driver, provider, baseUrl: url, attemptsPerStep: 2 });

      assert.equal(result.status, 'incomplete');
      assert.deepEqual(result.steps[0]?.rejections, [
        `assertion "${KEY}" false on this screen: expected at least 3, observed 2`,
        `assertion "${KEY}" false on this screen: expected at least 3, observed 2`,
      ]);
    } finally {
      await driver.dispose();
    }
  });

  it('accepte un conteneur que sa position désigne autrement au rejeu, quand l\'élément lu est le même', async () => {
    // Des emballages à enfant unique, effacés par l'élagage : le groupe 2 du modèle
    // est la première carte, celui du rejeu la grille qui la contient.
    const { driver, url } = await open(
      '<main><div class="grid"><div class="col"><div class="card"><span>Chair</span><span>129 €</span></div></div>' +
        '<div class="col"><div class="card"><span>Table</span><span>349 €</span></div></div></div></main>',
    );
    try {
      const KEY = 'the first product costs 129';
      const check: Check = { check: 'numberEquals', target: { role: 'text', nth: 1, within: { role: 'group', nth: 2 } }, value: '129' };
      const full = (await driver.observe()).root;
      const card = matchNodes(pruneInteractive(full), { role: 'group', nth: 2 })[0];
      assert.notEqual(card?.id, matchNodes(full, { role: 'group', nth: 2 })[0]?.id);
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

      const result = await generateResolution({ scenario: expecting(KEY), driver, provider, baseUrl: url, attemptsPerStep: 1 });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.deepEqual(result.steps[0]?.rejections, []);
      const report = await runScenario({ scenario: expecting(KEY), resolution: result.resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
      assert.equal(report.status, 'passed');
    } finally {
      await driver.dispose();
    }
  });

  it('refuse la position d\'une ligne qui lit une autre ligne au rejeu', async () => {
    const { driver, url } = await open(
      '<table><tr><td>Order</td><td>Status</td></tr><tr style="height:10px"></tr><tr><td>CMD-1</td><td>Paid</td></tr><tr><td>CMD-2</td><td>Pending</td></tr></table>',
    );
    try {
      const KEY = 'the second order is pending';
      const provider = new ScriptedProvider([
        { assertions: { [KEY]: { check: 'textEquals', target: { role: 'cell', nth: 1, within: { role: 'row', nth: 2 } }, value: 'Pending' } } },
      ]);

      const result = await generateResolution({ scenario: expecting(KEY), driver, provider, baseUrl: url, attemptsPerStep: 1 });

      assert.equal(result.status, 'incomplete');
      assert.deepEqual(result.steps[0]?.rejections, [assertionElsewhere(KEY)]);
    } finally {
      await driver.dispose();
    }
  });

  it('accepte, par un pilote qui délègue au pilote web, une position suivie d\'une icône sur une valeur vivante', async () => {
    const { driver: inner, url } = await open(
      '<div role="group" aria-label="Timer"><span>Elapsed</span> <span id="t">0</span> ' +
        '<span style="display:inline-block;width:12px;height:12px"></span></div>' +
        '<script>let reads = 0; const t = document.getElementById("t");' +
        't.getBoundingClientRect = function () { reads += 1; this.firstChild.data = String(reads); return Element.prototype.getBoundingClientRect.call(this); };</script>',
    );
    const driver = new Delegating(inner);
    try {
      const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n      elapsed: the elapsed time\n');
      const from = { role: 'text', nth: 1, within: { role: 'group', name: 'Timer' } };
      // Sur l'arbre complet, l'icône est le troisième texte.
      assert.equal(matchNodes((await inner.observe()).root, { role: 'text', within: { role: 'group', name: 'Timer' } }).length, 3);
      const provider = new ScriptedProvider([{ captures: { elapsed: { from, extract: 'number' } } }]);

      const result = await generateResolution({ scenario, driver, provider, baseUrl: url, attemptsPerStep: 1 });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.deepEqual(result.steps[0]?.warnings, []);
      const report = await runScenario({ scenario, resolution: result.resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
      assert.equal(report.status, 'passed');
    } finally {
      await driver.dispose();
    }
  });

  it('n\'envoie aucun texte de l\'arbre complet seul, ni par une capture ni par une assertion (C7, C2)', async () => {
    const { driver, url } = await open(
      [
        // Des feuilles nommées sans rôle propre : l'élagage les retire, le rejeu les lit.
        '<div aria-label="Note de service CACHEE" style="width:10px;height:10px"></div>',
        '<div title="Total rembourse CACHE" style="width:10px;height:10px"></div>',
        // Un conteneur transparent : gardé par l'élagage, tu par le rendu, comme en 0.5.0.
        '<div style="opacity:0"><p>Note</p><p>Brouillon</p></div>',
        '<p>Total 129</p>',
      ].join(''),
    );
    try {
      const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    capture:
      note: la note
  - id: s2
    expect: le total est affiché
`);
      const KEY = 'le total est affiché';
      const named = { name: { contains: 'Total' } };
      const provider = new ScriptedProvider([
        { captures: { note: { from: { name: { contains: 'Note' } }, extract: 'text' } } },
        { captures: { note: { from: { role: 'text', name: { contains: 'Note' } }, extract: 'text' } } },
        { assertions: { [KEY]: { check: 'textEquals', target: named, value: 'Total 129' } } },
        { assertions: { [KEY]: { check: 'numberEquals', target: named, value: '129' } } },
        { assertions: { [KEY]: { check: 'textContains', target: { ...named, nth: 0 }, value: '129' } } },
        { assertions: { [KEY]: { check: 'textEquals', target: { role: 'text', ...named }, value: 'Total 129' } } },
      ]);

      const full = (await driver.observe()).root;
      const result = await generateResolution({ scenario, driver, provider, baseUrl: url });

      assert.equal(result.status, 'complete');
      assert.deepEqual(
        result.steps.map((step) => step.rejections),
        [['capture "note": found on your tree, but ' + READS_ANOTHER], [1, 2, 3].map(() => assertionElsewhere(KEY))],
      );
      const sent = JSON.stringify(provider.requests);
      const shownIds = new Set(matchNodes(pruneInteractive(full), {}).map((each) => each.id));
      const fullOnly = matchNodes(full, {}).filter((each) => !shownIds.has(each.id) && each.name !== '');
      assert.deepEqual(fullOnly.map((each) => each.name).sort(), ['Note de service CACHEE', 'Total rembourse CACHE']);
      for (const { name } of fullOnly) assert.equal(sent.includes(name), false, name);
      assert.equal(sent.includes('CACHE'), false);
    } finally {
      await driver.dispose();
    }
  });
});

/**
 * Ce qui est accepté avec un pilote intégré l'est sur l'arbre montré seul : rien
 * n'est plus permissif qu'en 0.5.0, qui ne jugeait que lui. Un pilote tiers est
 * jugé exactement comme 0.5.0 : accepté si et seulement si l'arbre montré seul
 * l'accepte.
 */
describe('propriété : une acceptation implique l\'acceptation sur l\'arbre montré seul', () => {
  /** Des cibles tirées de l'écran : rôles, noms, fragments, positions, conteneurs. */
  function targets(root: UINode): Record<string, unknown>[] {
    const out = new Map<string, Record<string, unknown>>();
    const add = (target: Record<string, unknown>): void => {
      out.set(JSON.stringify(target), target);
    };
    const walk = (current: UINode, named: UINode | undefined, parent: UINode | undefined): void => {
      for (const child of current.children) {
        const { role, name } = child;
        add({ role });
        for (const nth of [0, 1, 2]) add({ role, nth });
        if (name !== '') {
          add({ role, name });
          const word = name.split(/\s+/)[0] ?? '';
          if (word !== '') {
            add({ name: { contains: word } });
            add({ role, name: { contains: word } });
          }
        }
        if (named !== undefined) {
          const within = { role: named.role, name: named.name };
          add({ role, within });
          for (const nth of [0, 1]) add({ role, nth, within });
        }
        if (parent !== undefined) {
          const index = matchNodes(root, { role: parent.role }).indexOf(parent);
          if (index >= 0) add({ role, within: { role: parent.role, nth: index } });
        }
        walk(child, current.name !== '' ? current : named, current);
      }
    };
    walk(root, undefined, undefined);
    return [...out.values()];
  }

  function proposals(root: UINode): { checks: Check[]; captures: CaptureSpec[] } {
    const checks: Check[] = [];
    const captures: CaptureSpec[] = [];
    for (const target of targets(root)) {
      const locator = target as unknown as Extract<Check, { check: 'visible' }>['target'];
      const sample = matchNodes(root, locator)[0];
      checks.push({ check: 'visible', target: locator }, { check: 'absent', target: locator });
      for (const value of [1, 2, 3]) checks.push({ check: 'countAtLeast', target: locator, value });
      if (sample !== undefined) {
        const text = textOf(sample);
        if (text !== '') {
          checks.push({ check: 'textEquals', target: locator, value: text });
          checks.push({ check: 'textContains', target: locator, value: text.split(/\s+/)[0] as string });
        }
        if (toNumber(text) !== null) checks.push({ check: 'numberEquals', target: locator, value: text });
        for (const state of ['checked', 'disabled', 'selected'] as const) {
          if (sample.state[state] === true) checks.push({ check: 'stateIs', target: locator, value: state });
        }
      }
      captures.push({ from: locator, extract: 'text' }, { from: locator, extract: 'number' });
    }
    return { checks, captures };
  }

  /** Un tirage régulier, pour borner la durée sans choisir les cas. */
  function every<T>(items: readonly T[], limit: number): T[] {
    if (items.length <= limit) return [...items];
    const step = items.length / limit;
    return Array.from({ length: limit }, (_, index) => items[Math.floor(index * step)] as T);
  }

  const KEY = 'k';
  const checking = expecting(KEY);
  const reads = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n      c: une valeur\n');

  interface Tally {
    accepted: number;
    refusedByReplay: number;
  }

  /**
   * Une proposition jugée sur l'écran par chaque pilote : un pilote tiers comme
   * l'arbre montré seul, un pilote intégré jamais plus largement.
   */
  async function judge(name: string, screen: UINode, tally: Tally): Promise<void> {
    const shown = pruneInteractive(screen);
    const judged = async (label: string, alone: boolean, accepts: (driver: Driver) => Promise<boolean>): Promise<boolean> => {
      assert.equal(await accepts(new ThirdParty(screen)), alone, `${name} (third-party): ${label}`);
      if (await accepts(new BuiltIn(screen))) {
        tally.accepted += 1;
        assert.ok(alone, `${name} (built-in): accepted, but refused on the shown tree: ${label}`);
        return true;
      }
      if (alone) tally.refusedByReplay += 1;
      return false;
    };
    const { checks, captures } = proposals(screen);
    for (const check of every(checks, 500)) {
      const accepted = await judged(JSON.stringify(check), evaluateCheck(check, { root: shown, location: 'http://app.test/', bag: {} }).ok, async (driver) => {
        const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);
        return (await generateUnchecked({ scenario: checking, driver, provider, attemptsPerStep: 1 })).status === 'complete';
      });
      // Acceptée, une vérification lit sur l'arbre complet au moins ce qu'elle lit
      // sur l'arbre montré : le signalement de valeur figée de l'arbre complet est
      // déjà celui de l'arbre montré, qui seul est calculé.
      if (accepted && 'value' in check && 'target' in check) {
        const tautological = (root: UINode) => tautologicalCheck(check.check, check.target, String(check.value), matchNodes(root, check.target));
        assert.ok(!tautological(screen) || tautological(shown), `${name}: value-located on the full tree only: ${JSON.stringify(check)}`);
      }
    }
    for (const spec of every(captures, 250)) {
      const seen = matchOne(shown, spec.from);
      await judged(JSON.stringify(spec), seen !== null && readCapture(seen, spec) !== null, async (driver) => {
        const provider = new ScriptedProvider([{ captures: { c: spec } }]);
        return (await generateUnchecked({ scenario: reads, driver, provider, attemptsPerStep: 1 })).status === 'complete';
      });
    }
  }

  const EDGES = `<!doctype html><html lang="en"><body>
    <h2>Account</h2>
    <div style="display:contents"><h1>Welcome back</h1><p>Your orders</p></div>
    <div style="opacity:0"><p>42</p><p>Transparent B</p></div>
    <span style="display:inline-block;width:8px;height:8px"></span><p>42</p>
    <div aria-label="Named leaf" style="width:10px;height:10px"></div>
    <ul aria-label="Products"><li>Chair</li><li>Table</li><li style="height:20px;border:1px solid #ccc"></li></ul>
    <table><tr><td></td><td>CMD-1</td><td>Paid</td></tr><tr><td></td><td>CMD-2</td><td>Pending</td></tr></table>
    <ul><li><span style="display:inline-block;width:8px;height:8px"></span><span>Keyboard</span><span>49,99 €</span></li></ul>
    <label>Email <input value="a@b.c"></label>
    <input type="checkbox" aria-label="Agree" checked>
    <button disabled>Disabled</button>
  </body></html>`;

  it('sur les pages de démonstration et un écran de cas limites, dans un vrai navigateur', { timeout: 300_000 }, async () => {
    const pages: Record<string, string> = {
      shop: await readFile('fixtures/shop/index.html', 'utf8'),
      library: await readFile('fixtures/library/index.html', 'utf8'),
      edges: EDGES,
    };
    const tally: Tally = { accepted: 0, refusedByReplay: 0 };
    for (const [name, html] of Object.entries(pages)) {
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const driver = new PlaywrightWebDriver(() => chromium.launch());
      try {
        await driver.launch({ entry: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
        await driver.settle();
        await judge(name, (await driver.observe()).root, tally);
      } finally {
        await driver.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    // Ni vide, ni sans effet : la règle refuse ce que l'arbre montré seul acceptait.
    assert.ok(tally.accepted > 100, JSON.stringify(tally));
    assert.ok(tally.refusedByReplay > 10, JSON.stringify(tally));
  });

  it('sur les sources iOS d\'exemple', { timeout: 120_000 }, async () => {
    const tally: Tally = { accepted: 0, refusedByReplay: 0 };
    for (const file of (await readdir(FIXTURES)).filter((name) => name.endsWith('.xml')).sort()) {
      await judge(file, readScreen(fixture(file), { mode: 'observe' }).root, tally);
    }
    assert.ok(tally.accepted > 100, JSON.stringify(tally));
    assert.ok(tally.refusedByReplay > 0, JSON.stringify(tally));
  });
});
