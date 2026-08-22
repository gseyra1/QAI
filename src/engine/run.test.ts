import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Action,
  Capabilities,
  Driver,
  Platform,
  ResolvedTarget,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { node } from './fixtures.ts';
import type { HealRequest, HealResult, Healer } from './run.ts';
import { runScenario } from './run.ts';

const BUTTON = node('button', 'Ajouter au panier');
const COUNT = node('text', '1');
const PRICE = node('text', '129,00 €');
const TREE = node('group', 'page', [BUTTON, COUNT, PRICE]);

const FOUND: ResolveOutcome = { found: true, node: BUTTON, usedFallback: false };
const MISSING: ResolveOutcome = { found: false, reason: 'no-match', matches: 0 };
const AMBIGUOUS: ResolveOutcome = { found: false, reason: 'ambiguous', matches: 2 };

type Resolver = (target: ResolvedTarget, call: number) => ResolveOutcome;

class FakeDriver implements Driver {
  readonly platform: Platform = 'web';
  readonly capabilities: Capabilities = {
    hover: true,
    swipe: false,
    navigateByUrl: true,
    deepLink: true,
  };

  readonly acted: Action[] = [];
  settleCount = 0;
  resolveCalls = 0;

  readonly #root: UINode;
  readonly #resolver: Resolver;

  constructor(root: UINode, resolver: Resolver = () => FOUND) {
    this.#root = root;
    this.#resolver = resolver;
  }

  async launch(): Promise<void> {}

  async applyState(): Promise<void> {}

  async observe(): Promise<UISnapshot> {
    return {
      platform: 'web',
      at: new Date().toISOString(),
      location: 'http://test/',
      viewport: { x: 0, y: 0, width: 1280, height: 800 },
      root: this.#root,
    };
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    this.resolveCalls += 1;
    return this.#resolver(target, this.resolveCalls);
  }

  async act(action: Action): Promise<void> {
    this.acted.push(action);
  }

  async settle(): Promise<void> {
    this.settleCount += 1;
  }

  async dispose(): Promise<void> {}
}

/**
 * Pilote dont l'arbre change apres un nombre donne d'observations.
 *
 * Reproduit ce qu'aucun arbre fige ne peut montrer : un ecran dont le rendu se
 * termine APRES le repos reseau — module charge a la demande, animation
 * d'entree, scene 3D.
 */
class TardyDriver extends FakeDriver {
  observeCalls = 0;

  readonly #late: UINode;
  readonly #after: number;

  constructor(early: UINode, late: UINode, after: number) {
    super(early);
    this.#late = late;
    this.#after = after;
  }

  override async observe(): Promise<UISnapshot> {
    this.observeCalls += 1;
    const snapshot = await super.observe();
    return this.observeCalls > this.#after ? { ...snapshot, root: this.#late } : snapshot;
  }
}

class SpyHealer implements Healer {
  readonly calls: HealRequest[] = [];
  readonly #result: HealResult;

  constructor(result: HealResult) {
    this.#result = result;
  }

  async heal(request: HealRequest): Promise<HealResult> {
    this.calls.push(request);
    return this.#result;
  }
}

const CLICK: ResolvedTarget = { primary: { role: 'button', name: 'Ajouter au panier' } };

function scenario(steps: Scenario['steps']): Scenario {
  return { id: 'test', title: 'Scénario de test', steps };
}

function resolution(steps: Resolution['steps']): Resolution {
  return { scenario: 'test', platform: 'web', recordedAt: '2026-07-28T00:00:00Z', steps };
}

describe('runScenario', () => {
  it('déroule un parcours nominal', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'ajouter au panier', expect: 'le panier affiche 1' }]),
      resolution: resolution({
        s1: {
          actions: [{ kind: 'click', target: CLICK }],
          assertions: {
            'le panier affiche 1': { check: 'textEquals', target: { role: 'text', name: '1' }, value: '1' },
          },
        },
      }),
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.steps[0]?.status, 'passed');
    assert.equal(driver.acted.length, 1);
  });

  it('n\'appelle JAMAIS le réparateur quand une assertion échoue', async () => {
    const driver = new FakeDriver(TREE);
    const healer = new SpyHealer({ healed: true, target: CLICK, note: 'ne doit pas arriver' });

    const report = await runScenario({
      driver,
      healer,
      scenario: scenario([{ id: 's1', do: 'ajouter au panier', expect: 'le panier affiche 3' }]),
      resolution: resolution({
        s1: {
          actions: [{ kind: 'click', target: CLICK }],
          assertions: {
            'le panier affiche 3': { check: 'textEquals', target: { role: 'text', name: '1' }, value: '3' },
          },
        },
      }),
    });

    assert.equal(healer.calls.length, 0, 'une assertion fausse est une régression, pas un test périmé');
    assert.equal(report.status, 'failed');
    assert.equal(report.healCount, 0);
    assert.match(report.steps[0]?.failures[0]?.reason ?? '', /attendu « 3 », observé « 1 »/);
  });

  it('réessaie après repos avant d\'engager une réparation', async () => {
    const driver = new FakeDriver(TREE, (_target, call) => (call === 1 ? MISSING : FOUND));
    const healer = new SpyHealer({ healed: false, reason: 'ne doit pas arriver' });

    const report = await runScenario({
      driver,
      healer,
      scenario: scenario([{ id: 's1', do: 'ajouter au panier' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'click', target: CLICK }] } }),
    });

    assert.equal(driver.resolveCalls, 2);
    assert.equal(healer.calls.length, 0, 'le réessai doit absorber l\'instabilité de rendu');
    assert.equal(report.status, 'passed');
  });

  it('répare une cible durablement introuvable et marque le parcours', async () => {
    const healedTarget: ResolvedTarget = { primary: { role: 'button', name: 'Ajouter' } };
    const driver = new FakeDriver(TREE, () => MISSING);
    const healer = new SpyHealer({ healed: true, target: healedTarget, note: 'libellé raccourci' });

    const report = await runScenario({
      driver,
      healer,
      scenario: scenario([{ id: 's1', do: 'ajouter au panier' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'click', target: CLICK }] } }),
    });

    assert.equal(healer.calls.length, 1);
    assert.equal(report.status, 'healed');
    assert.equal(report.healCount, 1);
    assert.equal(report.steps[0]?.healNotes?.[0], 'libellé raccourci');
    assert.deepEqual((driver.acted[0] as { target: ResolvedTarget }).target, healedTarget);
  });

  it('ne réessaie pas une cible ambiguë et refuse de choisir', async () => {
    const driver = new FakeDriver(TREE, () => AMBIGUOUS);
    const healer = new SpyHealer({ healed: false, reason: 'x' });

    const report = await runScenario({
      driver,
      healer,
      scenario: scenario([{ id: 's1', do: 'valider' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'click', target: CLICK }] } }),
    });

    assert.equal(driver.resolveCalls, 1, 'une ambiguïté ne se stabilise pas avec le temps');
    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /ambiguë : 2 éléments/);
  });

  it('s\'arrête quand le budget de réparation est épuisé', async () => {
    const driver = new FakeDriver(TREE, () => MISSING);
    const healer = new SpyHealer({ healed: true, target: CLICK, note: 'réparé' });

    const report = await runScenario({
      driver,
      healer,
      healBudget: 1,
      scenario: scenario([
        { id: 's1', do: 'première' },
        { id: 's2', do: 'deuxième' },
      ]),
      resolution: resolution({
        s1: { actions: [{ kind: 'click', target: CLICK }] },
        s2: { actions: [{ kind: 'click', target: CLICK }] },
      }),
    });

    assert.equal(healer.calls.length, 1);
    assert.equal(report.steps[0]?.status, 'healed');
    assert.equal(report.steps[1]?.status, 'failed');
    assert.match(report.steps[1]?.error ?? '', /budget de réparation épuisé/);
  });

  it('marque ignorées les étapes qui suivent un échec', async () => {
    const driver = new FakeDriver(TREE, () => MISSING);
    const report = await runScenario({
      driver,
      scenario: scenario([
        { id: 's1', do: 'première' },
        { id: 's2', do: 'deuxième' },
        { id: 's3', do: 'troisième' },
      ]),
      resolution: resolution({
        s1: { actions: [{ kind: 'click', target: CLICK }] },
        s2: { actions: [{ kind: 'click', target: CLICK }] },
        s3: { actions: [{ kind: 'click', target: CLICK }] },
      }),
    });

    assert.deepEqual(report.steps.map((step) => step.status), ['failed', 'skipped', 'skipped']);
  });

  it('propage une capture dans les assertions suivantes', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([
        { id: 's1', do: 'ouvrir la fiche', capture: { prix: 'le prix affiché' } },
        { id: 's2', do: 'ouvrir le panier', expect: 'le total est égal au prix' },
      ]),
      resolution: resolution({
        s1: {
          actions: [{ kind: 'click', target: CLICK }],
          captures: { prix: { from: { role: 'text', name: '129,00 €' }, extract: 'number' } },
        },
        s2: {
          actions: [{ kind: 'click', target: CLICK }],
          assertions: {
            'le total est égal au prix': {
              check: 'numberEquals',
              target: { role: 'text', name: '129,00 €' },
              value: '{{prix}}',
            },
          },
        },
      }),
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.captures['prix'], '129');
  });

  it('ne résout rien pour une action sans cible', async () => {
    const driver = new FakeDriver(TREE);
    await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'ouvrir la page' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'navigate', to: '/' }] } }),
    });
    assert.equal(driver.resolveCalls, 0);
  });

  it('refuse une action que la plateforme ne supporte pas', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'faire défiler' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'swipe', direction: 'up' }] } }),
    });
    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /non supportée sur web/);
  });

  it('ignore une étape restreinte à une autre plateforme', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'survoler', only: ['mobile'] }]),
      resolution: resolution({ s1: { actions: [{ kind: 'click', target: CLICK }] } }),
    });
    assert.equal(report.steps[0]?.status, 'skipped');
    assert.equal(report.status, 'passed');
  });

  it('signale une étape sans résolution en cache', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'agir' }]),
      resolution: resolution({}),
    });
    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /aucune résolution en cache/);
  });
  it('reevalue une assertion encore fausse pendant la fenetre accordee', async () => {
    const vide = node('group', 'page', [node('text', 'Chargement…')]);
    const rempli = node('group', 'page', [node('text', '1')]);
    // L'arbre ne se remplit qu'a la 3e observation : sans fenetre, le verdict
    // serait prononce sur la premiere et le parcours tomberait au rouge.
    const driver = new TardyDriver(vide, rempli, 2);

    const report = await runScenario({
      driver,
      assertTimeoutMs: 5000,
      scenario: scenario([{ id: 's1', do: 'lire le panier', expect: 'le panier affiche 1' }]),
      resolution: resolution({
        s1: {
          actions: [],
          assertions: {
            'le panier affiche 1': { check: 'textEquals', target: { role: 'text', name: '1' }, value: '1' },
          },
        },
      }),
    });

    assert.equal(report.status, 'passed');
    assert.ok(driver.observeCalls > 1, 'l’arbre doit avoir ete observe plusieurs fois');
  });

  it('conclut a l’echec quand la fenetre expire sans que l’assertion devienne vraie', async () => {
    const vide = node('group', 'page', [node('text', 'Chargement…')]);
    // L'arbre ne se remplit jamais : la fenetre accorde du temps, elle ne doit
    // en aucun cas finir par masquer un echec reel.
    const driver = new TardyDriver(vide, vide, 0);

    const report = await runScenario({
      driver,
      assertTimeoutMs: 400,
      scenario: scenario([{ id: 's1', do: 'lire le panier', expect: 'le panier affiche 1' }]),
      resolution: resolution({
        s1: {
          actions: [],
          assertions: {
            'le panier affiche 1': { check: 'textEquals', target: { role: 'text', name: '1' }, value: '1' },
          },
        },
      }),
    });

    assert.equal(report.status, 'failed');
    assert.equal(report.steps[0]?.failures.length, 1);
  });
});
