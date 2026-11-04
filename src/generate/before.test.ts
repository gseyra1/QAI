import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import type {
  Action,
  Capabilities,
  Driver,
  ResolvedTarget,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import { evaluateCheck } from '../engine/assert.ts';
import { node } from '../engine/fixtures.ts';
import { matchNodes } from '../engine/match.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import type { Check, Resolution } from '../resolution/types.ts';
import { requiredVersion } from '../resolution/types.ts';
import { parseScenario } from '../scenario/load.ts';
// Confronté au schéma publié à chaque appel : voir conformance.ts.
import { generateResolution } from './conformance.ts';
import { droppedCaptures, frozenCapture, holdsNumber, readsWholeText, tautologicalCapture } from './proposal.ts';

type Screen = { location: string; root: UINode };

/** Un écran qui dépend des gestes joués : seul moyen d'avoir un « avant » distinct. */
class StagedDriver implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities: Capabilities = { hover: true, swipe: false, navigateByUrl: true, deepLink: true };
  readonly acted: Action[] = [];
  readonly #screen: (acted: readonly Action[]) => Screen;

  constructor(screen: (acted: readonly Action[]) => Screen) {
    this.#screen = screen;
  }

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async settle(): Promise<void> {}
  async dispose(): Promise<void> {}

  async observe(): Promise<UISnapshot> {
    const { location, root } = this.#screen(this.acted);
    return { platform: 'web', at: '', location, viewport: { x: 0, y: 0, width: 1280, height: 800 }, root };
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    const matched = matchNodes(this.#screen(this.acted).root, target.primary);
    return matched.length === 1
      ? { found: true, node: matched[0] as UINode, usedFallback: false }
      : { found: false, reason: matched.length === 0 ? 'no-match' : 'ambiguous', matches: matched.length };
  }

  async act(action: Action): Promise<void> {
    this.acted.push(action);
  }
}

const selfCompared = (template: string, key: string): string =>
  `assertion "${key}" compares ${template} with the element it was just read from: it cannot fail`;

/** Rend les réponses dans l'ordre ; un appel de trop fait échouer le test. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  readonly #outputs: unknown[];

  constructor(outputs: unknown[]) {
    this.#outputs = outputs;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Une copie : la génération continue d'allonger la même conversation.
    this.requests.push(structuredClone(request));
    const output = this.#outputs[this.requests.length - 1];
    assert.ok(output !== undefined, `réponse ${this.requests.length} non scénarisée`);
    return { output, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

/** Le dernier texte envoyé au modèle dans cette requête. */
function lastText(request: ModelRequest | undefined): string {
  const part = request?.messages.at(-1)?.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

function firstText(request: ModelRequest | undefined): string {
  const part = request?.messages[0]?.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

function asksForActions(request: ModelRequest | undefined): boolean {
  return request !== undefined && 'actions' in (request.responseSchema['properties'] as object);
}

/** Une boutique minimale : chaque clic ajoute un article, une navigation ne change rien. */
function shop(acted: readonly Action[]): Screen {
  const added = acted.filter((action) => action.kind === 'click').length;
  return {
    location: 'http://app.test/',
    root: node('group', 'page', [
      node('heading', 'Boutique Démo'),
      node('link', `Panier ${added}`, [node('text', String(added))]),
      node('button', 'Ajouter au panier'),
    ]),
  };
}

const ADD: Action = { kind: 'click', target: { primary: { role: 'button', name: 'Ajouter au panier' } } };
const RELOAD: Action = { kind: 'navigate', to: '.' };
const BADGE = { role: 'text', within: { role: 'link', name: { contains: 'Panier' } } } as const;
const ONE: Check = { check: 'textEquals', target: BADGE, value: '1' };
const TWO: Check = { check: 'textEquals', target: BADGE, value: '2' };
const HEADER: Check = { check: 'visible', target: { role: 'heading', name: 'Boutique Démo' } };
const NO_ERROR: Check = { check: 'absent', target: { role: 'alert' } };

const ALREADY_BEFORE = /already true on the current screen, before any gesture/;
const ALREADY_AFTER = /was already true on the screen before the gestures/;
const stale = (key: string): string =>
  `assertion "${key}" was already true before the gesture: it holds, but does not prove the step did anything`;

function adding(expect: string) {
  return parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter l'article au panier
    expect: ${JSON.stringify(expect)}
`);
}

describe('assertion déjà vraie avant le geste', () => {
  const KEY = 'le panier affiche 1 article';

  it('ne coûte aucun tour quand rien n\'était vrai avant', async () => {
    const driver = new StagedDriver(shop);
    const provider = new ScriptedProvider([{ actions: [ADD], assertions: { [KEY]: ONE } }]);
    const result = await generateResolution({ scenario: adding(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(result.steps[0]?.rejections, []);
    assert.deepEqual(result.steps[0]?.warnings, []);
  });

  /**
   * Le cas mesuré : une recharge au lieu du geste, et une assertion vraie de
   * toute façon. Renvoyée AVANT d'agir, le modèle peut encore corriger le geste.
   */
  it('renvoie une recharge avec une assertion vraie de toute façon, puis accepte le geste corrigé', async () => {
    const driver = new StagedDriver(shop);
    const provider = new ScriptedProvider([
      { actions: [RELOAD], assertions: { [KEY]: HEADER } },
      { actions: [ADD], assertions: { [KEY]: ONE } },
    ]);
    const result = await generateResolution({ scenario: adding(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 2);
    assert.ok(asksForActions(provider.requests[1]), 'le renvoi doit laisser corriger les gestes');
    assert.match(lastText(provider.requests[1]), ALREADY_BEFORE);
    assert.match(lastText(provider.requests[1]), /resend it unchanged/);
    assert.equal(result.steps[0]?.rejections.length, 1);
    assert.match(result.steps[0]?.rejections[0] ?? '', ALREADY_BEFORE);
    assert.deepEqual(result.steps[0]?.warnings, []);
    // La recharge n'a jamais été jouée.
    assert.deepEqual(driver.acted, [ADD]);
    assert.deepEqual(result.resolution.steps['s1']?.actions, [ADD]);
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: ONE });
  });

  it('accepte un invariant renvoyé tel quel, avec un avertissement, sans second renvoi', async () => {
    const key = "aucune erreur n'est affichée";
    const driver = new StagedDriver(shop);
    const proposal = { actions: [ADD], assertions: { [key]: NO_ERROR } };
    const provider = new ScriptedProvider([proposal, proposal]);
    const result = await generateResolution({ scenario: adding(key), driver, provider });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 2, 'un seul tour de plus');
    assert.equal(result.steps[0]?.attempts, 2);
    assert.deepEqual(result.steps[0]?.warnings, [stale(key)]);
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [key]: NO_ERROR });
    assert.deepEqual(driver.acted, [ADD]);
  });

  it('renvoie en phase B une assertion vraie avant, puis accepte la correction', async () => {
    const driver = new StagedDriver(shop);
    const provider = new ScriptedProvider([
      // Fausse après le geste : la phase B reprend la main.
      { actions: [ADD], assertions: { [KEY]: TWO } },
      { assertions: { [KEY]: HEADER } },
      { assertions: { [KEY]: ONE } },
    ]);
    const result = await generateResolution({ scenario: adding(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 3);
    // Le premier message de la phase B dit pourquoi la proposition a été refusée.
    assert.match(firstText(provider.requests[1]), /were rejected:\n- assertion "le panier affiche 1 article" false on this screen/);
    assert.match(lastText(provider.requests[2]), ALREADY_AFTER);
    assert.doesNotMatch(lastText(provider.requests[2]), /rejected|Fix it/, 'une question, pas un refus');
    assert.ok(lastText(provider.requests[2]).includes(JSON.stringify(HEADER)), 'la vérification à maintenir est rappelée');
    assert.deepEqual(result.steps[0]?.warnings, []);
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: ONE });
    assert.deepEqual(driver.acted, [ADD], 'la phase B ne rejoue aucun geste');
  });

  it('accepte en phase B un invariant maintenu, avec un avertissement', async () => {
    const driver = new StagedDriver(shop);
    const provider = new ScriptedProvider([
      { actions: [ADD], assertions: { [KEY]: TWO } },
      { assertions: { [KEY]: HEADER } },
      { assertions: { [KEY]: HEADER } },
    ]);
    const result = await generateResolution({ scenario: adding(KEY), driver, provider });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 3);
    assert.deepEqual(result.steps[0]?.warnings, [stale(KEY)]);
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: HEADER });
  });

  it('ne renvoie jamais au dernier tour : avertit au lieu de faire échouer l\'étape', async () => {
    const key = "aucune erreur n'est affichée";
    const provider = new ScriptedProvider([{ actions: [ADD], assertions: { [key]: NO_ERROR } }]);
    const result = await generateResolution({
      scenario: adding(key),
      driver: new StagedDriver(shop),
      provider,
      attemptsPerStep: 1,
    });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(result.steps[0]?.rejections, []);
    assert.deepEqual(result.steps[0]?.warnings, [stale(key)]);
  });

  it('ne renvoie jamais une étape qui ne fait que vérifier', async () => {
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter l'article au panier
    expect: ${JSON.stringify(KEY)}
  - id: s2
    expect: l'en-tête affiche la boutique
`);
    const provider = new ScriptedProvider([
      { actions: [ADD], assertions: { [KEY]: ONE } },
      { assertions: { "l'en-tête affiche la boutique": HEADER } },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(shop), provider });

    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(result.steps[1]?.rejections, []);
    assert.deepEqual(result.steps[1]?.warnings, []);
  });

  describe('une question ne fait jamais échouer une étape résolue sans elle', () => {
    const H = "l'en-tête reste visible";
    const both = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter l'article au panier
    expect:
      - ${JSON.stringify(H)}
      - ${JSON.stringify(KEY)}
`);

    /**
     * Avec deux tours, renvoyer avant d'agir prenait le seul tour de la phase
     * B : la vérification fausse après le geste n'était plus réparable.
     */
    it('ne renvoie pas avant d\'agir quand la réponse prendrait le dernier tour de la phase B', async () => {
      const first = { actions: [ADD], assertions: { [H]: HEADER, [KEY]: TWO } };
      const provider = new ScriptedProvider([first, { assertions: { [H]: HEADER, [KEY]: ONE } }]);
      const result = await generateResolution({
        scenario: both,
        driver: new StagedDriver(shop),
        provider,
        attemptsPerStep: 2,
      });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.ok(!asksForActions(provider.requests[1]), 'le second tour répare les vérifications');
      assert.deepEqual(result.steps[0]?.warnings, [stale(H)]);
      assert.deepEqual(result.resolution.steps['s1']?.assertions, { [H]: HEADER, [KEY]: ONE });
    });

    it('retient la proposition interrogée avant d\'agir quand aucune réponse n\'est recevable', async () => {
      const first = { actions: [ADD], assertions: { [H]: HEADER, [KEY]: ONE } };
      const nowhere = {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Commander' } } }],
        assertions: { [H]: HEADER, [KEY]: ONE },
      };
      const provider = new ScriptedProvider([first, nowhere, nowhere]);
      const result = await generateResolution({
        scenario: both,
        driver: new StagedDriver(shop),
        provider,
        attemptsPerStep: 3,
      });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.equal(provider.requests.length, 2, 'une réponse refusée rend la main');
      assert.match(result.steps[0]?.rejections[0] ?? '', ALREADY_BEFORE);
      assert.equal(result.steps[0]?.rejections.length, 2, 'le refus de la réponse reste au rapport');
      assert.deepEqual(result.steps[0]?.warnings, [stale(H)]);
      assert.deepEqual(result.resolution.steps['s1']?.actions, [ADD]);
      assert.deepEqual(result.resolution.steps['s1']?.assertions, first.assertions);
    });

    /**
     * La réponse suit le conseil — « assert what the step changed » — et se
     * trompe de valeur au dernier tour : la vérification interrogée tenait.
     */
    it('retient en phase B la vérification interrogée quand la réponse est fausse et qu\'aucun tour ne reste', async () => {
      const THREE: Check = { check: 'textEquals', target: BADGE, value: '3' };
      const provider = new ScriptedProvider([
        { actions: [ADD], assertions: { [KEY]: TWO } },
        { assertions: { [KEY]: HEADER } },
        { assertions: { [KEY]: THREE } },
      ]);
      const result = await generateResolution({
        scenario: adding(KEY),
        driver: new StagedDriver(shop),
        provider,
        attemptsPerStep: 3,
      });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.equal(result.steps[0]?.rejections.length, 3);
      assert.match(result.steps[0]?.rejections[1] ?? '', ALREADY_AFTER);
      assert.match(result.steps[0]?.rejections[2] ?? '', /false on this screen/);
      assert.deepEqual(result.steps[0]?.warnings, [stale(KEY)]);
      assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: HEADER });
    });

    it('laisse encore réparer la réponse quand un tour reste, puis la retient si elle tient', async () => {
      const THREE: Check = { check: 'textEquals', target: BADGE, value: '3' };
      const provider = new ScriptedProvider([
        { actions: [ADD], assertions: { [KEY]: TWO } },
        { assertions: { [KEY]: HEADER } },
        { assertions: { [KEY]: THREE } },
        { assertions: { [KEY]: ONE } },
      ]);
      const result = await generateResolution({
        scenario: adding(KEY),
        driver: new StagedDriver(shop),
        provider,
        attemptsPerStep: 4,
      });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.deepEqual(result.steps[0]?.warnings, []);
      assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: ONE });
    });
  });

  it('présente le renvoi comme une question, jamais comme un refus à corriger', async () => {
    const key = "aucune erreur n'est affichée";
    // Avant d'agir.
    const ahead = new ScriptedProvider([
      { actions: [ADD], assertions: { [key]: NO_ERROR } },
      { actions: [ADD], assertions: { [key]: NO_ERROR } },
    ]);
    await generateResolution({ scenario: adding(key), driver: new StagedDriver(shop), provider: ahead });
    assert.match(lastText(ahead.requests[1]), ALREADY_BEFORE);
    assert.doesNotMatch(lastText(ahead.requests[1]), /rejected|Fix it/);
    assert.match(lastText(ahead.requests[1]), /resend the rest unchanged/);

    // Après le geste, dans le premier message de la phase B : la proposition
    // n'a pas été refusée, une assertion y est seulement interrogée.
    const capture = 'le panier affiche {{nombre}} article';
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter l'article au panier
    capture:
      nombre: le nombre d'articles
    expect: ${JSON.stringify(capture)}
`);
    const proposal = {
      actions: [RELOAD],
      captures: { nombre: { from: BADGE, extract: 'number' } },
      assertions: { [capture]: { check: 'textEquals', target: BADGE, value: '{{nombre}}' } },
    };
    const after = new ScriptedProvider([proposal, { captures: proposal.captures, assertions: proposal.assertions }]);
    await generateResolution({ scenario, driver: new StagedDriver(shop), provider: after });
    const first = firstText(after.requests[1]);
    assert.match(first, ALREADY_AFTER);
    assert.doesNotMatch(first, /rejected|Fix them/);
    assert.match(first, /hold, but before they are accepted/);
  });

  it('ne dit pas refusé ce qu\'une étape qui ne fait que vérifier n\'a pas encore proposé', async () => {
    const key = "l'en-tête affiche la boutique";
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    expect: ${JSON.stringify(key)}
`);
    const provider = new ScriptedProvider([{ assertions: { [key]: HEADER } }]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(shop), provider });

    assert.equal(result.status, 'complete');
    assert.match(firstText(provider.requests[0]), /This step has no gesture/);
    assert.doesNotMatch(firstText(provider.requests[0]), /rejected|Fix them|before they are accepted/);
  });

  describe('avec une capture produite à cette étape', () => {
    const key = 'le panier affiche {{nombre}} article';
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter l'article au panier
    capture:
      nombre: le nombre d'articles
    expect: ${JSON.stringify(key)}
`);
    const proposal = (gesture: Action) => ({
      actions: [gesture],
      captures: { nombre: { from: BADGE, extract: 'number' } },
      assertions: { [key]: { check: 'textEquals', target: BADGE, value: '{{nombre}}' } },
    });

    it('n\'est pas renvoyée quand l\'écran d\'avant ne lui donne pas raison', async () => {
      const provider = new ScriptedProvider([proposal(ADD)]);
      const result = await generateResolution({ scenario, driver: new StagedDriver(shop), provider });

      assert.equal(result.status, 'complete');
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(result.steps[0]?.rejections, []);
      assert.deepEqual(result.steps[0]?.warnings, [selfCompared('{{nombre}}', key)]);
    });

    /**
     * Avant d'agir, `{{nombre}}` n'existe pas : rien à évaluer. Après, la capture
     * vaut 0, comme l'écran d'avant — c'est en phase B que ça se voit.
     */
    it('est renvoyée en phase B quand le geste ne change pas la valeur capturée', async () => {
      const provider = new ScriptedProvider([proposal(RELOAD), { captures: proposal(RELOAD).captures, assertions: proposal(RELOAD).assertions }]);
      const result = await generateResolution({ scenario, driver: new StagedDriver(shop), provider });

      assert.equal(result.status, 'complete');
      assert.equal(provider.requests.length, 2);
      assert.match(result.steps[0]?.rejections[0] ?? '', ALREADY_AFTER);
      assert.deepEqual(result.steps[0]?.warnings, [selfCompared('{{nombre}}', key), stale(key)]);
    });
  });
});

/** Une médiathèque minimale : le premier clic emprunte, le second ouvre la liste. */
function library(reference: (shown: string) => UINode[]) {
  return (acted: readonly Action[]): Screen => {
    const clicks = acted.filter((action) => action.kind === 'click').length;
    const children: UINode[] = [
      node('button', 'Emprunter'),
      node('link', 'Mes emprunts'),
    ];
    if (clicks >= 1) children.push(node('group', 'Emprunt enregistré', reference('EMP-4418')));
    if (clicks >= 2) {
      children.push(node('list', 'Liste des emprunts', [node('listitem', 'EMP-4418 — La Horde — en cours')]));
    }
    return { location: 'http://app.test/', root: node('group', 'page', children) };
  };
}

const LOAN_KEY = 'la liste des emprunts contient la référence "{{reference}}"';
const LOANS = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: emprunter l'ouvrage
    capture:
      reference: la référence de l'emprunt
  - id: s2
    do: ouvrir mes emprunts
    expect: ${JSON.stringify(LOAN_KEY)}
`);
const BORROW = {
  actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Emprunter' } } }],
  captures: {
    reference: { from: { role: 'text', nth: 0, within: { role: 'group', name: 'Emprunt enregistré' } }, extract: 'text' },
  },
};
const OPEN = { kind: 'click', target: { primary: { role: 'link', name: 'Mes emprunts' } } };
const LOAN_ITEM = { role: 'listitem', nth: 0, within: { role: 'list', name: 'Liste des emprunts' } } as const;

describe('capture nommée par l\'attente, figée en littéral', () => {
  it('réécrit en {{nom}} un littéral égal à la valeur capturée, et le signale', async () => {
    const provider = new ScriptedProvider([
      BORROW,
      { actions: [OPEN], assertions: { [LOAN_KEY]: { check: 'textContains', target: LOAN_ITEM, value: 'EMP-4418' } } },
    ]);
    const result = await generateResolution({
      scenario: LOANS,
      driver: new StagedDriver(library((shown) => [node('text', shown)])),
      provider,
    });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(provider.requests.length, 2, 'réécrit sans tour de plus');
    const stored = result.resolution.steps['s2']?.assertions?.[LOAN_KEY];
    assert.deepEqual(stored, { check: 'textContains', target: LOAN_ITEM, value: '{{reference}}' });
    assert.deepEqual(result.steps[1]?.notes, [
      `assertion "${LOAN_KEY}" compared the literal "EMP-4418", today's value of {{reference}}: rewritten to {{reference}}, so replay compares against the value captured then`,
    ]);

    // Ce que la réécriture change au rejeu : la liste montre l'ancienne
    // référence quand la capture en a lu une nouvelle. Le littéral passait.
    const wrong = { root: node('list', 'Liste des emprunts', [node('listitem', 'EMP-4418 — La Horde — en cours')]), location: '' };
    const literal: Check = { check: 'textContains', target: LOAN_ITEM, value: 'EMP-4418' };
    assert.equal(evaluateCheck(literal, { ...wrong, bag: { reference: 'EMP-4419' } }).ok, true);
    assert.equal(evaluateCheck(stored as Check, { ...wrong, bag: { reference: 'EMP-4419' } }).ok, false);
  });

  it('refuse un littéral qui contient la valeur capturée, avec la réécriture exacte', async () => {
    const provider = new ScriptedProvider([
      BORROW,
      {
        actions: [OPEN],
        assertions: { [LOAN_KEY]: { check: 'textEquals', target: LOAN_ITEM, value: 'EMP-4418 — La Horde — en cours' } },
      },
      { assertions: { [LOAN_KEY]: { check: 'textEquals', target: LOAN_ITEM, value: '{{reference}} — La Horde — en cours' } } },
    ]);
    const result = await generateResolution({
      scenario: LOANS,
      driver: new StagedDriver(library((shown) => [node('text', shown)])),
      provider,
    });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.deepEqual(result.steps[1]?.rejections, [
      `assertion "${LOAN_KEY}": the scenario names {{reference}}, but "EMP-4418 — La Horde — en cours" freezes its current value "EMP-4418", and replay would keep comparing against it once the capture changes — write {{reference}} in place of "EMP-4418": "{{reference}} — La Horde — en cours"`,
    ]);
    assert.match(firstText(provider.requests[2]), /write \{\{reference\}\} in place of "EMP-4418"/);
    assert.deepEqual(result.resolution.steps['s2']?.assertions?.[LOAN_KEY], {
      check: 'textEquals',
      target: LOAN_ITEM,
      value: '{{reference}} — La Horde — en cours',
    });
  });

  /**
   * Le cas de examples/library : la capture a lu « Référence EMP-4418 », la
   * vérification compare « EMP-4418 ». Ni `{{reference}}` (faux sur la liste)
   * ni un refus (la capture est à une étape déjà résolue) : un avertissement.
   */
  it('signale, sans refuser, un littéral qui n\'est qu\'une partie de la valeur capturée', async () => {
    const provider = new ScriptedProvider([
      BORROW,
      // « Référence EMP-4418 » : renvoyée une fois, et maintenue ici.
      { captures: BORROW.captures },
      { actions: [OPEN], assertions: { [LOAN_KEY]: { check: 'textContains', target: LOAN_ITEM, value: 'EMP-4418' } } },
    ]);
    const result = await generateResolution({
      scenario: LOANS,
      driver: new StagedDriver(library((shown) => [node('text', `Référence ${shown}`, [node('text', shown)])])),
      provider,
    });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(provider.requests.length, 3);
    assert.deepEqual(result.steps[1]?.rejections, []);
    assert.deepEqual(result.steps[1]?.warnings, [
      `assertion "${LOAN_KEY}" compares the literal "EMP-4418", only part of today's value of {{reference}} ("Référence EMP-4418"): replay keeps comparing against today's value — capture exactly that part at the step that reads it, then use {{reference}}`,
    ]);
    assert.equal(
      (result.resolution.steps['s2']?.assertions?.[LOAN_KEY] as { value?: unknown }).value,
      'EMP-4418',
    );
  });

  it('masque une valeur capturée venue de l\'environnement dans le refus', async () => {
    const SECRET = 'K9-SECRET-7731';
    const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: saisir le code QAI_GEN_CODE
    capture:
      code: le code affiché
  - id: s2
    do: valider
    expect: 'le récapitulatif rappelle "{{code}}"'
`);
    let typed = '';
    const driver = new StagedDriver((acted) => {
      const children: UINode[] = [node('textbox', 'Code'), node('button', 'Valider')];
      if (typed !== '') children.push(node('group', 'Code saisi', [node('text', typed)]));
      if (acted.some((action) => action.kind === 'click')) children.push(node('text', `Rappel : ${typed}`));
      return { location: 'http://app.test/', root: node('group', 'page', children) };
    });
    const act = driver.act.bind(driver);
    driver.act = async (action: Action) => {
      if (action.kind === 'fill') typed = action.value;
      await act(action);
    };
    const KEY = 'le récapitulatif rappelle "{{code}}"';
    const RECAP = { role: 'text', name: { contains: 'Rappel' } } as const;
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'fill', target: { primary: { role: 'textbox', name: 'Code' } }, value: '{{env.QAI_GEN_CODE}}' }],
        captures: { code: { from: { role: 'text', within: { role: 'group', name: 'Code saisi' } }, extract: 'text' } },
      },
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        assertions: { [KEY]: { check: 'textEquals', target: RECAP, value: `Rappel : ${SECRET}` } },
      },
      { assertions: { [KEY]: { check: 'textEquals', target: RECAP, value: 'Rappel : {{code}}' } } },
    ]);

    process.env['QAI_GEN_CODE'] = SECRET;
    try {
      const result = await generateResolution({ scenario, driver, provider });

      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.deepEqual(result.steps[1]?.rejections, [
        `assertion "${KEY}": the scenario names {{code}}, but "Rappel : [secret]" freezes its current value "[secret]", and replay would keep comparing against it once the capture changes — write {{code}} in place of "[secret]": "Rappel : {{code}}"`,
      ]);
      assert.ok(!JSON.stringify(result).includes(SECRET), 'le secret ne doit figurer nulle part dans le résultat');
      // Le refus tel que renvoyé au fournisseur, qui est un tiers.
      const refusal = firstText(provider.requests[2]).split('were rejected:')[1] ?? '';
      assert.match(refusal, /in place of "\[secret\]"/);
      assert.ok(!refusal.includes(SECRET));
      assert.deepEqual(result.resolution.steps['s2']?.assertions?.[KEY], {
        check: 'textEquals',
        target: RECAP,
        value: 'Rappel : {{code}}',
      });
    } finally {
      delete process.env['QAI_GEN_CODE'];
    }
  });
});

describe('égalité trop courte avec une capture nommée', () => {
  const KEY = 'le panier affiche {{quantite}} article, livré en 1 jour';
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: ajouter l'article au panier
    capture:
      quantite: le nombre d'articles
    expect: ${JSON.stringify(KEY)}
`);
  const DELIVERY = { role: 'text', within: { role: 'group', name: 'Livraison' } } as const;
  // Le délai n'apparaît qu'avec un article : rien n'y est vrai avant le geste.
  const screen = (acted: readonly Action[]): Screen => {
    const added = acted.filter((action) => action.kind === 'click').length;
    const children = [node('link', `Panier ${added}`, [node('text', String(added))]), node('button', 'Ajouter au panier')];
    if (added > 0) children.push(node('group', 'Livraison', [node('text', '1')]));
    return { location: 'http://app.test/', root: node('group', 'page', children) };
  };
  const delivery = { check: 'numberEquals', target: DELIVERY, value: '1' };
  const proposal = (check: object) => ({
    actions: [ADD],
    captures: { quantite: { from: BADGE, extract: 'number' } },
    assertions: { [KEY]: check },
  });

  it('pose la question une fois, et garde le littéral maintenu, avec un avertissement', async () => {
    const provider = new ScriptedProvider([proposal(delivery), { captures: proposal(delivery).captures, assertions: { [KEY]: delivery } }]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(provider.requests.length, 2);
    assert.match(firstText(provider.requests[1]), /a value this short can match by chance/);
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: delivery }, 'la vérification du délai reste celle du délai');
    assert.equal(result.steps[0]?.warnings.length, 1);
    assert.match(result.steps[0]?.warnings[0] ?? '', /too short to tell whether it is the capture: kept as is/);
  });

  it('versionne {{quantite}} quand le modèle répond que c\'était la capture', async () => {
    const quantity = { check: 'numberEquals', target: BADGE, value: '1' };
    const answered = { check: 'numberEquals', target: BADGE, value: '{{quantite}}' };
    const provider = new ScriptedProvider([proposal(quantity), { captures: proposal(quantity).captures, assertions: { [KEY]: answered } }]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: answered });
    assert.deepEqual(result.steps[0]?.warnings, [selfCompared('{{quantite}}', KEY)]);
  });

  it('avertit sans réécrire quand aucun tour ne reste pour la question', async () => {
    const provider = new ScriptedProvider([proposal(delivery)]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider, attemptsPerStep: 1 });

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.deepEqual(result.resolution.steps['s1']?.assertions, { [KEY]: delivery });
    assert.match(result.steps[0]?.warnings[0] ?? '', /kept as is/);
  });
});

describe('frozenCapture', () => {
  const key = 'le total vaut {{prix}}';
  const total = { role: 'text', within: { role: 'group', name: 'Total' } };

  it('réécrit un nombre égal à la capture, au format près pour numberEquals', () => {
    for (const value of [139, '139', '139,00 €']) {
      const outcome = frozenCapture(key, { check: 'numberEquals', target: total, value }, { prix: '139' });
      assert.deepEqual(outcome?.check, { check: 'numberEquals', target: total, value: '{{prix}}' }, String(value));
    }
    // Un autre nombre n'est pas la capture.
    assert.equal(frozenCapture(key, { check: 'numberEquals', target: total, value: 1390 }, { prix: '139' }), null);
  });

  it('ignore une vérification qui référence déjà la capture, ou qui porte un autre gabarit', () => {
    assert.equal(frozenCapture(key, { check: 'textContains', target: total, value: '{{prix}}' }, { prix: '39' }), null);
    assert.equal(frozenCapture(key, { check: 'textEquals', target: total, value: '{{autre}} 39' }, { prix: '39' }), null);
  });

  it('voit un littéral figé même quand la cible emploie la capture', () => {
    const named = { role: 'listitem', name: { contains: '{{prix}}' } };
    const outcome = frozenCapture(key, { check: 'textEquals', target: named, value: '39,00' }, { prix: '39,00' });
    assert.deepEqual(outcome?.check, { check: 'textEquals', target: named, value: '{{prix}}' });
  });

  it('ignore une capture inconnue, une variable d\'environnement, une vérification sans littéral', () => {
    assert.equal(frozenCapture(key, { check: 'textEquals', target: total, value: '39' }, {}), null);
    assert.equal(frozenCapture('vaut {{env.PRIX}}', { check: 'textEquals', target: total, value: '39' }, { PRIX: '39' }), null);
    assert.equal(frozenCapture(key, { check: 'countAtLeast', target: total, value: 39 }, { prix: '39' }), null);
  });

  it('ne voit pas une capture au milieu d\'un autre mot', () => {
    assert.equal(
      frozenCapture('année {{an}}', { check: 'textContains', target: total, value: 'Copyright 2012' }, { an: '201' }),
      null,
    );
  });

  /** Voir MIN_EMBEDDED : « 1 » dans « Livraison en 1 jour » n'est pas une preuve. */
  it('signale sans refuser une valeur courte retrouvée dans le littéral', () => {
    const short = frozenCapture(
      'le panier affiche {{n}} article',
      { check: 'textEquals', target: total, value: 'Panier 1' },
      { n: '1' },
    );
    assert.equal(short?.error, undefined);
    assert.match(short?.warning ?? '', /holds "1", today's value of \{\{n\}\}/);
  });

  /**
   * L'égalité courte non plus n'est pas une preuve : « livré en 1 jour »
   * comparé à « 1 » quand la quantité vaut 1. Réécrite en silence, la
   * vérification du délai suivrait la quantité au rejeu.
   */
  it('ne réécrit pas une égalité trop courte : la pose en question au modèle', () => {
    const delivery = { role: 'text', within: { role: 'group', name: { contains: 'Livraison' } } };
    const outcome = frozenCapture(
      'le panier affiche {{quantite}} article, livré en 1 jour',
      { check: 'numberEquals', target: delivery, value: '1' },
      { quantite: '1' },
    );
    assert.equal(outcome?.check, undefined, 'rien n\'est réécrit sans la réponse du modèle');
    assert.equal(outcome?.error, undefined);
    assert.match(outcome?.question ?? '', /if it is that capture, write \{\{quantite\}\} in its place.*resend it unchanged/);
    assert.match(outcome?.warning ?? '', /too short to tell whether it is the capture: kept as is/);
    // Un nombre court aussi, au format près.
    assert.ok(frozenCapture(key, { check: 'numberEquals', target: total, value: '39,00 €' }, { prix: '39' })?.question);
  });

  it('ne réécrit, dans la réécriture proposée, que les occurrences qui sont un mot entier', () => {
    const outcome = frozenCapture(
      'la liste contient la commande {{n}}',
      { check: 'textContains', target: total, value: 'Commande 442, lot 44218' },
      { n: '442' },
    );
    assert.match(outcome?.error ?? '', /: "Commande \{\{n\}\}, lot 44218"$/);
    const twice = frozenCapture('url {{q}}', { check: 'urlContains', value: '/orders/4418?x=4418' }, { q: '4418' });
    assert.match(twice?.error ?? '', /: "\/orders\/\{\{q\}\}\?x=\{\{q\}\}"$/);
  });

  /**
   * L'ordre de la phrase ne décide pas : « EMP-4418 » EST {{reference}}. Le
   * refus pour {{prefixe}} faisait écrire « {{prefixe}}-4418 », que la règle ne
   * voyait plus ensuite — « 4418 » restait figé.
   */
  it('préfère l\'égalité avec une capture à l\'inclusion d\'une autre, et la plus longue d\'abord', () => {
    const key = 'la ligne {{prefixe}} porte la référence {{reference}}';
    const equal = frozenCapture(
      key,
      { check: 'textEquals', target: total, value: 'EMP-4418' },
      { prefixe: 'EMP', reference: 'EMP-4418' },
    );
    assert.deepEqual(equal?.check, { check: 'textEquals', target: total, value: '{{reference}}' });
    assert.equal(equal?.error, undefined);

    const contained = frozenCapture(
      key,
      { check: 'textContains', target: total, value: 'Ligne EMP-4418' },
      { prefixe: 'EMP', reference: 'EMP-4418' },
    );
    assert.match(contained?.error ?? '', /: "Ligne \{\{reference\}\}"$/);
  });
});

/**
 * Mesuré avec DeepSeek sur le parcours de commande : la fiche n'a pas de conteneur
 * nommé, et la capture du prix finit en `{ role: text, nth: 0 }`, qui compte depuis
 * le haut de la page et lit le compteur du panier. L'attente sur le total est
 * refusée (`expected 0, observed 129`), et le modèle recopie 129 de l'écran : vert
 * à la génération sur une attente fausse, rouge au premier prix changé.
 */
describe('une attente qui nomme une capture, traduite sans elle', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const html = await readFile('fixtures/shop/index.html', 'utf8');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const KEY = 'le total est égal à {{prix}}';
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: rechercher "chaise de bureau"
  - id: s2
    do: ouvrir le premier article de la liste
    capture:
      prix: le prix affiché
  - id: s3
    do: ajouter l'article au panier
  - id: s4
    do: ouvrir le panier
    expect: ${JSON.stringify(KEY)}
`);
  const total = { role: 'text', within: { role: 'group', name: 'Total' } };
  const search = {
    actions: [
      { kind: 'fill', target: { primary: { role: 'searchbox', name: 'Rechercher un produit' } }, value: 'chaise de bureau' },
      { kind: 'press', key: 'Enter' },
    ],
  };
  const open = { kind: 'click', target: { primary: { role: 'link', nth: 0, within: { role: 'list', name: 'Résultats' } } } };
  const add = { actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Ajouter au panier' } } }] };
  const cart = { kind: 'click', target: { primary: { role: 'link', name: { contains: 'Panier' } } } };
  const compared = { check: 'numberEquals', target: total, value: '{{prix}}' };

  /** Le premier « text » de la page est le compteur du panier, pas le prix. */
  const wrongPrice = { from: { role: 'text', nth: 0 }, extract: 'number' };
  const rightPrice = { from: { role: 'text', name: { contains: '€' } }, extract: 'number' };

  /** `read` : les réponses à la relecture de la capture, quand elle est posée. */
  async function generate(price: unknown, outputs: unknown[], read: unknown[] = [], attemptsPerStep = 5) {
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    const provider = new ScriptedProvider([
      search,
      { actions: [open], captures: { prix: price } },
      ...read,
      add,
      ...outputs,
    ]);
    try {
      await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
      return { result: await generateResolution({ scenario, driver, provider, baseUrl, attemptsPerStep }), provider };
    } finally {
      await driver.dispose();
    }
  }

  /** Le modèle maintient sa capture : la relecture n'y a rien changé. */
  const maintained = [{ captures: { prix: wrongPrice } }];

  it('refuse le littéral recopié après `expected X, observed Y`, et l\'étape échoue', async () => {
    const { result, provider } = await generate(wrongPrice, [
      { actions: [cart], assertions: { [KEY]: compared } },
      { assertions: { [KEY]: { check: 'numberEquals', target: total, value: 129 } } },
      { assertions: { [KEY]: { check: 'textEquals', target: total, value: '129,00 €' } } },
      { assertions: { [KEY]: compared } },
      { assertions: { [KEY]: { check: 'numberEquals', target: total, value: '129' } } },
    ], maintained);

    assert.equal(result.status, 'incomplete', JSON.stringify(result.steps));
    const report = result.steps[3];
    assert.equal(report?.status, 'failed');
    assert.equal(report?.attempts, 5);
    assert.equal(result.resolution.steps['s4'], undefined, 'rien de versionné');
    assert.match(report?.rejections[0] ?? '', /expected 0, observed 129/);
    assert.match(report?.rejections[1] ?? '', /the scenario compares against \{\{prix\}\}, which holds "0", but this check does not use it/);
    assert.match(lastText(provider.requests[7]), /a literal copied from the screen is not the fix/);
  });

  it('refuse aussi de lâcher la comparaison pour un `visible`', async () => {
    const shown = { [KEY]: { check: 'visible', target: total } };
    const { result } = await generate(wrongPrice, [
      { actions: [cart], assertions: { [KEY]: compared } },
      { assertions: shown },
      { assertions: shown },
      { assertions: shown },
      { assertions: shown },
    ], maintained);

    assert.equal(result.status, 'incomplete', JSON.stringify(result.steps));
    assert.equal(result.resolution.steps['s4'], undefined);
  });

  it('montre au modèle ce qu\'une capture située par sa position a lu, et retient sa correction', async () => {
    const { result, provider } = await generate(
      wrongPrice,
      [{ actions: [cart], assertions: { [KEY]: compared } }],
      [{ captures: { prix: rightPrice } }],
    );

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    const asked = firstText(provider.requests[2]);
    assert.match(asked, /capture "prix" is located by its position alone, and read "0" from text "0" #cart-count, inside link "Panier 0"/);
    assert.match(asked, /it is meant to hold "le prix affiché"/);
    assert.match(asked, /text "129,00 €" #product-price/, 'avec l\'écran sous les yeux');
    assert.deepEqual(result.resolution.steps['s2']?.captures?.['prix'], rightPrice);
    assert.deepEqual(result.steps[1]?.warnings, []);
    assert.deepEqual(result.resolution.steps['s4']?.assertions?.[KEY], compared);
  });

  it('pose la question même au dernier tour : elle est hors du compte', async () => {
    const { result, provider } = await generate(
      wrongPrice,
      [{ actions: [cart], assertions: { [KEY]: compared } }],
      [{ captures: { prix: rightPrice } }],
      1,
    );

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(result.steps[1]?.attempts, 1);
    assert.equal(provider.requests.length, 5);
  });

  it('garde la capture et le signale quand aucune réponse ne tranche', async () => {
    const lost = { from: { role: 'text', within: { role: 'group', name: 'Fiche' } }, extract: 'number' };
    const { result } = await generate(
      wrongPrice,
      [{ actions: [cart], assertions: { [KEY]: compared } }, ...Array.from({ length: 4 }, () => ({ assertions: { [KEY]: compared } }))],
      [{ captures: { prix: lost } }, { captures: { prix: lost } }],
    );

    assert.deepEqual(result.steps[1]?.warnings, [
      `capture "prix" is located by its position alone and reads "0" from text "0" #cart-count, inside link "Panier 0": nothing confirmed it is "le prix affiché"`,
    ]);
    assert.deepEqual(result.resolution.steps['s2']?.captures?.['prix'], wrongPrice);
  });

  it('dit pourquoi la cible d\'une capture manque', async () => {
    const stuck = async (from: unknown): Promise<string> => {
      const price = { from, extract: 'number' };
      const { result } = await generate(price, [], Array.from({ length: 4 }, () => ({ captures: { prix: price } })));
      return result.steps[1]?.rejections[0] ?? '';
    };

    assert.match(await stuck({ role: 'text' }), /capture "prix": 3 elements match its target: disambiguate/);
    assert.match(
      await stuck({ role: 'text', nth: 0, within: { role: 'group', name: 'Chaise de bureau' } }),
      /capture "prix": its "within" designates no element: use a container named in the tree, or \{ "contains": "..." \} on the stable part of the element's own text/,
    );
    assert.match(await stuck({ role: 'text', name: 'Prix' }), /capture "prix": no element matches its target/);
  });

  it('résout la même étape quand la capture a lu le prix', async () => {
    const { result, provider } = await generate(rightPrice, [{ actions: [cart], assertions: { [KEY]: compared } }]);

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(provider.requests.length, 4);
    assert.deepEqual(result.steps[3]?.rejections, []);
    assert.deepEqual(result.resolution.steps['s4']?.assertions?.[KEY], compared);
  });

  it('refuse un littéral qui porte la valeur du jour sous une autre écriture', async () => {
    const { result } = await generate(rightPrice, [
      { actions: [cart], assertions: { [KEY]: { check: 'textEquals', target: total, value: '129,00 €' } } },
      { assertions: { [KEY]: compared } },
    ]);

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.match(result.steps[3]?.rejections[0] ?? '', /which holds "129", but this check does not use it/);
    assert.deepEqual(result.resolution.steps['s4']?.assertions?.[KEY], compared);
  });
});

describe('droppedCaptures', () => {
  const key = 'le total vaut {{prix}}';
  const total = { role: 'text', within: { role: 'group', name: 'Total' } };

  it('nomme chaque capture que la vérification n\'emploie pas', () => {
    assert.match(droppedCaptures(key, { check: 'numberEquals', target: total, value: 129 }, { prix: '0' })[0] ?? '', /\{\{prix\}\}/);
    assert.match(droppedCaptures(key, { check: 'visible', target: total }, { prix: '0' })[0] ?? '', /\{\{prix\}\}/);
    assert.equal(droppedCaptures('{{a}} et {{b}}', { check: 'visible', target: total }, { a: 'x', b: 'y' }).length, 2);
    assert.equal(
      droppedCaptures('{{a}} et {{b}}', { check: 'textEquals', target: total, value: '{{a}}' }, { a: 'x', b: 'y' }).length,
      1,
    );
  });

  it('accepte la capture employée dans la valeur, la cible ou son conteneur', () => {
    const named = { role: 'listitem', name: { contains: '{{prix}}' } };
    assert.deepEqual(droppedCaptures(key, { check: 'numberEquals', target: total, value: '{{prix}}' }, { prix: '0' }), []);
    assert.deepEqual(droppedCaptures(key, { check: 'textContains', target: named, value: 'en cours' }, { prix: '0' }), []);
    assert.deepEqual(droppedCaptures(key, { check: 'visible', target: { role: 'text', within: named } }, { prix: '0' }), []);
    assert.deepEqual(droppedCaptures(key, { check: 'urlContains', value: '/commandes/{{prix}}' }, { prix: '0' }), []);
  });

  it('ignore une capture inconnue, vide, une variable d\'environnement, une forme invalide', () => {
    assert.deepEqual(droppedCaptures(key, { check: 'visible', target: total }, {}), []);
    assert.deepEqual(droppedCaptures(key, { check: 'visible', target: total }, { prix: ' ' }), []);
    assert.deepEqual(droppedCaptures('vaut {{env.PRIX}}', { check: 'visible', target: total }, { PRIX: '39' }), []);
    assert.deepEqual(droppedCaptures(key, 'visible', { prix: '39' }), []);
  });
});

/**
 * Dans un vrai navigateur, sur la boutique de démonstration : la recharge
 * mesurée avec DeepSeek, avec une assertion vraie de toute façon.
 */
describe('déjà vraie avant le geste, contre l\'application réelle', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const html = await readFile('fixtures/shop/index.html', 'utf8');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const KEY = 'the result list holds at least one item';
  const scenario = parseScenario(`
id: t
title: t
steps:
  - id: s1
    do: search for "chaise de bureau"
    expect: ${JSON.stringify(KEY)}
`);
  const anyway = { [KEY]: { check: 'visible', target: { role: 'searchbox', name: 'Rechercher un produit' } } };
  const search: Action[] = [
    { kind: 'fill', target: { primary: { role: 'searchbox', name: 'Rechercher un produit' } }, value: 'chaise de bureau' },
    { kind: 'press', key: 'Enter' },
  ];
  const results = {
    [KEY]: { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', name: 'Résultats' } }, value: 1 },
  };

  async function generate(outputs: unknown[]) {
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    const provider = new ScriptedProvider(outputs);
    try {
      await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
      return { result: await generateResolution({ scenario, driver, provider, baseUrl }), provider };
    } finally {
      await driver.dispose();
    }
  }

  it('renvoie la recharge avant de la jouer, et accepte la recherche corrigée', async () => {
    const { result, provider } = await generate([
      { actions: [RELOAD], assertions: anyway },
      { actions: search, assertions: results },
    ]);

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(provider.requests.length, 2);
    assert.match(result.steps[0]?.rejections[0] ?? '', ALREADY_BEFORE);
    assert.deepEqual(result.steps[0]?.warnings, []);
    assert.deepEqual(result.resolution.steps['s1']?.actions, search);
  });

  it('accepte la recharge maintenue, avec un avertissement', async () => {
    const reload = { actions: [RELOAD], assertions: anyway };
    const { result, provider } = await generate([reload, reload]);

    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(result.steps[0]?.warnings, [stale(KEY)]);
    assert.deepEqual(result.resolution.steps['s1']?.actions, [RELOAD]);
  });
});

describe('une cible qui porte un nombre', () => {
  const button = (name: string): UINode => node('button', name);
  const screen = (): Screen => ({ location: 'http://app.test/', root: node('group', 'page', [button('Panier 1')]) });
  const click = (name: string | { contains: string }): unknown => ({
    actions: [{ kind: 'click', target: { primary: { role: 'button', name } } }],
    captures: {},
    assertions: {},
  });
  const scenario = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: ouvrir le panier
`);

  it('est signalée, sans appel de plus au modèle', async () => {
    const provider = new ScriptedProvider([click('Panier 1')]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });
    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 1);
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('"Panier 1" holds a number')));
  });

  it("n'est pas signalée sous sa forme stable", async () => {
    const provider = new ScriptedProvider([click({ contains: 'Panier' })]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });
    assert.deepEqual(result.steps[0]?.warnings, []);
  });

  it('regarde aussi le conteneur', async () => {
    const nested = (): Screen => ({
      location: 'http://app.test/',
      root: node('group', 'page', [node('group', 'Commande 42', [button('Ouvrir')])]),
    });
    const within = {
      actions: [
        { kind: 'click', target: { primary: { role: 'button', within: { role: 'group', name: 'Commande 42' } } } },
      ],
      captures: {},
      assertions: {},
    };
    const provider = new ScriptedProvider([within]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(nested), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('"Commande 42" holds a number')), JSON.stringify(result.steps));
  });

  it('reconnaît les chiffres de toutes les écritures', () => {
    assert.equal(holdsNumber('カート３'), true);
    assert.equal(holdsNumber('سلة ٣'), true);
    assert.equal(holdsNumber('Panier'), false);
  });

  it('ignore un gabarit, qui ne porte aucun chiffre affiché', async () => {
    const captured = (): Screen => ({ location: 'http://app.test/', root: node('group', 'page', [button('{{env.TOKEN1}}')]) });
    const provider = new ScriptedProvider([click('{{env.TOKEN1}}')]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(captured), provider });
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(result.steps[0]?.warnings, []);
  });
});

describe('une capture bornée, à la génération', () => {
  const sentence = (): Screen => ({
    location: 'http://app.test/',
    root: node('group', 'page', [
      node('button', 'Valider'),
      node('text', 'Commande CMD-1042 confirmée'),
    ]),
  });
  const scenario = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    capture:
      reference: la référence
`);
  const proposal = (bounds: Record<string, unknown>): unknown => ({
    actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
    captures: { reference: { from: { role: 'text' }, extract: 'text', ...bounds } },
    assertions: {},
  });

  it('versionne les bornes, en v4', async () => {
    const provider = new ScriptedProvider([proposal({ after: 'Commande ', before: ' confirmée' })]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(requiredVersion(result.resolution as Resolution), 4);
    assert.deepEqual(result.resolution?.steps['s1']?.captures?.['reference'], {
      from: { role: 'text' },
      extract: 'text',
      after: 'Commande ',
      before: ' confirmée',
    });
  });

  it('refuse une borne absente, en montrant le texte lu', async () => {
    const provider = new ScriptedProvider([
      proposal({ after: 'Order ' }),
      { captures: { reference: { from: { role: 'text' }, extract: 'text', after: 'Commande ' } }, assertions: {} },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.match(lastText(provider.requests[1]), /nothing readable between.*Commande CMD-1042 confirmée/);
  });

  it('refuse une borne vide', async () => {
    const provider = new ScriptedProvider([
      proposal({ after: ' ' }),
      { captures: { reference: { from: { role: 'text' }, extract: 'text', after: 'Commande ' } }, assertions: {} },
    ]);
    await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.match(lastText(provider.requests[1]), /"after" must be a non-empty text/);
  });

  it('signale une borne qui porte un nombre', async () => {
    const provider = new ScriptedProvider([proposal({ after: 'CMD-1042 ' })]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('bounded by "CMD-1042 "')), JSON.stringify(result.steps));
  });

  it('signale une borne qui porte une capture antérieure', async () => {
    const twoSteps = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: lire
    capture:
      code: le code
  - id: s2
    do: valider
    capture:
      suite: la suite
`);
    const screen = (): Screen => ({
      location: 'http://app.test/',
      root: node('group', 'page', [node('button', 'Valider'), node('heading', 'ABCD'), node('text', 'Code ABCD puis EFGH')]),
    });
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        captures: { code: { from: { role: 'heading' }, extract: 'text' } },
      },
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        captures: { suite: { from: { role: 'text' }, extract: 'text', after: 'ABCD puis ' } },
      },
    ]);
    const result = await generateResolution({ scenario: twoSteps, driver: new StagedDriver(screen), provider });
    assert.ok(result.steps[1]?.warnings.some((w) => w.includes('value of an earlier capture')), JSON.stringify(result.steps));
  });

  it('signale une capture bornée dont le nom porte la valeur lue', async () => {
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        captures: {
          reference: {
            from: { role: 'text', name: { contains: 'Commande CMD-1042' } },
            extract: 'text',
            after: 'Commande ',
            before: ' confirmée',
          },
        },
        assertions: {},
      },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('located by the very value')), JSON.stringify(result.steps));
  });

  it('signale une capture dont le locator porte la valeur lue', async () => {
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        captures: {
          reference: {
            from: { role: 'text', name: { contains: 'CMD-1042' } },
            extract: 'text',
            after: 'Commande ',
            before: ' confirmée',
          },
        },
        assertions: {},
      },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('located by the very value')), JSON.stringify(result.steps));
  });
});

describe("une capture qui lit tout un texte", () => {
  const sentence = (): Screen => ({
    location: 'http://app.test/',
    root: node('group', 'page', [node('button', 'Valider'), node('text', 'Commande CMD-1042 confirmée')]),
  });
  const scenario = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    capture:
      reference: le numéro de commande
`);
  const gesture = [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }];
  const whole = { from: { role: 'text' }, extract: 'text' };

  it('est renvoyée une fois, et la borne du modèle est retenue', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: {} },
      { captures: { reference: { ...whole, after: 'Commande ', before: ' confirmée' } }, assertions: {} },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.match(lastText(provider.requests[1]), /read the whole text "Commande CMD-1042 confirmée"/);
    assert.match(lastText(provider.requests[1]), /le numéro de commande/);
    assert.deepEqual(result.steps[0]?.warnings, []);
    assert.equal(result.resolution?.steps['s1']?.captures?.['reference']?.after, 'Commande ');
  });

  it('maintenue, elle passe sans bruit : le modèle a tranché', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: {} },
      { captures: { reference: whole }, assertions: {} },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.status, 'complete');
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(result.steps[0]?.warnings, []);
  });

  it('sans tour pour répondre, elle reste signalée', async () => {
    const provider = new ScriptedProvider([{ actions: gesture, captures: { reference: whole }, assertions: {} }]);
    const result = await generateResolution({
      scenario,
      driver: new StagedDriver(sentence),
      provider,
      attemptsPerStep: 1,
    });
    assert.equal(result.status, 'complete');
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('reads the whole text')));
  });

  it('corrige une borne mal recopiée, une fois', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: {} },
      { captures: { reference: { ...whole, after: 'Order ' } } },
      { captures: { reference: { ...whole, after: 'Commande ', before: ' confirmée' } } },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(result.resolution.steps['s1']?.captures?.['reference']?.after, 'Commande ');
    assert.match(lastText(provider.requests[2]), /nothing readable between/);
  });

  it('reste signalée quand le modèle ne tranche pas', async () => {
    let turn = 0;
    const provider: ModelProvider = {
      name: 'panne',
      async complete(): Promise<ModelResponse> {
        turn += 1;
        if (turn === 2) throw new Error('indisponible');
        return {
          output: { actions: gesture, captures: { reference: whole }, assertions: {} },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const failed = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(failed.status, 'complete');
    assert.ok(failed.steps[0]?.warnings.some((w) => w.includes('reads the whole text')));

    const refused = await generateResolution({
      scenario,
      driver: new StagedDriver(sentence),
      provider: new ScriptedProvider([
        { actions: gesture, captures: { reference: whole }, assertions: {} },
        { captures: { reference: { ...whole, after: 'Order ' } } },
        { captures: { reference: { ...whole, after: 'Ordre ' } } },
      ]),
    });
    assert.ok(refused.steps[0]?.warnings.some((w) => w.includes('reads the whole text')));
  });

  it('retient des bornes renvoyées sans le reste de la capture', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: {} },
      { captures: { reference: { after: 'Commande ', before: ' confirmée' } } },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.resolution.steps['s1']?.captures?.['reference']?.after, 'Commande ');
  });

  it('accepte les captures renvoyées sans leur enveloppe', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: {} },
      { reference: { ...whole, after: 'Commande ', before: ' confirmée' } },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.resolution.steps['s1']?.captures?.['reference']?.after, 'Commande ');
  });

  it('reste signalée quand la réponse ne parle pas de la capture', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: {} },
      { captures: {} },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('reads the whole text')));
  });

  it('survit à une capture de la question dont la cible se vide', async () => {
    const twoReads = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: lire
    capture:
      filtre: le filtre
  - id: s2
    do: valider
    capture:
      ligne: la ligne du filtre
      filtre: le filtre
`);
    let cleared = false;
    const screen = (acted: readonly Action[]): Screen => {
      cleared = acted.length >= 2;
      return {
        location: 'http://app.test/',
        root: node('group', 'page', [
          node('button', 'Valider'),
          { ...node('textbox', 'Filtre'), value: cleared ? '' : 'CMD-1042' },
          node('text', 'CMD-1042 livrée'),
        ]),
      };
    };
    const click = { kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } };
    const provider = new ScriptedProvider([
      { actions: [click], captures: { filtre: { from: { role: 'textbox' }, extract: 'value' } } },
      {
        actions: [click],
        captures: {
          ligne: { from: { role: 'text', name: { contains: '{{filtre}}' } }, extract: 'text' },
          filtre: { from: { role: 'textbox' }, extract: 'value' },
        },
      },
      { captures: {} },
    ]);
    const result = await generateResolution({ scenario: twoReads, driver: new StagedDriver(screen), provider, attemptsPerStep: 2 });
    assert.ok(result.steps.length === 2, JSON.stringify(result.steps));
  });

  it('ne traite pas comme entière une capture déjà bornée', async () => {
    const client = (): Screen => ({
      location: 'http://app.test/',
      root: node('group', 'page', [node('button', 'Valider'), node('text', 'Client : Jean Dupont')]),
    });
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: { ...whole, after: 'Client : ' } }, assertions: {} },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(client), provider, attemptsPerStep: 1 });
    assert.deepEqual(result.steps[0]?.warnings, []);
  });

  it('survit à une capture nulle dans la réponse', async () => {
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: null }, assertions: {} },
      { captures: { reference: { from: { role: 'button' }, extract: 'text' } } },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(sentence), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
  });

  it('ne rouvre pas les vérifications déjà prouvées', async () => {
    const withCheck = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    expect: le bouton reste là
    capture:
      reference: le numéro de commande
`);
    const kept = { check: 'visible', target: { role: 'text', name: { contains: 'confirmée' } } };
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: { 'le bouton reste là': kept } },
      {
        captures: { reference: { ...whole, after: 'Commande ', before: ' confirmée' } },
        assertions: { 'le bouton reste là': { check: 'visible', target: { role: 'group' } } },
      },
    ]);
    const staged = (acted: readonly Action[]): Screen => {
      const shown = acted.length > 0 ? [node('text', 'Commande CMD-1042 confirmée')] : [];
      return { location: 'http://app.test/', root: node('group', 'page', [node('button', 'Valider'), ...shown]) };
    };
    const result = await generateResolution({
      scenario: withCheck,
      driver: new StagedDriver(staged),
      provider,
      attemptsPerStep: 2,
    });
    const stored = result.resolution.steps['s1'];
    assert.equal(stored?.captures?.['reference']?.after, 'Commande ');
    assert.deepEqual(stored?.assertions?.['le bouton reste là'], kept);
  });

  it('garde la capture entière si sa forme bornée casse une vérification', async () => {
    const scenarioWithValue = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    expect: la confirmation affiche {{reference}}
    capture:
      reference: le numéro de commande
`);
    const key = 'la confirmation affiche {{reference}}';
    const check = { check: 'textEquals', target: { role: 'text' }, value: 'Commande CMD-1042 confirmée' };
    const provider = new ScriptedProvider([
      { actions: gesture, captures: { reference: whole }, assertions: { [key]: { ...check, value: '{{reference}}' } } },
      { captures: { reference: { ...whole, after: 'Commande ', before: ' confirmée' } } },
    ]);
    const result = await generateResolution({
      scenario: scenarioWithValue,
      driver: new StagedDriver(sentence),
      provider,
      attemptsPerStep: 2,
    });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.equal(result.resolution.steps['s1']?.captures?.['reference']?.after, undefined);
  });

  it('interroge aussi une écriture sans espaces', () => {
    const spec = { from: { role: 'text' as const }, extract: 'text' as const };
    assert.equal(readsWholeText(spec, 'ご注文CMD-1042は確定しました', ''), true);
    assert.equal(readsWholeText(spec, 'CMD-1042-ABC', ''), false);
  });

  it('interroge un nombre lu dans un texte qui en porte plusieurs', () => {
    const spec = { from: { role: 'text' as const }, extract: 'number' as const };
    assert.equal(readsWholeText(spec, '129003', 'Montant 129,00 € pour 3 articles'), true);
    assert.equal(readsWholeText(spec, '129', 'Montant 129,00 €'), false);
  });

  it("n'interroge ni un mot isolé, ni un nombre, ni une capture bornée", async () => {
    const short = (): Screen => ({
      location: 'http://app.test/',
      root: node('group', 'page', [node('button', 'Valider'), node('text', 'CMD-1042')]),
    });
    const provider = new ScriptedProvider([{ actions: gesture, captures: { reference: whole }, assertions: {} }]);
    await generateResolution({ scenario, driver: new StagedDriver(short), provider });
    assert.equal(provider.requests.length, 1);
    assert.equal(readsWholeText({ from: { role: 'text' }, extract: 'number' }, '129', '129,00 €'), false);
    assert.equal(readsWholeText({ from: { role: 'text' }, extract: 'text', after: 'a' }, 'CMD-1042', 'a CMD-1042'), false);
  });
});

describe('la capture figée dans le from d\'une capture', () => {
  it('est réécrite, et la capture suit la commande du jour', async () => {
    const rows = (reference: string): UINode =>
      node('list', 'Commandes', [node('listitem', reference, [node('text', '129')])]);
    const screen = (): Screen => ({
      location: 'http://app.test/',
      root: node('group', 'page', [node('button', 'Valider'), node('heading', 'CMD-1042'), rows('CMD-1042')]),
    });
    const scenario = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    capture:
      reference: le numéro
  - id: s2
    capture:
      montant: le montant de la commande {{reference}}
`);
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        captures: { reference: { from: { role: 'heading' }, extract: 'text' } },
      },
      {
        captures: {
          montant: {
            from: { role: 'text', within: { role: 'listitem', name: { contains: 'CMD-1042' } } },
            extract: 'number',
          },
        },
      },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.deepEqual(result.resolution.steps['s2']?.captures?.['montant']?.from, {
      role: 'text',
      within: { role: 'listitem', name: { contains: '{{reference}}' } },
    });
  });
});

describe('une capture figée dans le nom de la cible', () => {
  const known = { reference: 'CMD-1042' };
  const key = 'la liste contient {{reference}}';
  const within = { role: 'list', name: 'Mes commandes' };

  it('est réécrite, dans un nom exact comme dans un fragment', () => {
    const partial = frozenCapture(
      key,
      { check: 'visible', target: { role: 'listitem', name: { contains: 'CMD-1042' }, within } },
      known,
    );
    assert.deepEqual(partial?.check, {
      check: 'visible',
      target: { role: 'listitem', name: { contains: '{{reference}}' }, within },
    });
    const exact = frozenCapture(key, { check: 'visible', target: { role: 'listitem', name: 'CMD-1042 — en cours' } }, known);
    assert.deepEqual(exact?.check, { check: 'visible', target: { role: 'listitem', name: '{{reference}} — en cours' } });
    assert.match(exact?.note ?? '', /rewritten to \{\{reference\}\}/);
  });

  it('est réécrite dans le conteneur aussi', () => {
    const outcome = frozenCapture(
      key,
      { check: 'visible', target: { role: 'text', within: { role: 'group', name: 'Commande CMD-1042' } } },
      known,
    );
    assert.deepEqual(outcome?.check, {
      check: 'visible',
      target: { role: 'text', within: { role: 'group', name: 'Commande {{reference}}' } },
    });
  });

  it('ne touche pas une cible qui emploie déjà la capture, ni une valeur trop courte', () => {
    assert.equal(
      frozenCapture(key, { check: 'visible', target: { role: 'listitem', name: { contains: '{{reference}}' } } }, known),
      null,
    );
  });

  it('signale sans réécrire une valeur trop courte ou numérique', () => {
    const short = frozenCapture(key, { check: 'visible', target: { role: 'text', name: 'Lot 12' } }, { reference: '12' });
    assert.equal(short?.check, undefined);
    assert.match(short?.warning ?? '', /kept as is/);
    const amount = frozenCapture(key, { check: 'visible', target: { role: 'text', name: '129,00 €' } }, { reference: '129' });
    assert.equal(amount?.check, undefined);
    assert.match(amount?.warning ?? '', /kept as is/);
  });

  it('réécrit toutes les captures nommées, pas seulement la première', () => {
    const outcome = frozenCapture(
      '{{a}} et {{b}}',
      { check: 'visible', target: { role: 'listitem', name: 'REF-1 et LOT-2' } },
      { a: 'REF-1', b: 'LOT-2' },
    );
    assert.deepEqual(outcome?.check, { check: 'visible', target: { role: 'listitem', name: '{{a}} et {{b}}' } });
  });

  it('ne réécrit pas à l\'intérieur d\'un gabarit', () => {
    const outcome = frozenCapture(
      '{{ref}} {{commande}}',
      { check: 'visible', target: { role: 'listitem', name: '{{commande}} ABC-1' } },
      { ref: 'commande', commande: 'ABC-1' },
    );
    assert.equal(JSON.stringify(outcome?.check ?? {}).includes('{{{{'), false);
  });

  it('ne rattache pas une capture à un groupe de chiffres', () => {
    assert.equal(
      frozenCapture('{{lot}}', { check: 'visible', target: { role: 'text', name: 'Total 1 234,50' } }, { lot: '234' }),
      null,
    );
  });

  it('demande quand deux captures ont la même valeur', () => {
    const outcome = frozenCapture(
      'total {{total}} et prix {{prix}}',
      { check: 'textEquals', target: { role: 'text' }, value: 'EUR-129' },
      { total: 'EUR-129', prix: 'EUR-129' },
    );
    assert.equal(outcome?.check, undefined);
    assert.match(outcome?.question ?? '', /another capture holds the same value/);
  });

  it("mesure la valeur comparée d'un numberEquals, pas le texte capturé", () => {
    const outcome = frozenCapture(
      'le panier affiche {{quantite}}',
      { check: 'numberEquals', target: { role: 'text' }, value: '1' },
      { quantite: '1 article' },
    );
    assert.equal(outcome?.check, undefined);
    assert.match(outcome?.question ?? '', /can match by chance/);
  });

  it('voit la cible même quand la valeur appelle une question ou un refus', () => {
    const outcome = frozenCapture(
      key,
      { check: 'textContains', target: { role: 'text', name: { contains: 'ABC-99' } }, value: 'Total ABC-99' },
      { reference: 'ABC-99' },
    );
    assert.ok(outcome?.error !== undefined);
    assert.ok(outcome?.note !== undefined);
  });

  it('signale un nom qui n\'est qu\'une partie de la capture', () => {
    const outcome = frozenCapture(
      key,
      { check: 'visible', target: { role: 'listitem', name: { contains: 'CMD-1042' } } },
      { reference: 'Votre commande CMD-1042 est confirmée' },
    );
    assert.equal(outcome?.check, undefined);
    assert.match(outcome?.warning ?? '', /only part of today's value/);
  });

  it('est réécrite même quand la valeur emploie déjà la capture', () => {
    const outcome = frozenCapture(
      key,
      { check: 'textContains', target: { role: 'listitem', name: { contains: 'CMD-1042' } }, value: '{{reference}}' },
      known,
    );
    assert.deepEqual(outcome?.check, {
      check: 'textContains',
      target: { role: 'listitem', name: { contains: '{{reference}}' } },
      value: '{{reference}}',
    });
  });

  it('réécrit la valeur et la cible dans la même passe', () => {
    const outcome = frozenCapture(
      key,
      { check: 'textContains', target: { role: 'listitem', name: { contains: 'CMD-1042' } }, value: 'CMD-1042' },
      known,
    );
    assert.deepEqual(outcome?.check, {
      check: 'textContains',
      target: { role: 'listitem', name: { contains: '{{reference}}' } },
      value: '{{reference}}',
    });
  });

  it('sépare les mots dans une écriture sans espaces', () => {
    const outcome = frozenCapture(
      key,
      { check: 'visible', target: { role: 'listitem', name: { contains: 'ご注文CMD-1042は確定' } } },
      known,
    );
    assert.deepEqual(outcome?.check, {
      check: 'visible',
      target: { role: 'listitem', name: { contains: 'ご注文{{reference}}は確定' } },
    });
  });

  it('ne prend pas une référence suivie d\'un nombre pour un groupe de chiffres', () => {
    const outcome = frozenCapture(
      key,
      { check: 'visible', target: { role: 'listitem', name: { contains: 'CMD-1042 1 exemplaire' } } },
      known,
    );
    assert.deepEqual(outcome?.check, {
      check: 'visible',
      target: { role: 'listitem', name: { contains: '{{reference}} 1 exemplaire' } },
    });
  });

  it('accepte un libellé stable tiré de la capture', () => {
    assert.equal(
      frozenCapture(
        '{{echeance}}',
        { check: 'textEquals', target: { role: 'text', name: { contains: 'À rendre' } }, value: '{{echeance}}' },
        { echeance: 'À rendre avant le 12/11/2026' },
      ),
      null,
    );
  });

  it('ne compare pas un libellé au nombre logé dans une phrase capturée', () => {
    assert.equal(
      frozenCapture(
        '{{livraison}}',
        { check: 'visible', target: { role: 'heading', name: 'Étape 3' } },
        { livraison: 'Livraison en 3 jours' },
      ),
      null,
    );
  });

  it('demande plutôt que de choisir entre deux captures égales', () => {
    const outcome = frozenCapture(
      '{{nouvelle}} remplace {{ancienne}}',
      { check: 'visible', target: { role: 'text', name: 'Ancienne CMD-1042' } },
      { nouvelle: 'CMD-1042', ancienne: 'CMD-1042' },
    );
    assert.equal(outcome?.check, undefined);
    assert.ok(outcome?.warning !== undefined);
  });

  it("voit un littéral malgré un gabarit dans le conteneur", () => {
    const outcome = frozenCapture(
      key,
      { check: 'visible', target: { role: 'text', name: { contains: 'CMD-1042' }, within: { role: 'group', name: { contains: '{{reference}}' } } } },
      known,
    );
    assert.deepEqual(outcome?.check, {
      check: 'visible',
      target: { role: 'text', name: { contains: '{{reference}}' }, within: { role: 'group', name: { contains: '{{reference}}' } } },
    });
  });

  it('ne coupe pas un mot dans une écriture sans espaces', () => {
    assert.equal(
      frozenCapture(
        key,
        { check: 'visible', target: { role: 'heading', name: 'チェアマンの挨拶' } },
        { reference: 'チェア' },
      ),
      null,
    );
  });

  it('sépare une valeur de sa particule coréenne', () => {
    const outcome = frozenCapture(
      key,
      { check: 'visible', target: { role: 'text', name: { contains: '주문 ABC-XY가 확인' } } },
      { reference: 'ABC-XY' },
    );
    assert.ok(outcome?.check !== undefined);
  });

  it('reste une réécriture vérifiée au rejeu sur une autre valeur', async () => {
    const list = (reference: string): UINode =>
      node('list', 'Mes commandes', [node('listitem', 'CMD-1000 — livrée'), node('listitem', `${reference} — en cours`)]);
    const outcome = frozenCapture(key, { check: 'visible', target: { role: 'listitem', name: { contains: 'CMD-1042' } } }, known);
    const check = outcome?.check as unknown as Check;
    const verdict = evaluateCheck(check, { root: list('CMD-7') , location: '/', bag: { reference: 'CMD-7' } });
    assert.equal(verdict.ok, true);
  });
});

describe('une capture lue dans un nom qui la porte', () => {
  it('voit un nombre à côté d\'un autre, et un tiret de référence', () => {
    const name = 'Montant 129,00 € pour 3 articles';
    const text = node('text', name);
    assert.equal(tautologicalCapture({ role: 'text', name }, 'number', text, '129'), true);
    const reference = node('text', 'CMD-1042');
    assert.equal(tautologicalCapture({ role: 'text', name: { contains: 'CMD-1042' } }, 'number', reference, '1042'), true);
  });
});

describe('une capture lue plus tard dans la même étape', () => {
  it("n'est pas réécrite dans le from d'une capture qui la précède", async () => {
    const scenario = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    capture:
      montant: le montant de la commande {{reference}}
      reference: le numero
`);
    const screen = (): Screen => ({
      location: 'http://app.test/',
      root: node('group', 'page', [
        node('button', 'Valider'),
        node('heading', 'CMD-1042'),
        node('list', 'Commandes', [node('listitem', 'CMD-1042', [node('text', '129')])]),
      ]),
    });
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }],
        captures: {
          montant: { from: { role: 'text', within: { role: 'listitem', name: { contains: 'CMD-1042' } } }, extract: 'number' },
          reference: { from: { role: 'heading' }, extract: 'text' },
        },
      },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
  });
});

describe('une vérification sur le nœud de la capture', () => {
  const key = 'la confirmation affiche {{reference}}';
  const scenario = parseScenario(`id: c
title: t
steps:
  - id: s1
    do: valider
    expect: ${key}
    capture:
      reference: le numéro
`);
  const screen = (acted: readonly Action[]): Screen => ({
    location: 'http://app.test/',
    root: node('group', 'page', [node('button', 'Valider'), ...(acted.length > 0 ? [node('text', 'CMD-1042')] : [])]),
  });
  const gesture = [{ kind: 'click', target: { primary: { role: 'button', name: 'Valider' } } }];

  it('est signalée quand la réécriture retrouve le nœud par sa propre valeur', async () => {
    const provider = new ScriptedProvider([
      {
        actions: gesture,
        captures: { reference: { from: { role: 'text', nth: 0 }, extract: 'text' } },
        assertions: { [key]: { check: 'visible', target: { role: 'text', name: { contains: 'CMD-1042' } } } },
      },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('cannot fail')), JSON.stringify(result.steps));
  });

  it('est signalée, quel que soit l\'ordre des clés', async () => {
    const provider = new ScriptedProvider([
      {
        actions: gesture,
        captures: { reference: { from: { role: 'text', nth: 0 }, extract: 'text' } },
        assertions: { [key]: { check: 'textEquals', target: { nth: 0, role: 'text' }, value: 'CMD-1042' } },
      },
    ]);
    const result = await generateResolution({ scenario, driver: new StagedDriver(screen), provider });
    assert.ok(result.steps[0]?.warnings.some((w) => w.includes('cannot fail')), JSON.stringify(result.steps));
  });
});
