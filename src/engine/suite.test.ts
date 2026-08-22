import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import type { Driver } from '../driver/types.ts';
import { PlaywrightWebDriver } from '../driver/web/PlaywrightWebDriver.ts';
import { loadResolution } from '../resolution/load.ts';
import { loadScenario } from '../scenario/load.ts';
import type { StateProvider, StateRequest } from '../state/types.ts';
import type { SuiteItem } from './suite.ts';
import { runSuite } from './suite.ts';

const SCENARIOS = [
  'examples/checkout-guest.qai.yaml',
  'examples/compte-connecte.qai.yaml',
] as const;

/** Traduit un état nommé en session installée. Ici en dur ; chez un client,
 *  un appel à son API d'amorçage. */
class DemoStates implements StateProvider {
  readonly seen: StateRequest[] = [];

  async prepare(request: StateRequest) {
    this.seen.push(request);
    return request.given.state === 'client-connecte'
      ? { storage: { qai_user: 'Alice' } }
      : {};
  }
}

async function loadItems(): Promise<SuiteItem[]> {
  const items: SuiteItem[] = [];
  for (const path of SCENARIOS) {
    const scenario = await loadScenario(path);
    const resolutionPath = `examples/.qai/resolutions/${scenario.id}.web.json`;
    items.push({ scenario, resolution: await loadResolution(resolutionPath), resolutionPath });
  }
  return items;
}

describe('exécution d\'une suite', () => {
  let server: Server;
  let baseUrl: string;
  let items: SuiteItem[];

  before(async () => {
    const html = await readFile('fixtures/shop/index.html', 'utf8');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    items = await loadItems();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const createDriver = (): Driver => new PlaywrightWebDriver(() => chromium.launch());

  it('joue plusieurs parcours en parallèle et agrège le verdict', async () => {
    const states = new DemoStates();
    const report = await runSuite({ items, baseUrl, createDriver, states, workers: 2 });

    assert.equal(report.status, 'passed');
    assert.equal(report.entries.length, 2);
    assert.deepEqual(
      report.entries.map((entry) => [entry.scenarioId, entry.report?.status]).sort(),
      [
        ['checkout-guest', 'passed'],
        ['compte-connecte', 'passed'],
      ],
    );
  });

  it('installe l\'état déclaré par « given » avant la première étape', async () => {
    const states = new DemoStates();
    await runSuite({ items, baseUrl, createDriver, states, workers: 2 });

    assert.deepEqual(
      states.seen.map((request) => request.given.state).sort(),
      ['client-connecte', 'visiteur-anonyme'],
    );
  });

  it('sans fournisseur d\'état, tout parcours déclarant « given » est refusé explicitement', async () => {
    const report = await runSuite({ items, baseUrl, createDriver, workers: 2 });

    // Refusés avant de démarrer, pas exécutés anonymes : un parcours joué sans
    // son état pourrait sortir vert et ne prouverait rien. Les deux scénarios
    // d'exemple déclarent « given » — la même règle que « resolve » s'applique.
    assert.equal(report.status, 'failed');
    for (const entry of report.entries) {
      assert.equal(entry.report, null);
      assert.match(entry.error ?? '', /StateProvider/);
    }
  });

  it('un parcours sans « given » se joue sans fournisseur d\'état', async () => {
    const sansEtat = items
      .filter((item) => item.scenario.id === 'checkout-guest')
      .map((item) => ({
        ...item,
        scenario: (({ given: _given, ...rest }) => rest)(item.scenario),
      }));
    const report = await runSuite({ items: sansEtat, baseUrl, createDriver, workers: 1 });

    assert.equal(report.status, 'passed');
  });

  it('isole les parcours : aucun état ne fuit d\'un scénario à l\'autre', async () => {
    const states = new DemoStates();
    // Deux fois le parcours connecté et deux fois le parcours invité, mélangés :
    // si le stockage fuyait, l'invité verrait la salutation d'Alice.
    const mixed = [items[0], items[1], items[0], items[1]].filter(
      (item): item is SuiteItem => item !== undefined,
    );
    const report = await runSuite({ items: mixed, baseUrl, createDriver, states, workers: 4 });

    assert.equal(report.status, 'passed');
    assert.equal(report.entries.length, 4);
  });

  it('remonte une erreur de driver sans faire tomber la suite', async () => {
    const report = await runSuite({
      items,
      baseUrl: 'http://127.0.0.1:1/',
      createDriver,
      states: new DemoStates(),
      workers: 2,
    });

    assert.equal(report.status, 'failed');
    assert.ok(report.entries.every((entry) => entry.error !== undefined));
  });
});
