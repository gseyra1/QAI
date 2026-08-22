import { availableParallelism } from 'node:os';
import type { Driver } from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import type { StateProvider } from '../state/types.ts';
import type { Healer, ScenarioReport, Watchdogs } from './run.ts';
import { runScenario } from './run.ts';

export interface SuiteItem {
  scenario: Scenario;
  resolution: Resolution;
  /** Où réécrire la résolution si le parcours est réparé. */
  resolutionPath: string;
  /** Dossier du fichier scénario : racine des chemins relatifs d'un upload. */
  baseDir?: string;
}

export interface SuiteInput {
  items: SuiteItem[];
  baseUrl: string;
  /** Un driver neuf par scénario : l'isolement prime sur le temps de démarrage. */
  createDriver: () => Driver;
  viewport?: { width: number; height: number };
  /** Le réparateur a besoin du driver du worker, d'où la fabrique. */
  createHealer?: (driver: Driver) => Healer;
  states?: StateProvider;
  workers?: number;
  healBudget?: number;
  /** Fenêtre de réévaluation d'une assertion encore fausse. Voir RunInput. */
  assertTimeoutMs?: number;
  /** Range une capture d'échec et rend son identifiant. Voir RunInput. */
  captureArtifact?: (name: string, bytes: Uint8Array) => Promise<string>;
  /** Garde-fous réseau et console, communs à toute la suite. */
  watchdogs?: Watchdogs;
}

export interface SuiteEntry {
  scenarioId: string;
  resolutionPath: string;
  report: ScenarioReport | null;
  error?: string;
}

export interface SuiteReport {
  status: 'passed' | 'healed' | 'failed';
  entries: SuiteEntry[];
  durationMs: number;
}

async function runOne(item: SuiteItem, input: SuiteInput): Promise<SuiteEntry> {
  const driver = input.createDriver();
  const entry: SuiteEntry = {
    scenarioId: item.scenario.id,
    resolutionPath: item.resolutionPath,
    report: null,
  };

  try {
    await driver.launch({
      entry: input.baseUrl,
      ...(input.viewport !== undefined ? { viewport: input.viewport } : {}),
    });

    if (item.scenario.given !== undefined && input.states !== undefined) {
      const prepared = await input.states.prepare({
        scenarioId: item.scenario.id,
        baseUrl: input.baseUrl,
        given: item.scenario.given,
      });
      await driver.applyState(prepared);
    }

    const healer = input.createHealer?.(driver);
    entry.report = await runScenario({
      scenario: item.scenario,
      resolution: item.resolution,
      driver,
      ...(healer !== undefined ? { healer } : {}),
      ...(input.healBudget !== undefined ? { healBudget: input.healBudget } : {}),
      ...(input.assertTimeoutMs !== undefined ? { assertTimeoutMs: input.assertTimeoutMs } : {}),
      ...(input.captureArtifact !== undefined ? { captureArtifact: input.captureArtifact } : {}),
      ...(item.baseDir !== undefined ? { baseDir: item.baseDir } : {}),
      ...(input.watchdogs !== undefined ? { watchdogs: input.watchdogs } : {}),
    });
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    await driver.dispose();
  }

  return entry;
}

/**
 * Exécute une suite en parallèle.
 *
 * Chaque scénario obtient un driver neuf. Partager un navigateur entre parcours
 * ferait fuiter cookies et stockage de l'un à l'autre : le coût de démarrage
 * est le prix de l'isolement, et il n'est pas négociable pour un outil de test.
 */
export async function runSuite(input: SuiteInput): Promise<SuiteReport> {
  const started = Date.now();
  const workers = Math.max(1, input.workers ?? Math.min(4, availableParallelism()));
  const entries: SuiteEntry[] = new Array<SuiteEntry>(input.items.length);

  let next = 0;
  const pull = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = input.items[index];
      if (item === undefined) return;
      entries[index] = await runOne(item, input);
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, input.items.length) }, pull));

  const settled = entries.filter((entry): entry is SuiteEntry => entry !== undefined);
  const failed = settled.some(
    (entry) => entry.error !== undefined || entry.report?.status === 'failed',
  );
  const healed = settled.some((entry) => entry.report?.status === 'healed');

  return {
    status: failed ? 'failed' : healed ? 'healed' : 'passed',
    entries: settled,
    durationMs: Date.now() - started,
  };
}
