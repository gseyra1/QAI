import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import { loadResolution } from '../resolution/load.ts';
import { loadScenario } from '../scenario/load.ts';
import type { HealRequest, HealResult, Healer } from './run.ts';
import { runScenario } from './run.ts';

const SCENARIO = 'examples/checkout-guest.qai.yaml';
const RESOLUTION = 'examples/.qai/resolutions/checkout-guest.web.json';

class SpyHealer implements Healer {
  readonly calls: HealRequest[] = [];

  async heal(request: HealRequest): Promise<HealResult> {
    this.calls.push(request);
    return { healed: false, reason: 'aucun réparateur en étage 1' };
  }
}

async function serveShop(bug: string | null): Promise<{ server: Server; url: string }> {
  const html = await readFile('fixtures/shop/index.html', 'utf8');
  const page =
    bug === null
      ? html
      : html.replace('<head>', `<head><script>window.__QAI_BUG=${JSON.stringify(bug)}</script>`);

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

async function runAgainst(url: string, healer?: Healer) {
  const scenario = await loadScenario(SCENARIO);
  const resolution = await loadResolution(RESOLUTION);
  const driver = new PlaywrightWebDriver(() => chromium.launch());
  try {
    await driver.launch({ entry: url, viewport: { width: 1280, height: 800 } });
    return await runScenario(healer ? { scenario, resolution, driver, healer } : { scenario, resolution, driver });
  } finally {
    await driver.dispose();
  }
}

describe('parcours de commande de bout en bout', () => {
  let healthy: Server;
  let broken: Server;
  let healthyUrl: string;
  let brokenUrl: string;

  before(async () => {
    ({ server: healthy, url: healthyUrl } = await serveShop(null));
    ({ server: broken, url: brokenUrl } = await serveShop('guest-confirm'));
  });

  after(async () => {
    await new Promise<void>((resolve) => healthy.close(() => resolve()));
    await new Promise<void>((resolve) => broken.close(() => resolve()));
  });

  it('rejoue les neuf étapes sur une application saine', async () => {
    const report = await runAgainst(healthyUrl);

    assert.deepEqual(
      report.steps.filter((step) => step.status !== 'passed').map((step) => [step.stepId, step.status, step.error, step.failures]),
      [],
    );
    assert.equal(report.status, 'passed');
    assert.equal(report.healCount, 0);
  });

  it('transporte les captures d\'une étape à l\'autre', async () => {
    const report = await runAgainst(healthyUrl);
    assert.equal(report.captures['article'], 'Chaise de bureau');
    assert.equal(report.captures['prix'], '129');
    assert.match(report.captures['commande'] ?? '', /^CMD-\d+$/);
  });

  it('détecte la régression du tunnel invité, sans rien réparer', async () => {
    const healer = new SpyHealer();
    const report = await runAgainst(brokenUrl, healer);

    assert.equal(report.status, 'failed');

    const failed = report.steps.find((step) => step.status === 'failed');
    assert.equal(failed?.stepId, 's8', 'l\'échec doit tomber sur le paiement');
    assert.deepEqual(
      failed?.failures.map((failure) => failure.assertion),
      ['la commande est confirmée', 'un numéro de commande est affiché'],
    );

    assert.equal(
      healer.calls.length,
      0,
      'une assertion fausse est une régression : le réparateur ne doit jamais être sollicité',
    );
    assert.equal(report.healCount, 0);
    assert.equal(report.steps.at(-1)?.status, 'skipped');
  });
});
