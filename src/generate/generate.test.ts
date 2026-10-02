import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import { runScenario } from '../engine/run.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import { loadResolution, parseResolution } from '../resolution/load.ts';
import { serializeResolution } from '../resolution/save.ts';
import type { Resolution } from '../resolution/types.ts';
import { RESOLUTION_VERSION } from '../resolution/types.ts';
import { loadScenario, parseScenario } from '../scenario/load.ts';
import type { Scenario } from '../scenario/types.ts';
// Confronté au schéma publié à chaque appel : voir conformance.ts.
import { generateResolution } from './conformance.ts';

const SCENARIO = 'examples/checkout-guest.qai.yaml';
const KNOWN_GOOD = 'examples/.qai/resolutions/checkout-guest.web.json';

/**
 * Un modèle factice qui rejoue une résolution connue.
 *
 * Il ne teste évidemment pas la qualité d'un vrai modèle — il teste la boucle :
 * la vérification de chaque cible contre l'application, le retour d'erreur, et
 * le fichier produit. Le vrai modèle se branche ensuite sans changer une ligne.
 */
class ReplayProvider implements ModelProvider {
  readonly name = 'replay';
  calls = 0;
  sabotaged = 0;

  readonly #scenario: Scenario;
  readonly #source: Resolution;
  readonly #sabotageFirstAttempt: boolean;
  #current = '';

  constructor(scenario: Scenario, source: Resolution, sabotageFirstAttempt = false) {
    this.#scenario = scenario;
    this.#source = source;
    this.#sabotageFirstAttempt = sabotageFirstAttempt;
  }

  #stepIdFor(text: string): string | null {
    const match = /^Intent: (.+)$/m.exec(text);
    if (match === null) return null;
    const intent = match[1] ?? '';
    const step = this.#scenario.steps.find(
      (candidate) => candidate.do === intent || Object.values(candidate.per_platform ?? {}).includes(intent),
    );
    return step?.id ?? null;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;

    const first = request.messages[0]?.content[0];
    const text = first !== undefined && first.type === 'text' ? first.text : '';
    const detected = this.#stepIdFor(text);
    if (detected !== null) this.#current = detected;

    const step = this.#source.steps[this.#current];
    assert.ok(step !== undefined, `aucune donnée de rejeu pour l'étape « ${this.#current} »`);

    const wantsActions = 'actions' in (request.responseSchema['properties'] as object);
    const isFirstAttempt = request.messages.length === 1;

    if (wantsActions && this.#sabotageFirstAttempt && isFirstAttempt) {
      this.sabotaged += 1;
      return {
        output: {
          actions: [
            { kind: 'click', target: { primary: { role: 'button', name: 'Bouton qui n\'existe pas' } } },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }

    const output = wantsActions
      ? { actions: step.actions, captures: step.captures, assertions: step.assertions }
      : { captures: step.captures, assertions: step.assertions };

    return { output, usage: { inputTokens: 1000, outputTokens: 200 } };
  }
}

/**
 * L'exemple tel qu'il était écrit avant les règles de génération de 0.4.0.
 *
 * Écrit à la main, il portait deux défauts : des replis « search-input » et
 * « product-card » que la boutique n'expose nulle part, et en s4 une
 * vérification qui retrouvait sa cible par la valeur même qu'elle affirme
 * (`name: "1"`, `value: "1"`). Reconstruit ici pour prouver que la génération
 * refuse le premier et signale le second.
 */
function withHistoricalDefects(source: Resolution): Resolution {
  const resolution = structuredClone(source);
  const ids: Record<string, string> = { s2: 'search-input', s3: 'product-card' };
  for (const [stepId, testId] of Object.entries(ids)) {
    const action = resolution.steps[stepId]?.actions[0];
    if (action !== undefined && 'target' in action) action.target.fallback = { testId };
  }
  const s4 = resolution.steps['s4']?.assertions?.["l'indicateur du panier affiche 1 article"];
  if (s4 !== undefined && s4.check === 'textEquals') s4.target = { ...s4.target, name: '1' };
  return resolution;
}

describe('génération de résolution', () => {
  let server: Server;
  let baseUrl: string;
  let scenario: Scenario;
  let knownGood: Resolution;
  let original: Resolution;

  before(async () => {
    const html = await readFile('fixtures/shop/index.html', 'utf8');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    scenario = await loadScenario(SCENARIO);
    knownGood = await loadResolution(KNOWN_GOOD);
    original = withHistoricalDefects(knownGood);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function generate(sabotage = false, source?: Resolution) {
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    const provider = new ReplayProvider(scenario, source ?? knownGood, sabotage);
    try {
      await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
      const result = await generateResolution({ scenario, driver, provider });
      return { result, provider };
    } finally {
      await driver.dispose();
    }
  }

  it('résout les neuf étapes contre l\'application réelle', async () => {
    const { result } = await generate();

    assert.deepEqual(
      result.steps.filter((step) => step.status !== 'resolved').map((s) => [s.stepId, s.rejections]),
      [],
    );
    assert.equal(result.status, 'complete');
    assert.equal(Object.keys(result.resolution.steps).length, 9);
  });

  it('produit un fichier identique à la résolution écrite à la main', async () => {
    const { result } = await generate();

    // L'historique de réparation est propre à un fichier vécu : une génération
    // fraîche n'en a pas. On compare le contenu, pas les traces.
    const withoutHealHistory = (resolution: Resolution) =>
      Object.fromEntries(
        Object.entries(resolution.steps).map(([id, { actions, captures, assertions }]) => [
          id,
          { actions, captures, assertions },
        ]),
      );

    assert.deepEqual(withoutHealHistory(result.resolution), withoutHealHistory(knownGood));
  });

  /**
   * Les deux défauts de l'exemple d'origine, proposés tels quels par le
   * modèle. Le repli fantôme est refusé, et rien n'est versionné. La cible
   * trouvée par sa valeur est signalée sans être refusée : refuser poussait
   * le vrai modèle vers pire (voir `tautologicalCheck`).
   */
  it('refuse un repli que la page n\'expose pas, et signale une cible trouvée par sa valeur', async () => {
    const withoutBadFallbacks = structuredClone(original);
    for (const id of ['s2', 's3']) {
      const action = withoutBadFallbacks.steps[id]?.actions[0];
      if (action !== undefined && 'target' in action) delete action.target.fallback;
    }

    const fallback = await generate(false, original);
    const s2 = fallback.result.steps.find((step) => step.stepId === 's2');
    assert.equal(s2?.status, 'failed');
    assert.match(
      s2?.rejections[0] ?? '',
      /fallback "search-input" designates no element on this screen \(the targeted element carries none\)/,
    );
    assert.equal(fallback.result.resolution.steps['s2'], undefined);

    const value = await generate(false, withoutBadFallbacks);
    const s4 = value.result.steps.find((step) => step.stepId === 's4');
    assert.equal(s4?.status, 'resolved');
    assert.match(
      s4?.warnings.join(' | ') ?? '',
      /assertion "l'indicateur du panier affiche 1 article" is located by the very value it asserts \("1"\)/,
    );
    assert.deepEqual(
      value.result.resolution.steps['s4']?.assertions,
      withoutBadFallbacks.steps['s4']?.assertions,
    );
  });

  it('rejette une cible introuvable et corrige au tour suivant', async () => {
    const { result, provider } = await generate(true);

    assert.ok(provider.sabotaged >= 9, 'chaque étape doit avoir été sabotée une fois');
    assert.equal(result.status, 'complete', 'la boucle doit récupérer');

    const rejections = result.steps.flatMap((step) => step.rejections);
    assert.ok(rejections.length >= 9);
    assert.ok(
      rejections.every((reason) => /no element matches/.test(reason)),
      `motifs inattendus : ${rejections.join(' | ')}`,
    );
    assert.ok(result.steps.every((step) => step.attempts >= 2));
  });

  it('la résolution générée rejoue vert sur l\'application', async () => {
    const { result } = await generate();

    const driver = new PlaywrightWebDriver(() => chromium.launch());
    try {
      await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
      const report = await runScenario({ scenario, resolution: result.resolution, driver });

      assert.deepEqual(
        report.steps.filter((step) => step.status !== 'passed').map((s) => [s.stepId, s.error, s.failures]),
        [],
      );
      assert.equal(report.status, 'passed');
      assert.equal(report.captures['article'], 'Chaise de bureau');
    } finally {
      await driver.dispose();
    }
  });
});

/** Rend les réponses dans l'ordre et garde chaque requête. */
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

async function serveLibrary(): Promise<{ server: Server; port: number }> {
  const html = await readFile('fixtures/library/index.html', 'utf8');
  // Toute adresse rend la page : l'application est montée sous un préfixe.
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/**
 * Le format v3 de bout en bout, dans un vrai navigateur : une étape qui ne
 * fait que vérifier, et une adresse recopiée avec son port par le modèle.
 * Généré sur un port, rejoué sur un autre — ce que la v2 ne savait pas faire
 * dès qu'une assertion portait sur l'adresse.
 */
describe('format v3 contre l\'application réelle', () => {
  let generation: { server: Server; port: number };
  let replay: { server: Server; port: number };

  before(async () => {
    generation = await serveLibrary();
    replay = await serveLibrary();
  });

  after(async () => {
    for (const { server } of [generation, replay]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('génère sans geste inventé, puis rejoue vert sur un autre port', async () => {
    assert.notEqual(generation.port, replay.port);

    const scenario = parseScenario(`
id: emprunt-v3
title: Un adhérent emprunte un ouvrage
steps:
  - id: s1
    do: ouvrir le catalogue en vue liste
  - id: s2
    expect: l'adresse est celle du catalogue en vue liste
  - id: s3
    do: chercher "Damasio"
    expect: la liste des notices contient au moins deux entrées
  - id: s4
    do: ouvrir la première notice
    capture:
      ouvrage: le titre de l'ouvrage
  - id: s5
    do: emprunter l'ouvrage
    expect: l'emprunt est enregistré
  - id: s6
    expect: la liste des emprunts contient "{{ouvrage}}"
`);

    // Une base à préfixe, sans barre finale : la normalisation est éprouvée
    // à l'écriture comme à la relecture.
    const base = `http://127.0.0.1:${generation.port}/mediatheque`;
    const notices = { role: 'list', name: 'Notices trouvées' };
    const provider = new ScriptedProvider([
      // Le modèle recopie l'adresse qu'il voit, port compris.
      { actions: [{ kind: 'navigate', to: `${base}/?vue=liste` }] },
      {
        assertions: {
          "l'adresse est celle du catalogue en vue liste": {
            check: 'urlEquals',
            value: `${base}/?vue=liste`,
          },
        },
      },
      {
        actions: [
          {
            kind: 'fill',
            target: { primary: { role: 'searchbox', name: 'Chercher une notice' } },
            value: 'Damasio',
          },
          { kind: 'press', key: 'Enter' },
        ],
        assertions: {
          'la liste des notices contient au moins deux entrées': {
            check: 'countAtLeast',
            target: { role: 'listitem', within: notices },
            value: 2,
          },
        },
      },
      {
        actions: [{ kind: 'click', target: { primary: { role: 'link', nth: 0, within: notices } } }],
        captures: {
          ouvrage: {
            from: { role: 'heading', within: { role: 'group', name: 'Notice détaillée' } },
            extract: 'text',
          },
        },
      },
      {
        actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Emprunter' } } }],
        assertions: {
          "l'emprunt est enregistré": {
            check: 'visible',
            target: { role: 'heading', name: 'Emprunt enregistré' },
          },
        },
      },
      {
        assertions: {
          'la liste des emprunts contient "{{ouvrage}}"': {
            check: 'textContains',
            target: { role: 'listitem', nth: 0, within: { role: 'list', name: 'Liste des emprunts' } },
            value: '{{ouvrage}}',
          },
        },
      },
    ]);

    const generator = new PlaywrightWebDriver(() => chromium.launch());
    let generated;
    try {
      await generator.launch({ entry: base, viewport: { width: 1280, height: 800 } });
      generated = await generateResolution({ scenario, driver: generator, provider, baseUrl: base });
    } finally {
      await generator.dispose();
    }

    assert.deepEqual(
      generated.steps.filter((step) => step.status !== 'resolved').map((s) => [s.stepId, s.rejections]),
      [],
    );
    const steps = generated.resolution.steps;
    // Aucun geste pour les deux étapes qui ne font que vérifier, et aucune
    // action ne leur a été demandée.
    assert.deepEqual(steps['s2']?.actions, []);
    assert.deepEqual(steps['s6']?.actions, []);
    for (const index of [1, 5]) {
      const schema = provider.requests[index]?.responseSchema['properties'] as object;
      assert.equal('actions' in schema, false);
    }
    // Ni l'hôte ni le port ne sont versionnés.
    assert.deepEqual(steps['s1']?.actions, [{ kind: 'navigate', to: '?vue=liste' }]);
    assert.deepEqual(steps['s2']?.assertions, {
      "l'adresse est celle du catalogue en vue liste": { check: 'urlEquals', value: '?vue=liste' },
    });
    assert.doesNotMatch(JSON.stringify(generated.resolution), new RegExp(String(generation.port)));

    // Le fichier tel qu'il serait versionné, relu par le chargeur.
    const resolution = parseResolution(serializeResolution(generated.resolution));
    assert.equal(resolution.version, RESOLUTION_VERSION);

    const replayBase = `http://127.0.0.1:${replay.port}/mediatheque`;
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    try {
      await driver.launch({ entry: replayBase, viewport: { width: 1280, height: 800 } });
      const report = await runScenario({ scenario, resolution, driver, baseUrl: replayBase });

      assert.deepEqual(
        report.steps
          .filter((step) => step.status !== 'passed')
          .map((s) => [s.stepId, s.error, s.failures]),
        [],
      );
      assert.equal(report.status, 'passed');
      assert.equal(report.captures['ouvrage'], 'La Horde du Contrevent');
    } finally {
      await driver.dispose();
    }

    // Sans la base, la même assertion d'adresse ne peut pas passer : c'est
    // bien la base du rejeu qui la rend vraie, pas une comparaison assouplie.
    const blind = new PlaywrightWebDriver(() => chromium.launch());
    try {
      await blind.launch({ entry: replayBase, viewport: { width: 1280, height: 800 } });
      const report = await runScenario({ scenario, resolution, driver: blind, assertTimeoutMs: 0 });
      assert.equal(report.status, 'failed');
      assert.equal(report.steps.find((step) => step.status === 'failed')?.stepId, 's2');
    } finally {
      await blind.dispose();
    }
  });
});
