import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import type { ScenarioReport } from '../engine/run.ts';
import { runScenario } from '../engine/run.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import { applyHeals } from '../resolution/apply.ts';
import { loadResolution } from '../resolution/load.ts';
import type { Resolution } from '../resolution/types.ts';
import { loadScenario } from '../scenario/load.ts';
import type { Scenario } from '../scenario/types.ts';
import { ModelHealer } from './ModelHealer.ts';

const SCENARIO = 'examples/checkout-guest.qai.yaml';
const RESOLUTION = 'examples/.qai/resolutions/checkout-guest.web.json';

/** Rend les propositions d'une file, dans l'ordre. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly seen: ModelRequest[] = [];

  readonly #queue: unknown[];

  constructor(queue: unknown[]) {
    this.#queue = [...queue];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.seen.push(request);
    const output = this.#queue.shift() ?? { target: { primary: {} }, note: 'file vide' };
    return { output, usage: { inputTokens: 800, outputTokens: 60 } };
  }
}

async function serve(mode: string): Promise<{ server: Server; url: string }> {
  const source = await readFile('fixtures/shop/index.html', 'utf8');
  const page = source.replace(
    '<head>',
    `<head><script>window.__QAI_BUG=${JSON.stringify(mode)}</script>`,
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

describe('ModelHealer', () => {
  let servers: Server[] = [];
  const urls: Record<string, string> = {};
  let scenario: Scenario;
  let resolution: Resolution;

  before(async () => {
    for (const mode of ['rename-add', 'rename-guest']) {
      const { server, url } = await serve(mode);
      servers.push(server);
      urls[mode] = url;
    }
    scenario = await loadScenario(SCENARIO);
    resolution = await loadResolution(RESOLUTION);
  });

  after(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
  });

  async function run(
    mode: string,
    queue: unknown[] | null,
  ): Promise<{ report: ScenarioReport; provider: ScriptedProvider }> {
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    const provider = new ScriptedProvider(queue ?? []);
    try {
      await driver.launch({ entry: urls[mode] as string, viewport: { width: 1280, height: 800 } });
      const healer = queue === null ? undefined : new ModelHealer({ driver, provider });
      const report = await runScenario(
        healer === undefined
          ? { scenario, resolution, driver }
          : { scenario, resolution, driver, healer },
      );
      return { report, provider };
    } finally {
      await driver.dispose();
    }
  }

  describe('cible sans repli : la réparation est obligatoire', () => {
    it('absorbe un changement de libellé et laisse le parcours vert', async () => {
      const { report, provider } = await run('rename-guest', [
        {
          target: { primary: { role: 'button', name: 'Continuer sans compte' } },
          note: 'Le libellé du bouton est passé de « Commander en tant qu\'invité » à « Continuer sans compte ».',
        },
      ]);

      assert.equal(report.status, 'healed', 'réparé, pas simplement réussi');
      assert.equal(report.healCount, 1);
      assert.equal(provider.seen.length, 1, 'une seule proposition a suffi');
      assert.deepEqual(
        report.steps.filter((step) => !['passed', 'healed'].includes(step.status)),
        [],
      );

      const [heal] = report.heals;
      assert.equal(heal?.stepId, 's6');
      assert.equal(heal?.degraded, false);
      assert.match(heal?.note ?? '', /libellé/);
    });

    it('rejette une proposition qui ne résout pas, puis accepte la suivante', async () => {
      const { report, provider } = await run('rename-guest', [
        { target: { primary: { role: 'button', name: 'Toujours pas là' } }, note: 'tentative' },
        {
          target: { primary: { role: 'button', name: 'Continuer sans compte' } },
          note: 'Le libellé du bouton a changé.',
        },
      ]);

      assert.equal(report.status, 'healed');
      assert.equal(provider.seen.length, 2);

      const feedback = provider.seen[1]?.messages.at(-1)?.content[0];
      assert.ok(feedback !== undefined && feedback.type === 'text');
      assert.match(feedback.text, /aucun élément ne correspond/);
    });

    it('échoue plutôt que de réparer avec une cible ambiguë', async () => {
      const { report } = await run('rename-guest', [
        { target: { primary: { role: 'link' } }, note: "n'importe quel lien" },
        { target: { primary: { role: 'link' } }, note: 'toujours ambigu' },
      ]);

      assert.equal(report.status, 'failed');
      assert.equal(report.healCount, 0);
      assert.match(report.steps.find((s) => s.status === 'failed')?.error ?? '', /ambiguë/);
    });

    it('échoue proprement sans réparateur', async () => {
      const { report } = await run('rename-guest', null);
      assert.equal(report.status, 'failed');
      assert.match(report.steps.find((s) => s.status === 'failed')?.error ?? '', /introuvable/);
    });
  });

  describe('cible sauvée par son repli : la réparation est opportuniste', () => {
    it('restaure le ciblage sémantique au lieu de laisser le repli décider', async () => {
      const { report } = await run('rename-add', [
        {
          target: { primary: { role: 'button', name: 'Ajouter' } },
          note: 'Le libellé du bouton est passé de « Ajouter au panier » à « Ajouter ».',
        },
      ]);

      assert.equal(report.status, 'healed');
      assert.equal(report.heals[0]?.stepId, 's4');
    });

    it('sans réparateur, passe mais signale la dégradation', async () => {
      const { report } = await run('rename-add', null);

      assert.equal(report.status, 'passed', 'le parcours fonctionne : ne pas crier au loup');
      const step = report.steps.find((candidate) => candidate.stepId === 's4');
      assert.match(step?.warnings?.[0] ?? '', /repli technique/);
      assert.match(step?.warnings?.[0] ?? '', /portage mobile/);
    });
  });

  describe('frontière de sécurité', () => {
    it('ne propose au modèle que la cible, jamais les assertions', async () => {
      const { provider } = await run('rename-guest', [
        { target: { primary: { role: 'button', name: 'Continuer sans compte' } }, note: 'renommé' },
      ]);

      const properties = Object.keys(
        (provider.seen[0]?.responseSchema['properties'] as object | undefined) ?? {},
      );
      assert.deepEqual(properties.sort(), ['note', 'target']);
    });

    it('réinjecte la réparation sans toucher aux assertions', async () => {
      const { report } = await run('rename-guest', [
        {
          target: { primary: { role: 'button', name: 'Continuer sans compte' } },
          note: 'Le libellé du bouton a changé.',
        },
      ]);

      const updated = applyHeals(resolution, report.heals, '2026-07-29T10:00:00Z');
      const step = updated.steps['s6'];

      assert.equal(step?.healedAt, '2026-07-29T10:00:00Z');
      assert.match(step?.healNote ?? '', /libellé/);
      assert.deepEqual((step?.actions[0] as { target: unknown }).target, {
        primary: { role: 'button', name: 'Continuer sans compte' },
      });

      for (const id of Object.keys(resolution.steps)) {
        assert.deepEqual(
          updated.steps[id]?.assertions,
          resolution.steps[id]?.assertions,
          `les assertions de ${id} doivent être intactes`,
        );
      }
    });
  });
});
