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
import { printedIds, renderTree } from './render.ts';

/**
 * Un pilote tiers : `interactiveOnly` élague par les règles des intégrés, mais
 * rien ne le déclare. Deux lectures par regard, reliées par la valeur lue.
 */
class TwoReads implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities: Capabilities = { hover: true, swipe: false, navigateByUrl: true, deepLink: true };
  readonly acted: Action[] = [];
  observations = 0;
  readonly #screen: (acted: readonly Action[]) => UINode;

  constructor(screen: UINode | ((acted: readonly Action[]) => UINode)) {
    this.#screen = typeof screen === 'function' ? screen : () => screen;
  }

  protected tree(options: ObserveOptions | undefined): UINode {
    const root = this.#screen(this.acted);
    return options?.interactiveOnly === true ? pruneInteractive(root) : root;
  }

  async observe(options?: ObserveOptions): Promise<UISnapshot> {
    this.observations += 1;
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

/** Élague comme les intégrés, et le déclare : une lecture, l'arbre montré en est tiré. */
class Aligned extends TwoReads {
  override async observe(options?: ObserveOptions): Promise<UISnapshot> {
    return super.observe(options);
  }
}
prunesLikeBuiltIns(Aligned.prototype.observe);

/** Un pilote tiers qui n'élague pas : l'arbre complet, quelles que soient les options. */
class NoPruning extends TwoReads {
  protected override tree(): UINode {
    return super.tree(undefined);
  }
}

/** Un pilote tiers dont les deux lectures diffèrent : l'écran a bougé, ou il élague à sa façon. */
class Drifting extends TwoReads {
  readonly #pruned: UINode;
  readonly #full: UINode;

  constructor(pruned: UINode, full: UINode) {
    super(full);
    this.#pruned = pruned;
    this.#full = full;
  }

  protected override tree(options: ObserveOptions | undefined): UINode {
    return options?.interactiveOnly === true ? this.#pruned : this.#full;
  }
}

/** Un pilote tiers qui ne fait que déléguer au pilote web : deux lectures par regard. */
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

const page = (...children: UINode[]): UINode => node('group', 'page', children);
const unnamed = (): UINode => node('text', '');
/** Un conteneur qui a une boîte mais n'est pas visible : transparent, replié. */
const drawer = (...children: UINode[]): UINode => node('group', '', children, { state: { visible: false } });

const LEFT_OUT = 'it also counts the unnamed and hidden elements your tree leaves out';

describe('deux arbres : ce que le modèle voit, ce que le rejeu relit', () => {
  describe('cible unique sur l\'arbre montré, ambiguë au rejeu (#48)', () => {
    for (const Driver of [Aligned, TwoReads]) {
      it(`refuse avec les comptes, sans position que l'arbre du modèle lirait autrement (${Driver.name})`, async () => {
        const driver = new Driver(page(unnamed(), node('text', 'Solde : 42')));
        const provider = new ScriptedProvider([
          reading({ role: 'text' }),
          // La position du rejeu : 0.5.0 la refusait, elle reste refusée.
          reading({ role: 'text', nth: 1 }),
          reading({ role: 'text', name: { contains: 'Solde' } }),
        ]);

        const result = await generateResolution({ scenario: capturing, driver, provider });

        assert.equal(result.status, 'complete');
        assert.deepEqual(result.steps[0]?.rejections, [
          `capture "reference": found on your tree, but replay reads 2 element(s) matching this target where your tree shows 1: ${LEFT_OUT}. Use { "contains": "..." } on a stable part of the name, or "within" a named container, not "nth", which counts them too. Never put the value itself in "name"`,
          'capture "reference": target not found or ambiguous on this screen',
        ]);
        assert.deepEqual(capturedFrom(result), { role: 'text', name: { contains: 'Solde' } });
        // Le refus atteint le modèle.
        const sent = JSON.stringify(provider.requests[1]?.messages);
        assert.ok(sent.includes('your tree shows 1'));
      });
    }

    it('donne la position réelle quand elle lit le même élément sur les deux arbres, et l\'accepte', async () => {
      const value = node('text', '42');
      const driver = new Aligned(page(value, unnamed()));
      const provider = new ScriptedProvider([reading({ role: 'text' }), reading({ role: 'text', nth: 0 })]);

      const result = await generateResolution({ scenario: capturing, driver, provider });

      assert.equal(result.status, 'complete');
      assert.match(result.steps[0]?.rejections[0] ?? '', /keep this target and add "nth": 0 to it, where replay finds the element you see/);
      assert.deepEqual(capturedFrom(result), { role: 'text', nth: 0 });
      assert.equal(matchOne(page(value, unnamed()), { role: 'text', nth: 0 }), value);
    });

    it('accepte ce que les deux arbres lisent pareil, comme 0.5.0', async () => {
      const driver = new Aligned(page(unnamed(), node('group', 'Solde', [node('text', '42')])));
      const provider = new ScriptedProvider([reading({ role: 'text', within: { role: 'group', name: 'Solde' } })]);

      const result = await generateResolution({ scenario: capturing, driver, provider });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.steps[0]?.rejections, []);
    });
  });

  describe('nth qui lit un autre élément au rejeu (#48)', () => {
    for (const Driver of [Aligned, TwoReads]) {
      it(`refuse le second vu qui est le second réel d'un autre (${Driver.name})`, async () => {
        const a = node('text', 'Order A is confirmed');
        const b = node('text', 'Order B is confirmed');
        const driver = new Driver(page(a, unnamed(), b));
        const provider = new ScriptedProvider([
          reading({ role: 'text', nth: 1 }),
          reading({ role: 'text', name: { contains: 'Order B' } }),
        ]);

        const result = await generateResolution({ scenario: capturing, driver, provider });

        assert.equal(result.status, 'complete');
        const refusal = result.steps[0]?.rejections[0] ?? '';
        assert.match(refusal, /replay reads 3 element\(s\) matching this target where your tree shows 2/);
        assert.match(refusal, /not "nth", which counts them too/);
      });
    }

    it('dans un conteneur, refuse sans donner une position que l\'arbre du modèle refuserait', async () => {
      const within = { role: 'listitem', name: 'Printer offline' };
      const driver = new Aligned(page(node('listitem', 'Printer offline', [unnamed(), node('text', 'Priority: high')])));
      const provider = new ScriptedProvider([
        reading({ role: 'text', nth: 0, within }),
        reading({ role: 'text', nth: 1, within }),
        reading({ role: 'text', name: { contains: 'Priority' }, within }),
      ]);

      const result = await generateResolution({ scenario: capturing, driver, provider });

      assert.equal(result.status, 'complete');
      const [first, second] = result.steps[0]?.rejections ?? [];
      assert.match(first ?? '', /replay reads 2 element\(s\) matching this target where your tree shows 1/);
      assert.doesNotMatch(first ?? '', /add "nth"/);
      assert.equal(second, 'capture "reference": target not found or ambiguous on this screen');
    });

    it('refuse une assertion qui lit un autre élément au rejeu, même vraie sur les deux', async () => {
      const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: le solde est 42\n');
      // Une feuille nommée que l'élagage retire, lue en premier au rejeu.
      const driver = new Aligned(page(node('group', '42'), node('text', '42')));
      const check: Check = { check: 'textEquals', target: { name: '42' }, value: '42' };
      const provider = new ScriptedProvider([
        { assertions: { 'le solde est 42': check } },
        { assertions: { 'le solde est 42': { ...check, target: { role: 'text', name: '42' } } } },
      ]);

      const result = await generateResolution({ scenario, driver, provider });

      assert.equal(result.status, 'complete');
      assert.match(
        result.steps[0]?.rejections[0] ?? '',
        /^assertion "le solde est 42": true on your tree, but replay reads 2 element\(s\) matching this target where your tree shows 1/,
      );
    });
  });

  it('ne conseille ni ne lit la copie cachée avant l\'élément montré (C3)', async () => {
    const hidden = node('text', '42');
    const shown = node('text', '42');
    const driver = new Aligned(page(drawer(hidden, node('text', 'Ancien')), unnamed(), shown));
    const provider = new ScriptedProvider([
      reading({ role: 'text' }),
      reading({ role: 'text', name: '42' }),
      // Le troisième de l'arbre montré, l'élément visible : au rejeu, le texte sans nom.
      reading({ role: 'text', nth: 2 }),
      reading({ role: 'text', nth: 3 }),
    ]);

    const result = await generateResolution({ scenario: capturing, driver, provider, attemptsPerStep: 4 });

    assert.equal(result.status, 'incomplete');
    const rejections = result.steps[0]?.rejections ?? [];
    assert.equal(rejections.length, 4);
    assert.ok(rejections.every((rejection) => !/add "nth"/.test(rejection)), JSON.stringify(rejections));
    // Le modèle lit une seule ligne « text "42" » : le tiroir invisible est tu par le rendu.
    const rendered = renderTree(pruneInteractive(page(drawer(hidden, node('text', 'Ancien')), unnamed(), shown)));
    assert.equal(rendered.split('\n').filter((line) => line.trim().startsWith('text ')).length, 1, rendered);
    assert.match(rejections[2] ?? '', /replay reads 4 element\(s\) matching this target where your tree shows 1: /);
  });

  it('refuse une position que le rejeu lit sur un autre élément, même visible sur les deux', async () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: le solde est affiché\n');
    const driver = new Aligned(page(drawer(node('text', '42'), node('text', 'Ancien')), unnamed(), node('text', '42')));
    const provider = new ScriptedProvider([
      { assertions: { 'le solde est affiché': { check: 'visible', target: { role: 'text', nth: 2 } } } },
    ]);

    const result = await generateResolution({ scenario, driver, provider, attemptsPerStep: 1 });

    assert.equal(result.status, 'incomplete');
    assert.match(result.steps[0]?.rejections[0] ?? '', /true on your tree, but replay reads 4 element\(s\)/);
  });

  it('lit le même nœud sur un pilote intégré, la même valeur sur un pilote tiers', async () => {
    // Une feuille nommée que l'élagage retire, lue la première au rejeu, qui lit pareil.
    const tree = () => page(node('group', '42'), node('text', '42'));
    const from = { name: '42', nth: 0 };

    const aligned = await generateResolution({ scenario: capturing, driver: new Aligned(tree()), provider: new ScriptedProvider([reading(from)]), attemptsPerStep: 1 });
    const third = await generateResolution({ scenario: capturing, driver: new TwoReads(tree()), provider: new ScriptedProvider([reading(from)]), attemptsPerStep: 1 });

    assert.equal(aligned.status, 'incomplete');
    assert.match(aligned.steps[0]?.rejections[0] ?? '', /found on your tree, but replay reads 2 element\(s\)/);
    assert.equal(third.status, 'complete');
  });

  it('refuse un absent que le rejeu dément, en nombres et sans conseil de resserrer la cible', async () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: aucune erreur n\'est affichée\n');
    // Une alerte visible sans nom ni enfant : l'élagage la retire.
    const driver = new Aligned(page(node('alert', ''), node('text', 'Paiement')));
    const provider = new ScriptedProvider([
      { assertions: { "aucune erreur n'est affichée": { check: 'absent', target: { role: 'alert' } } } },
    ]);

    const result = await generateResolution({ scenario, driver, provider, attemptsPerStep: 1 });

    assert.equal(result.status, 'incomplete');
    assert.equal(
      result.steps[0]?.rejections[0],
      `assertion "aucune erreur n'est affichée": true on your tree, but replay reads 1 visible element(s) matching this target where your tree shows 0: ${LEFT_OUT}`,
    );
  });

  it('refuse un countAtLeast que la seconde lecture dément, sans dire que le rejeu compte plus', async () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: trois produits\n');
    const items = (count: number) => page(node('list', 'Produits', ['A', 'B', 'C'].slice(0, count).map((name) => node('listitem', name))));
    const driver = new Drifting(items(3), items(2));
    const provider = new ScriptedProvider([{ assertions: { 'trois produits': { check: 'countAtLeast', target: { role: 'listitem' }, value: 3 } } }]);

    const result = await generateResolution({ scenario, driver, provider, attemptsPerStep: 1 });

    assert.equal(
      result.steps[0]?.rejections[0],
      `assertion "trois produits": true on your tree, but replay reads 2 element(s) matching this target where your tree shows 3: the screen changed between two reads of it`,
    );
  });

  it('garde un signalement de valeur figée que seul l\'arbre montré donne, assertion comme capture', async () => {
    const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: le stock est 40\n');
    // Au rejeu, une correspondance de plus porte une valeur : seul l'arbre montré signale.
    const driver = new Aligned(page(node('group', 'Stock 40', [], { value: '40' }), node('text', 'Stock 40')));
    const provider = new ScriptedProvider([
      { assertions: { 'le stock est 40': { check: 'textContains', target: { name: { contains: '40' } }, value: '40' } } },
    ]);

    const asserted = await generateResolution({ scenario, driver, provider });

    assert.equal(asserted.status, 'complete');
    assert.ok(asserted.steps[0]?.warnings.some((warning) => warning.includes('is located by the very value it asserts')));

    // Les deux lectures d'un pilote tiers lisent 129, mais seule la première du nom.
    const drifting = new Drifting(page(node('text', 'Total 129')), page(node('text', 'Total 129', [], { value: '129' })));
    const captured = await generateResolution({
      scenario: capturing,
      driver: drifting,
      provider: new ScriptedProvider([{ captures: { reference: { from: { role: 'text', name: 'Total 129' }, extract: 'number' } } }]),
    });

    assert.equal(captured.status, 'complete');
    assert.ok(captured.steps[0]?.warnings.some((warning) => warning.includes('is located by the very value it reads')));
  });

  it('apprend un secret dérivé de l\'élément montré, même si l\'autre lecture ne le porte pas', async () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    capture:
      code: le code
  - id: s2
    expect: le code est affiché
`);
    const driver = new Drifting(page(node('text', 'Code jdoe_admin 4242')), page(node('text', 'Code 4242')));
    const provider = new ScriptedProvider([
      { captures: { code: { from: { role: 'text', name: { contains: 'Code' } }, extract: 'number' } } },
      { assertions: { 'le code est affiché': { check: 'visible', target: { role: 'text' } } } },
    ]);

    const result = await generateResolution({ scenario, driver, provider, knownSecrets: new Set(['jdoe_admin']) });

    assert.equal(result.status, 'complete');
    assert.equal(JSON.stringify(provider.requests[1]).includes('4242'), false);
  });

  it('garde l\'avertissement de comparaison avec soi-même que seul l\'arbre montré donne (C4)', async () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    expect: "la commande {{reference}} est affichée"
    capture:
      reference: la référence de commande
`);
    const driver = new Aligned(page(node('text', 'Order CMD-1'), unnamed()));
    const provider = new ScriptedProvider([
      {
        captures: { reference: { from: { role: 'text', name: { contains: 'Order' } }, extract: 'text', after: 'Order ' } },
        assertions: {
          'la commande {{reference}} est affichée': { check: 'textContains', target: { role: 'text' }, value: '{{reference}}' },
        },
      },
    ]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    assert.ok(
      result.steps[0]?.warnings.includes(
        'assertion "la commande {{reference}} est affichée" compares {{reference}} with the element it was just read from: it cannot fail',
      ),
      JSON.stringify(result.steps[0]?.warnings),
    );
  });

  it('interroge une assertion déjà vraie avant le geste sur l\'arbre du rejeu seulement', async () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter la lampe
    expect: la liste montre au moins 3 produits
`);
    const KEY = 'la liste montre au moins 3 produits';
    // Un emplacement vide, que l'élagage retire : 2 produits montrés, 3 au rejeu.
    const placeholder = node('listitem', '');
    const driver = new Aligned((acted) =>
      page(
        node('list', 'Produits', [
          node('listitem', 'Chaise'),
          node('listitem', 'Table'),
          ...(acted.length > 0 ? [node('listitem', 'Lampe')] : []),
          placeholder,
        ]),
        node('button', 'Ajouter'),
      ),
    );
    const check: Check = { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', name: 'Produits' } }, value: 3 };
    const proposal = { actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Ajouter' } } }], assertions: { [KEY]: check } };
    const provider = new ScriptedProvider([proposal, proposal]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    assert.match(result.steps[0]?.rejections[0] ?? '', /is already true on the current screen, before any gesture/);
    assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('was already true before the gesture')));
  });

  it('interroge toujours, comme 0.5.0, une assertion déjà vraie avant sur l\'arbre montré seul', async () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: fermer le message
    expect: aucune erreur n'est affichée
`);
    const KEY = "aucune erreur n'est affichée";
    // Avant le geste, une alerte sans nom que l'élagage retire : absente de l'arbre montré seulement.
    const driver = new Aligned((acted) =>
      page(...(acted.length === 0 ? [node('alert', '')] : []), node('button', 'Fermer')),
    );
    const proposal = {
      actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Fermer' } } }],
      assertions: { [KEY]: { check: 'absent', target: { role: 'alert' } } },
    };
    const provider = new ScriptedProvider([proposal, proposal]);

    const result = await generateResolution({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    assert.match(result.steps[0]?.rejections[0] ?? '', /is already true on the current screen, before any gesture/);
  });

  describe('lectures', () => {
    const verifying = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: le total est affiché\n');
    const KEY = 'le total est affiché';
    const total = (value: string) => ({ assertions: { [KEY]: { check: 'textEquals', target: { role: 'text', within: { role: 'group', name: 'Total' } }, value } } });
    const screen = () => page(node('group', 'Total', [node('text', '129')]), node('group', 'Interne, jamais montré'));

    it('ne lit pas l\'écran d\'avant d\'une étape qui ne fait que vérifier, et une fois par regard', async () => {
      const driver = new Aligned(screen());
      const provider = new ScriptedProvider([total('130'), total('129')]);

      const result = await generateResolution({ scenario: verifying, driver, provider });

      assert.equal(result.status, 'complete');
      // Le regard d'où part la phase B, puis un par réponse ; aucun sur l'écran
      // d'avant, que 0.5.0 lisait sans s'en servir.
      assert.equal(driver.observations, 3);
      // L'arbre n'est pas renvoyé au second tour.
      assert.equal(JSON.stringify(provider.requests[1]?.messages.at(-1)).includes('Total'), false);
    });

    it('lit deux fois un pilote tiers, élagué puis complet', async () => {
      const driver = new TwoReads(screen());
      const provider = new ScriptedProvider([total('129')]);

      await generateResolution({ scenario: verifying, driver, provider });

      assert.equal(driver.observations, 4);
    });

    it('envoie au modèle l\'arbre élagué, en phase A comme en phase B', async () => {
      const scenario = parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    do: valider\n    expect: ${JSON.stringify(KEY)}\n`);
      const tree = page(node('group', 'Total', [node('text', '129')]), node('group', 'Interne, jamais montré'), node('button', 'Valider'));
      const driver = new Aligned((acted) => (acted.length > 0 ? tree : page(node('button', 'Valider'), node('group', 'Interne, jamais montré'))));
      const click = { kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } };
      const provider = new ScriptedProvider([{ actions: [click], ...total('130') }, total('129')]);

      const result = await generateResolution({ scenario, driver, provider });

      assert.equal(result.status, 'complete');
      const sent = JSON.stringify(provider.requests);
      assert.equal(sent.includes('Interne'), false);
      assert.ok(sent.includes(JSON.stringify(renderTree(pruneInteractive(tree))).slice(1, -1)));
    });
  });

  it('fonctionne avec un pilote tiers qui n\'élague pas', async () => {
    const driver = new NoPruning(page(node('group', 'Solde', [unnamed(), node('text', '42')]), node('group', 'Note')));
    const within = { role: 'group', name: 'Solde' };
    const provider = new ScriptedProvider([reading({ role: 'text', within }), reading({ role: 'text', nth: 1, within })]);

    const result = await generateResolution({ scenario: capturing, driver, provider });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.steps[0]?.rejections, ['capture "reference": target not found or ambiguous on this screen']);
    assert.deepEqual(capturedFrom(result), { role: 'text', nth: 1, within });
  });

  describe('une valeur vivante, lue deux fois par un pilote tiers', () => {
    /** Un écran dont un texte avance à chaque lecture, comme un minuteur. */
    const ticking = (screen: (tick: number) => UINode): TwoReads => {
      let tick = 0;
      return new TwoReads(() => screen((tick += 1)));
    };
    const timer = (tick: number): UINode =>
      page(node('listitem', 'Timer', [node('text', `Updated ${tick} s ago`)]), node('button', 'Refresh'));
    const LIVE = 'capture "elapsed" changed between the two reads of this screen: the value is live, and replay reads it at its own time';
    const twoSteps = parseScenario(`
id: t
title: t
steps:
  - id: s1
    capture:
      elapsed: the elapsed seconds
  - id: s2
    expect: the refresh button is shown
`);

    for (const from of [
      { role: 'text', name: { contains: 's ago' } },
      { role: 'text', within: { role: 'listitem', name: 'Timer' } },
      { role: 'text', nth: 0, within: { role: 'listitem', name: 'Timer' } },
    ]) {
      it(`accepte ${JSON.stringify(from)}, comme 0.5.0, et garde la valeur que le modèle a vue`, async () => {
        const provider = new ScriptedProvider([
          { captures: { elapsed: { from, extract: 'number' } } },
          { assertions: { 'the refresh button is shown': { check: 'visible', target: { role: 'button', name: 'Refresh' } } } },
        ]);

        const result = await generateResolution({ scenario: twoSteps, driver: ticking(timer), provider, attemptsPerStep: 1 });

        assert.equal(result.status, 'complete', JSON.stringify(result.steps));
        assert.deepEqual(result.steps[0]?.rejections, []);
        assert.deepEqual(result.steps[0]?.warnings, [LIVE]);
        // Chaque regard lit l'élagué (impair) puis le complet (pair) : la valeur
        // gardée est une lecture élaguée, et aucune lecture complète ne part.
        const sent = JSON.stringify(provider.requests);
        const kept = Number(/\{\{elapsed\}\} = (\d+)/.exec(sent)?.[1]);
        assert.equal(kept % 2, 1, sent);
        assert.deepEqual(result.resolution.steps['s1']?.captures?.['elapsed']?.from, from);
        for (const full of [2, 4, 6, 8]) {
          assert.equal(sent.includes(`Updated ${full} s ago`), false, String(full));
          assert.equal(sent.includes(`{{elapsed}} = ${full}`), false, String(full));
        }
      });
    }

    it('refuse une position que le rejeu compte parmi plus de candidats, même vivante', async () => {
      const within = { role: 'listitem', name: 'Timer' };
      const driver = ticking((tick) => page(node('listitem', 'Timer', [unnamed(), node('text', `Updated ${tick} s ago`)])));
      const provider = new ScriptedProvider([
        { captures: { reference: { from: { role: 'text', nth: 0, within }, extract: 'text' } } },
        { captures: { reference: { from: { role: 'text', name: { contains: 's ago' }, within }, extract: 'number' } } },
      ]);

      const result = await generateResolution({ scenario: capturing, driver, provider });

      assert.equal(result.status, 'complete');
      assert.equal(
        result.steps[0]?.rejections[0],
        `capture "reference": found on your tree, but replay reads 2 element(s) matching this target where your tree shows 1: ${LEFT_OUT}. Use { "contains": "..." } on a stable part of the name, or "within" a named container, not "nth", which counts them too. Never put the value itself in "name"`,
      );
    });

    it('ne dit pas que le rejeu compte plus quand il ne compte pas plus', async () => {
      const refusal = async (pruned: UINode, full: UINode): Promise<string | undefined> => {
        const provider = new ScriptedProvider([
          { captures: { reference: { from: { role: 'text', name: { contains: 'Total' } }, extract: 'number' } } },
        ]);
        const result = await generateResolution({ scenario: capturing, driver: new Drifting(pruned, full), provider, attemptsPerStep: 1 });
        return result.steps[0]?.rejections[0];
      };

      assert.equal(
        await refusal(page(node('text', 'Total 129')), page(node('text', 'Total'))),
        'capture "reference": found on your tree, but replay reads 1 element(s) matching this target where your tree shows 1: the screen changed between two reads of it',
      );
      assert.equal(
        await refusal(page(node('text', 'Total 129')), page()),
        'capture "reference": found on your tree, but replay reads 0 element(s) matching this target where your tree shows 1: the screen changed between two reads of it',
      );
    });

    /** Un minuteur dans un groupe nommé, suivi d'une icône sans nom que l'élagage retire. */
    const clock = (tick: number, ...around: UINode[]): UINode =>
      page(node('group', 'Timer', [node('text', 'Elapsed'), node('text', String(700 + tick)), unnamed()]), ...around);
    const reads = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n      elapsed: the elapsed seconds\n');

    for (const from of [{ role: 'text', nth: 1, within: { role: 'group', name: 'Timer' } }, { role: 'text', nth: 1 }]) {
      it(`accepte ${JSON.stringify(from)} quand l'élément de plus au rejeu vient après la valeur, comme 0.5.0`, async () => {
        const driver = ticking((tick) => clock(tick));
        const provider = new ScriptedProvider([{ captures: { elapsed: { from, extract: 'number' } } }]);

        const result = await generateResolution({ scenario: reads, driver, provider, attemptsPerStep: 1 });

        assert.equal(result.status, 'complete', JSON.stringify(result.steps));
        assert.deepEqual(result.steps[0]?.rejections, []);
        assert.deepEqual(result.steps[0]?.warnings, [LIVE]);
        // Le regard d'où part la phase B, celui de la réponse, et un de plus : la
        // valeur a bougé sur les deux lectures, elle est vivante.
        assert.equal(driver.observations, 6);
        const sent = JSON.stringify(provider.requests);
        for (const full of [702, 704, 706]) assert.equal(sent.includes(String(full)), false, String(full));
        const report = await runScenario({ scenario: reads, resolution: result.resolution, driver: ticking((tick) => clock(tick)), assertTimeoutMs: 0 });
        assert.equal(report.status, 'passed');
      });
    }

    it('refuse encore, après un regard de plus, un autre élément que rien ne fait bouger', async () => {
      // Une valeur que l'élagage retire, avant celle que le modèle voit : rien ne bouge.
      const timer = (...values: string[]) => page(node('group', 'Timer', [node('text', 'Elapsed'), ...values.map((value) => node('text', value))]));
      const driver = new Drifting(timer('42'), timer('40', '42'));
      const provider = new ScriptedProvider([
        { captures: { elapsed: { from: { role: 'text', nth: 1, within: { role: 'group', name: 'Timer' } }, extract: 'number' } } },
      ]);

      const result = await generateResolution({ scenario: reads, driver, provider, attemptsPerStep: 1 });

      assert.equal(result.status, 'incomplete');
      assert.equal(
        result.steps[0]?.rejections[0],
        `capture "elapsed": found on your tree, but replay reads 3 element(s) matching this target where your tree shows 2: ${LEFT_OUT}. Use { "contains": "..." } on a stable part of the name, or "within" a named container, not "nth", which counts them too. Never put the value itself in "name"`,
      );
      assert.equal(driver.observations, 6);
    });

    it('refuse une copie cachée et figée avant la valeur vivante, que le rejeu lirait (C3)', async () => {
      const stale = node('text', '640', [], { state: { visible: false } });
      const driver = ticking((tick) => page(node('group', 'Timer', [node('text', 'Elapsed'), stale, node('text', String(700 + tick))])));
      const provider = new ScriptedProvider([
        { captures: { elapsed: { from: { role: 'text', nth: 1, within: { role: 'group', name: 'Timer' } }, extract: 'number' } } },
      ]);

      const result = await generateResolution({ scenario: reads, driver, provider, attemptsPerStep: 1 });

      // Seule la valeur montrée a bougé : celle que le rejeu lit est un autre élément.
      assert.equal(result.status, 'incomplete');
      assert.match(result.steps[0]?.rejections[0] ?? '', /replay reads 3 element\(s\) matching this target where your tree shows 2/);
    });

    it('signale la comparaison avec soi-même que seule la lecture complète donne, avec sa propre valeur', async () => {
      const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    expect: "the order {{reference}} is shown"
    capture:
      reference: the order number
`);
      // Ambiguë sur la lecture élaguée, la cible n'y désigne rien ; sur la complète,
      // elle désigne l'élément lu, par la valeur de cette lecture-là.
      let tick = 0;
      const driver = new (class extends TwoReads {
        protected override tree(options: ObserveOptions | undefined): UINode {
          tick += 1;
          const value = String(700 + tick);
          return options?.interactiveOnly === true
            ? page(node('text', `Order ${value}`), node('text', `Ref ${value}`))
            : page(node('text', `Order ${value}`));
        }
      })(page());
      const provider = new ScriptedProvider([
        {
          captures: { reference: { from: { role: 'text', name: { contains: 'Order' } }, extract: 'number' } },
          assertions: { 'the order {{reference}} is shown': { check: 'visible', target: { role: 'text', name: { contains: '{{reference}}' } } } },
        },
      ]);

      const result = await generateResolution({ scenario, driver, provider, attemptsPerStep: 1 });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.ok(
        result.steps[0]?.warnings.includes(
          'assertion "the order {{reference}} is shown" compares {{reference}} with the element it was just read from: it cannot fail',
        ),
        JSON.stringify(result.steps[0]?.warnings),
      );
    });

    describe('comparée dans la même étape à un second affichage de la même valeur', () => {
      const KEY = 'the status shows the elapsed seconds';
      const comparing = (capture: string) =>
        parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n${capture}    expect: ${JSON.stringify(KEY)}\n`);
      const elapsed = { role: 'text', name: { contains: 's ago' } };
      /** Le même nombre en deux endroits, rendus ensemble à chaque lecture. */
      const status = (tick: number): UINode =>
        page(node('listitem', 'Timer', [node('text', `Updated ${700 + tick} s ago`)]), node('text', `Status: ${700 + tick} s`));
      const mirror = (tick: number): UINode =>
        clock(tick, node('group', 'Summary', [node('text', 'Total time'), node('text', String(700 + tick))]));

      const cases: [string, string, (tick: number) => UINode, Record<string, unknown>, Check][] = [
        [
          'textContains sur un autre texte',
          '      elapsed: the elapsed seconds\n',
          status,
          { elapsed: { from: elapsed, extract: 'number' } },
          { check: 'textContains', target: { role: 'text', name: { contains: 'Status' } }, value: '{{elapsed}}' },
        ],
        [
          'une seconde capture localisée par la première',
          '      elapsed: the elapsed seconds\n      shown: the status seconds\n',
          status,
          {
            elapsed: { from: elapsed, extract: 'number' },
            shown: { from: { role: 'text', name: { contains: 'Status: {{elapsed}}' } }, extract: 'number' },
          },
          { check: 'visible', target: { role: 'text', name: { contains: 'Status: {{shown}}' } } },
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
        it(`accepte ${label}, comme 0.5.0, et le rejeu le passe`, async () => {
          const scenario = comparing(capture);
          const provider = new ScriptedProvider([{ captures, assertions: { [KEY]: check } }]);

          const result = await generateResolution({ scenario, driver: ticking(screen), provider, attemptsPerStep: 1 });

          assert.equal(result.status, 'complete', JSON.stringify(result.steps));
          assert.deepEqual(result.steps[0]?.rejections, []);
          assert.ok(result.steps[0]?.warnings.includes(LIVE), JSON.stringify(result.steps[0]?.warnings));
          // Aucune lecture complète (paire) ne part chez le fournisseur.
          const sent = JSON.stringify(provider.requests);
          for (const full of [702, 704, 706]) assert.equal(sent.includes(String(full)), false, String(full));
          const report = await runScenario({ scenario, resolution: result.resolution, driver: ticking(screen), assertTimeoutMs: 0 });
          assert.equal(report.status, 'passed', JSON.stringify(report.steps));
        });
      }
    });
  });

  describe('la position d\'un conteneur que le rejeu compte parmi plus de candidats', () => {
    // Une ligne vide, que l'élagage retire : la ligne 2 du modèle est la 3 du rejeu.
    const orders = (): UINode =>
      page(
        node('table', '', [
          node('row', '', [node('cell', 'Order'), node('cell', 'Status')]),
          node('row', ''),
          node('row', '', [node('cell', 'CMD-1'), node('cell', 'Paid')]),
          node('row', '', [node('cell', 'CMD-2'), node('cell', 'Pending')]),
        ]),
      );
    const KEY = 'la seconde commande est en attente';
    const scenario = parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: ${KEY}\n`);
    const refusal = async (check: Check): Promise<string | undefined> => {
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);
      const result = await generateResolution({ scenario, driver: new Aligned(orders()), provider, attemptsPerStep: 1 });
      assert.equal(result.status, 'incomplete');
      return result.steps[0]?.rejections[0];
    };
    const ROWS = `replay reads 4 element(s) matching its "within" where your tree shows 3: ${LEFT_OUT}`;

    it('compte les conteneurs, et donne le conseil de 0.5.0 à une comparaison', async () => {
      assert.equal(
        await refusal({ check: 'textEquals', target: { role: 'cell', nth: 1, within: { role: 'row', nth: 2 } }, value: 'Pending' }),
        `assertion "${KEY}": true on your tree, but ${ROWS}. Use { "contains": "..." } on a stable part of the name, or "within" a named container, not "nth", which counts them too. Never put the value itself in "name"`,
      );
    });

    it('à countAtLeast, le seul conseil du conteneur nommé ; à absent, aucun', async () => {
      assert.equal(
        await refusal({ check: 'countAtLeast', target: { role: 'cell', within: { role: 'row', nth: 1 } }, value: 2 }),
        `assertion "${KEY}": true on your tree, but ${ROWS}. Use "within" a named container, not "nth", which counts them too`,
      );
      assert.equal(
        await refusal({ check: 'absent', target: { role: 'cell', name: 'Paid', within: { role: 'row', nth: 2 } } }),
        `assertion "${KEY}": true on your tree, but ${ROWS}`,
      );
    });

    it('ne met pas en cause un conteneur que sa position désigne sur les deux arbres', async () => {
      // Une cellule d'icône en tête de chaque ligne, et une ligne d'espacement à la fin.
      const icons = page(
        node('table', '', [
          node('row', '', [node('cell', ''), node('cell', 'Order'), node('cell', 'Status')]),
          node('row', '', [node('cell', ''), node('cell', 'CMD-1'), node('cell', 'Paid')]),
          node('row', '', [node('cell', ''), node('cell', 'CMD-2'), node('cell', 'Pending')]),
          node('row', ''),
        ]),
      );
      const provider = new ScriptedProvider([
        { assertions: { [KEY]: { check: 'textEquals', target: { role: 'cell', within: { role: 'row', nth: 2 } }, value: 'CMD-2' } } },
      ]);

      const result = await generateResolution({ scenario, driver: new Aligned(icons), provider, attemptsPerStep: 1 });

      assert.equal(
        result.steps[0]?.rejections[0],
        `assertion "${KEY}": true on your tree, but replay reads 3 element(s) matching this target where your tree shows 2: ${LEFT_OUT}. Use { "contains": "..." } on a stable part of the name, or "within" a named container, not "nth", which counts them too. Never put the value itself in "name"`,
      );
    });

    it('donne alors la position de la cible, que la réponse suit', async () => {
      const accounts = (): UINode =>
        page(node('list', 'Accounts', [node('listitem', 'Checking', [node('text', '42'), unnamed()]), node('listitem', '')]));
      const within = { role: 'listitem', nth: 0 };
      const provider = new ScriptedProvider([reading({ role: 'text', within }), reading({ role: 'text', nth: 0, within })]);

      const result = await generateResolution({ scenario: capturing, driver: new Aligned(accounts()), provider });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.steps[0]?.rejections, [
        `capture "reference": found on your tree, but replay reads 2 element(s) matching this target where your tree shows 1: ${LEFT_OUT}. Use { "contains": "..." } on a stable part of the name, or "within" a named container; if its name is only data, keep this target and add "nth": 0 to it, where replay finds the element you see. Never put the value itself in "name"`,
      ]);
      const report = await runScenario({ scenario: capturing, resolution: result.resolution, driver: new Aligned(accounts()), assertTimeoutMs: 0 });
      assert.equal(report.status, 'passed');
    });
  });

  describe('les signalements que seule la lecture du rejeu donne', () => {
    // Avec un pilote intégré, l'arbre montré est une copie du complet : ces cas
    // n'existent que sur les deux lectures d'un pilote tiers.
    it('assertion localisée par sa valeur', async () => {
      const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: le stock est 40\n');
      const driver = new Drifting(page(node('text', 'Stock 40', [], { value: '40' })), page(node('text', 'Stock 40')));
      const provider = new ScriptedProvider([
        { assertions: { 'le stock est 40': { check: 'textContains', target: { name: { contains: '40' } }, value: '40' } } },
      ]);

      const result = await generateResolution({ scenario, driver, provider });

      assert.equal(result.status, 'complete');
      assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('is located by the very value it asserts')));
    });

    it('capture localisée par sa valeur', async () => {
      const driver = new Drifting(page(node('text', 'Total 129', [], { value: '129' })), page(node('text', 'Total 129')));
      const provider = new ScriptedProvider([{ captures: { reference: { from: { role: 'text', name: 'Total 129' }, extract: 'number' } } }]);

      const result = await generateResolution({ scenario: capturing, driver, provider });

      assert.equal(result.status, 'complete');
      assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('is located by the very value it reads')));
    });

    it('comparaison avec soi-même', async () => {
      const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    expect: "la commande {{reference}} est affichée"
    capture:
      reference: la référence de commande
`);
      const driver = new Drifting(page(node('text', 'Order CMD-1'), node('text', 'Note')), page(node('text', 'Order CMD-1')));
      const provider = new ScriptedProvider([
        {
          captures: { reference: { from: { role: 'text', name: { contains: 'Order' } }, extract: 'text', after: 'Order ' } },
          assertions: {
            'la commande {{reference}} est affichée': { check: 'textContains', target: { role: 'text' }, value: '{{reference}}' },
          },
        },
      ]);

      const result = await generateResolution({ scenario, driver, provider });

      assert.equal(result.status, 'complete');
      assert.ok(
        result.steps[0]?.warnings.includes(
          'assertion "la commande {{reference}} est affichée" compares {{reference}} with the element it was just read from: it cannot fail',
        ),
        JSON.stringify(result.steps[0]?.warnings),
      );
    });
  });

  it('juge en temps linéaire une cible qui correspond à des dizaines de milliers d\'éléments', { timeout: 60_000 }, async () => {
    const KEY = 'le tableau a au moins 10 cellules';
    const scenario = parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: ${KEY}\n`);
    const cells = Array.from({ length: 80_000 }, (_, index) => node('cell', `C${index}`));
    const driver = new Aligned(page(node('table', 'Orders', [...cells, unnamed()])));
    const check: Check = { check: 'countAtLeast', target: { role: 'cell', within: { role: 'table', name: 'Orders' } }, value: 10 };
    const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

    const started = performance.now();
    const result = await generateUnchecked({ scenario, driver, provider });

    assert.equal(result.status, 'complete');
    // Comparer chaque identifiant à la liste entière coûtait n² : une quinzaine de secondes ici.
    assert.ok(performance.now() - started < 5_000, `${Math.round(performance.now() - started)} ms`);
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

  const expecting = (key: string) => parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: ${JSON.stringify(key)}\n`);

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
      const scenario = expecting(KEY);
      const check: Check = { check: 'textContains', target: { role: 'cell', within: { role: 'row', nth: 2 } }, value: 'Pending' };
      const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);

      const result = await generateResolution({ scenario, driver, provider, baseUrl: url });

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

  it('accepte, par un pilote qui délègue au pilote web, une capture dont le texte change à chaque lecture', async () => {
    // Chaque lecture fait avancer le compteur : les deux lectures d'un regard diffèrent toujours.
    const { driver: inner, url } = await open(
      '<ul><li aria-label="Timer"><p id="t">Uptime 0 ms</p></li></ul>' +
        '<script>let reads = 0; const t = document.getElementById("t");' +
        't.getBoundingClientRect = function () { reads += 1; this.firstChild.data = "Uptime " + reads + " ms"; return Element.prototype.getBoundingClientRect.call(this); };</script>',
    );
    const driver = new Delegating(inner);
    try {
      const scenario = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n      uptime: the uptime\n');
      const provider = new ScriptedProvider([
        { captures: { uptime: { from: { role: 'text', name: { contains: 'Uptime' }, within: { role: 'listitem', name: 'Timer' } }, extract: 'number' } } },
      ]);

      const result = await generateResolution({ scenario, driver, provider, baseUrl: url, attemptsPerStep: 1 });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('changed between the two reads')));
      const report = await runScenario({ scenario, resolution: result.resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
      assert.equal(report.status, 'passed');
    } finally {
      await driver.dispose();
    }
  });

  it('refuse la position d\'une ligne que le rejeu compte parmi plus de lignes, en comptant les lignes', async () => {
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
      assert.match(
        result.steps[0]?.rejections[0] ?? '',
        /^assertion "the second order is pending": true on your tree, but replay reads 4 element\(s\) matching its "within" where your tree shows 3: it also counts/,
      );
    } finally {
      await driver.dispose();
    }
  });

  it('refuse un absent dont le conteneur, par sa position, est un autre au rejeu, même vrai sur les deux', async () => {
    // Une liste vide mais visible, que l'élagage retire : la liste 1 du modèle est la 2 du rejeu.
    const lists = (cart: string) =>
      `<ul style="height:20px"></ul><ul aria-label="Wishlist"><li>Chair</li><li>Desk</li></ul><ul>${cart}</ul>`;
    const { driver, url } = await open(lists('<li>Table</li><li>Sofa</li>'));
    const bugged = await open(lists('<li>Table</li><li>Sofa</li><li>Lamp</li>'));
    try {
      const KEY = 'the cart holds no lamp';
      const scenario = expecting(KEY);
      const absent = (within: Record<string, unknown>) => ({
        assertions: { [KEY]: { check: 'absent', target: { role: 'listitem', name: 'Lamp', within } } },
      });
      const provider = new ScriptedProvider([
        absent({ role: 'list', nth: 1 }),
        // Une position que seul l'arbre complet porte : vraie à vide sur l'arbre du modèle.
        absent({ role: 'list', nth: 2 }),
        { assertions: { [KEY]: { check: 'absent', target: { role: 'listitem', name: 'Lamp' } } } },
      ]);

      const result = await generateResolution({ scenario, driver, provider, baseUrl: url });

      assert.equal(result.status, 'complete');
      const LISTS = `assertion "${KEY}": true on your tree, but replay reads 3 element(s) matching its "within" where your tree shows 2: ${LEFT_OUT}`;
      assert.deepEqual(result.steps[0]?.rejections, [LISTS, LISTS]);
      const report = await runScenario({ scenario, resolution: result.resolution, driver: bugged.driver, baseUrl: bugged.url, assertTimeoutMs: 0 });
      assert.equal(report.status, 'failed');
    } finally {
      await driver.dispose();
      await bugged.driver.dispose();
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
      // Sur l'arbre complet, l'icône est le troisième texte : la position lit la valeur sur les deux.
      const full = (await inner.observe()).root;
      assert.equal(matchNodes(full, { role: 'text', within: { role: 'group', name: 'Timer' } }).length, 3);
      const provider = new ScriptedProvider([{ captures: { elapsed: { from, extract: 'number' } } }]);

      const result = await generateResolution({ scenario, driver, provider, baseUrl: url, attemptsPerStep: 1 });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.ok(result.steps[0]?.warnings.some((warning) => warning.includes('changed between the two reads')));
      const report = await runScenario({ scenario, resolution: result.resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
      assert.equal(report.status, 'passed');
    } finally {
      await driver.dispose();
    }
  });

  it('compte ce que l\'arbre rendu au modèle écrit, pas ce qu\'un conteneur invisible tait', async () => {
    const { driver, url } = await open(
      '<p style="height:10px"></p><p>Total 129</p><div style="opacity:0"><p>Saved</p><p>Undo</p></div>',
    );
    try {
      const provider = new ScriptedProvider([
        reading({ role: 'text', nth: 0 }),
        reading({ role: 'text', name: { contains: 'Total' } }),
      ]);
      const shown = pruneInteractive((await driver.observe()).root);

      const result = await generateResolution({ scenario: capturing, driver, provider, baseUrl: url });

      assert.equal(result.status, 'complete');
      const lines = renderTree(shown).split('\n').filter((line) => line.trim().startsWith('text '));
      assert.equal(lines.length, 1, renderTree(shown));
      assert.match(result.steps[0]?.rejections[0] ?? '', /replay reads 4 element\(s\) matching this target where your tree shows 1: /);
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
      const rejections = result.steps.flatMap((step) => step.rejections);
      assert.equal(rejections.filter((rejection) => rejection.includes('where your tree shows')).length, 4, JSON.stringify(rejections));
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
 * Ce qui est accepté sur les deux arbres l'est sur l'arbre montré seul : rien
 * n'est plus permissif qu'en 0.5.0, qui ne jugeait que lui.
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
  const checking = parseScenario(`id: t\ntitle: t\nsteps:\n  - id: s1\n    expect: ${KEY}\n`);
  const reads = parseScenario('id: t\ntitle: t\nsteps:\n  - id: s1\n    capture:\n      c: une valeur\n');

  interface Tally {
    accepted: number;
    refusedByReplay: number;
  }

  async function judge(name: string, full: UINode, tally: Tally): Promise<void> {
    const shown = pruneInteractive(full);
    // « Ce que ton arbre montre » se compte sur les lignes que le modèle reçoit.
    assert.equal(printedIds(shown).size, renderTree(shown).split('\n').filter((line) => line !== '').length, name);
    const { checks, captures } = proposals(full);
    for (const Driver of [Aligned, TwoReads]) {
      for (const check of every(checks, 500)) {
        const driver = new Driver(full);
        const provider = new ScriptedProvider([{ assertions: { [KEY]: check } }]);
        const result = await generateUnchecked({ scenario: checking, driver, provider, attemptsPerStep: 1 });
        const alone = evaluateCheck(check, { root: shown, location: 'http://app.test/', bag: {} }).ok;
        if (result.status === 'complete') {
          tally.accepted += 1;
          assert.ok(alone, `${name} (${Driver.name}): accepted, but false on the shown tree: ${JSON.stringify(check)}`);
        } else if (alone) {
          tally.refusedByReplay += 1;
        }
      }
      for (const spec of every(captures, 250)) {
        const driver = new Driver(full);
        const provider = new ScriptedProvider([{ captures: { c: spec } }]);
        const result = await generateUnchecked({ scenario: reads, driver, provider, attemptsPerStep: 1 });
        const seen = matchOne(shown, spec.from);
        const alone = seen !== null && readCapture(seen, spec) !== null;
        if (result.status === 'complete') {
          tally.accepted += 1;
          assert.ok(alone, `${name} (${Driver.name}): accepted, but unreadable on the shown tree: ${JSON.stringify(spec)}`);
        } else if (alone) {
          tally.refusedByReplay += 1;
        }
      }
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
