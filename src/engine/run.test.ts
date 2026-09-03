import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  Action,
  Capabilities,
  Driver,
  Observations,
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
    dialogs: true,
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
    assert.match(report.steps[0]?.failures[0]?.reason ?? '', /expected "3", observed "1"/);
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
    assert.match(report.steps[0]?.error ?? '', /ambiguous target: 2 elements/);
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
    assert.match(report.steps[1]?.error ?? '', /heal budget exhausted/);
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
    assert.match(report.steps[0]?.error ?? '', /not supported on web/);
  });

  it('accepte un pilote écrit avant `expectDialog`, et lui refuse le dialogue', async () => {
    // `Capabilities` est exporté depuis l'index : quelqu'un a pu écrire son
    // propre pilote contre la version publiée. Un champ requis ajouté après
    // coup l'empêcherait de compiler — ce n'est alors plus un ajout mais une
    // rupture. Cette déclaration à quatre champs est la preuve, à la
    // compilation, que le contrat reste tenable sans `dialogs`.
    const ANCIEN: Capabilities = {
      hover: true,
      swipe: false,
      navigateByUrl: true,
      deepLink: true,
    };

    class PiloteAncien extends FakeDriver {
      override readonly capabilities = ANCIEN;
    }

    const driver = new PiloteAncien(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'vider le panier en confirmant' }]),
      resolution: resolution({
        s1: {
          actions: [
            { kind: 'expectDialog', response: 'accept' },
            { kind: 'click', target: CLICK },
          ],
        },
      }),
    });

    // Refuser est le comportement voulu, pas un défaut de tolérance : laisser
    // passer produirait un « supprimer puis confirmer » vert où la suppression
    // n'a pas eu lieu, ce que `expectDialog` existe précisément pour empêcher.
    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /"expectDialog" not supported on web/);
    assert.deepEqual(driver.acted, []);
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
    assert.match(report.steps[0]?.error ?? '', /no cached resolution/);
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

  /**
   * Sans réparateur, « cible introuvable » laissait le lecteur ouvrir un
   * navigateur pour chercher lui-même ce qui avait bougé. La suggestion est
   * calculée sans appel de modèle : elle vaut donc aussi sans --provider.
   */
  it('propose les libellés proches quand la cible a disparu', async () => {
    const page = node('group', 'page', [node('button', 'Ajouter au panier ⚡')]);
    const report = await runScenario({
      driver: new FakeDriver(page, () => MISSING),
      scenario: scenario([{ id: 's1', do: 'ajouter au panier' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'click', target: CLICK }] } }),
    });

    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /target not found — closest: button "Ajouter au panier ⚡"/);
  });

  it('ne suggère rien sur une cible ambiguë : le nom correspond déjà', async () => {
    const report = await runScenario({
      driver: new FakeDriver(TREE, () => AMBIGUOUS),
      scenario: scenario([{ id: 's1', do: 'ajouter au panier' }]),
      resolution: resolution({ s1: { actions: [{ kind: 'click', target: CLICK }] } }),
    });

    assert.equal(report.status, 'failed');
    assert.doesNotMatch(report.steps[0]?.error ?? '', /closest/);
  });

  /**
   * Sans interpolation au rejeu, la résolution devrait contenir le mot de
   * passe en clair pour qu'un parcours de connexion fonctionne — c'est-à-dire
   * qu'aucune application authentifiée ne serait testable sans verser un
   * secret dans git.
   */
  it('résout la valeur d\'une saisie au moment d\'agir, jamais dans le fichier', async () => {
    process.env['QAI_TEST_PASS'] = 'hunter2';
    try {
      const driver = new FakeDriver(TREE);
      const report = await runScenario({
        driver,
        scenario: scenario([{ id: 's1', do: 'se connecter' }]),
        resolution: resolution({
          s1: {
            actions: [
              { kind: 'fill', target: CLICK, value: '{{env.QAI_TEST_PASS}}' },
              { kind: 'select', target: CLICK, option: '{{env.QAI_TEST_PASS}}' },
            ],
          },
        }),
      });

      assert.equal(report.status, 'passed');
      const [rempli, choisi] = driver.acted;
      assert.equal(rempli?.kind === 'fill' ? rempli.value : null, 'hunter2');
      assert.equal(choisi?.kind === 'select' ? choisi.option : null, 'hunter2');
    } finally {
      delete process.env['QAI_TEST_PASS'];
    }
  });

  it('saisit ce qu\'une étape précédente a capturé', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([
        { id: 's1', do: 'lire le prix', capture: { prix: 'le prix affiché' } },
        { id: 's2', do: 'recopier le prix' },
      ]),
      resolution: resolution({
        s1: { actions: [], captures: { prix: { from: { role: 'text', name: '129,00 €' }, extract: 'text' } } },
        s2: { actions: [{ kind: 'fill', target: CLICK, value: '{{prix}}' }] },
      }),
    });

    assert.equal(report.status, 'passed');
    const rempli = driver.acted.at(-1);
    assert.equal(rempli?.kind === 'fill' ? rempli.value : null, '129,00 €');
  });

  /**
   * Une variable absente doit arrêter l'étape en la nommant : un champ mot de
   * passe rempli avec du vide échouerait plus loin, sur un message muet.
   */
  it('échoue en nommant la variable d\'environnement manquante', async () => {
    delete process.env['QAI_TEST_ABSENT'];
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      scenario: scenario([{ id: 's1', do: 'se connecter' }]),
      resolution: resolution({
        s1: { actions: [{ kind: 'fill', target: CLICK, value: '{{env.QAI_TEST_ABSENT}}' }] },
      }),
    });

    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /QAI_TEST_ABSENT/);
    assert.equal(driver.acted.length, 0, 'rien ne doit être saisi');
  });

  /**
   * Le fichier de résolution est versionné : y écrire un chemin absolu
   * produirait un cache qui ne rejoue que sur la machine qui l'a écrit. Le
   * chemin reste donc relatif au scénario, et c'est le moteur qui l'absolutise
   * juste avant d'agir.
   */
  // Le cadrage résout les liens symboliques : un vrai fichier est nécessaire.
  let fixtures: string;
  before(() => {
    fixtures = mkdtempSync(join(tmpdir(), 'qai-run-upload-'));
    writeFileSync(join(fixtures, 'releve.csv'), 'a,b\n1,2\n');
  });
  after(() => rmSync(fixtures, { recursive: true, force: true }));

  it('résout les chemins d\'un téléversement depuis le dossier du scénario', async () => {
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      baseDir: fixtures,
      scenario: scenario([{ id: 's1', do: 'importer le relevé' }]),
      resolution: resolution({
        s1: { actions: [{ kind: 'upload', target: CLICK, files: ['releve.csv'] }] },
      }),
    });

    assert.equal(report.status, 'passed');
    const depose = driver.acted[0];
    assert.deepEqual(
      depose?.kind === 'upload' ? depose.files : null,
      [resolve(fixtures, 'releve.csv')],
    );
  });

  it('arrête l\'étape plutôt que de téléverser un fichier hors du scénario', async () => {
    // Les actions ne sont pas toutes écrites à la main : elles sortent d'un
    // modèle qui lit l'écran, et un écran est une entrée non fiable. Un chemin
    // qui sort du dossier doit donc échouer en le disant, et surtout ne rien
    // envoyer — le fichier partirait vers l'application testée.
    const driver = new FakeDriver(TREE);
    const report = await runScenario({
      driver,
      baseDir: fixtures,
      scenario: scenario([{ id: 's1', do: 'importer le relevé' }]),
      resolution: resolution({
        s1: {
          actions: [
            { kind: 'upload', target: CLICK, files: ['../../../.ssh/id_rsa'] },
          ],
        },
      }),
    });

    assert.equal(report.status, 'failed');
    assert.match(report.steps[0]?.error ?? '', /outside the scenario directory/);
    assert.deepEqual(driver.acted, [], 'rien ne doit partir vers l\'application');
  });

  /**
   * Une assertion prouve ce que l'écran affiche ; ces vérifications disent ce
   * que l'application a fait pour l'afficher. Un écran vide parce qu'un appel
   * a rendu 500 et un écran vide parce qu'il n'y a rien à montrer se
   * ressemblent exactement.
   */
  describe('observations réseau et console', () => {
    class ObservingDriver extends FakeDriver {
      observations: Observations;

      constructor(root: UINode, observations: Observations) {
        super(root);
        this.observations = observations;
      }

      drainObservations(): Observations {
        const drained = this.observations;
        this.observations = { network: [], console: [] };
        return drained;
      }
    }

    const CASSE: Observations = {
      network: [
        { method: 'GET', url: '/api/eleves', status: 500, durationMs: 12, at: '2026-08-01T10:00:00Z' },
        { method: 'GET', url: '/api/ok', status: 200, durationMs: 4, at: '2026-08-01T10:00:00Z' },
      ],
      console: [{ level: 'error', text: 'TypeError: x is not a function', at: '2026-08-01T10:00:00Z' }],
    };

    const parcours = (
      driver: Driver,
      assertions: Resolution['steps'][string]['assertions'],
      watchdogs?: Parameters<typeof runScenario>[0]['watchdogs'],
    ) =>
      runScenario({
        driver,
        ...(watchdogs !== undefined ? { watchdogs } : {}),
        assertTimeoutMs: 200,
        scenario: scenario([
          { id: 's1', do: 'ouvrir la liste', ...(assertions ? { expect: Object.keys(assertions) } : {}) },
        ]),
        resolution: resolution({ s1: { actions: [], ...(assertions ? { assertions } : {}) } }),
      });

    it('fait échouer l\'étape sur une requête en échec, en la nommant', async () => {
      const report = await parcours(new ObservingDriver(TREE, CASSE), {
        'aucun appel ne casse': { check: 'noFailedRequests' },
      });

      assert.equal(report.status, 'failed');
      assert.match(report.steps[0]?.failures[0]?.reason ?? '', /GET \/api\/eleves → 500/);
    });

    it('tolère ce que « allow » autorise', async () => {
      const report = await parcours(new ObservingDriver(TREE, CASSE), {
        'aucun appel ne casse': { check: 'noFailedRequests', allow: ['/api/eleves'] },
      });

      assert.equal(report.status, 'passed');
    });

    it('relève une erreur console', async () => {
      const report = await parcours(new ObservingDriver(TREE, CASSE), {
        'la console reste propre': { check: 'noConsoleErrors' },
      });

      assert.equal(report.status, 'failed');
      assert.match(report.steps[0]?.failures[0]?.reason ?? '', /TypeError/);
    });

    /**
     * Une erreur console ne devient pas fausse en attendant. La laisser dans
     * la fenêtre de réévaluation ferait patienter chaque étape bruyante
     * pendant tout le délai d'assertion.
     */
    it('n\'attend pas la fenêtre de réévaluation pour conclure', async () => {
      const driver = new ObservingDriver(TREE, CASSE);
      const debut = Date.now();
      await parcours(driver, { 'la console reste propre': { check: 'noConsoleErrors' } });

      assert.ok(Date.now() - debut < 200, 'la fenêtre de 200 ms ne doit pas être consommée');
    });

    it('reste silencieux par défaut, avertit en warn, échoue en fail', async () => {
      const muet = await parcours(new ObservingDriver(TREE, CASSE), undefined);
      assert.equal(muet.status, 'passed', 'les garde-fous sont off par défaut');
      assert.equal(muet.steps[0]?.warnings, undefined);

      const avertit = await parcours(new ObservingDriver(TREE, CASSE), undefined, {
        consoleErrors: 'warn',
        requestFailures: 'warn',
      });
      assert.equal(avertit.status, 'passed');
      assert.equal(avertit.steps[0]?.warnings?.length, 2);

      const echoue = await parcours(new ObservingDriver(TREE, CASSE), undefined, {
        requestFailures: 'fail',
      });
      assert.equal(echoue.status, 'failed');
      assert.match(echoue.steps[0]?.error ?? '', /failed request\(s\)/);
    });

    it('n\'attache le diagnostic qu\'aux étapes qui ont cassé', async () => {
      const propre = await parcours(new ObservingDriver(TREE, { network: [], console: [] }), undefined);
      assert.equal(propre.steps[0]?.network, undefined);

      const cassee = await parcours(new ObservingDriver(TREE, CASSE), undefined, {
        requestFailures: 'fail',
      });
      // Seules les requêtes en échec sont recopiées : /api/ok n'apprend rien.
      assert.equal(cassee.steps[0]?.network?.length, 1);
      assert.equal(cassee.steps[0]?.consoleErrors?.length, 1);
    });
  });

  it('efface le secret du message quand le pilote échoue', async () => {
    process.env['QAI_TEST_PASS'] = 'hunter2';
    try {
      class LeakyDriver extends FakeDriver {
        override async act(action: Action): Promise<void> {
          throw new Error(`impossible de saisir « ${action.kind === 'fill' ? action.value : ''} »`);
        }
      }

      const report = await runScenario({
        driver: new LeakyDriver(TREE),
        scenario: scenario([{ id: 's1', do: 'se connecter' }]),
        resolution: resolution({
          s1: { actions: [{ kind: 'fill', target: CLICK, value: '{{env.QAI_TEST_PASS}}' }] },
        }),
      });

      assert.equal(report.status, 'failed');
      assert.doesNotMatch(report.steps[0]?.error ?? '', /hunter2/);
      assert.match(report.steps[0]?.error ?? '', /\*\*\*/);
    } finally {
      delete process.env['QAI_TEST_PASS'];
    }
  });
});
