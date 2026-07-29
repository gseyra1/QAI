import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import { runScenario } from '../engine/run.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import { loadResolution } from '../resolution/load.ts';
import type { Resolution } from '../resolution/types.ts';
import { loadScenario } from '../scenario/load.ts';
import type { Scenario } from '../scenario/types.ts';
import { generateResolution } from './generate.ts';

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
    const match = /^Intention : (.+)$/m.exec(text);
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

describe('génération de résolution', () => {
  let server: Server;
  let baseUrl: string;
  let scenario: Scenario;
  let knownGood: Resolution;

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
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function generate(sabotage = false) {
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    const provider = new ReplayProvider(scenario, knownGood, sabotage);
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

  it('rejette une cible introuvable et corrige au tour suivant', async () => {
    const { result, provider } = await generate(true);

    assert.ok(provider.sabotaged >= 9, 'chaque étape doit avoir été sabotée une fois');
    assert.equal(result.status, 'complete', 'la boucle doit récupérer');

    const rejections = result.steps.flatMap((step) => step.rejections);
    assert.ok(rejections.length >= 9);
    assert.ok(
      rejections.every((reason) => /aucun élément ne correspond/.test(reason)),
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
