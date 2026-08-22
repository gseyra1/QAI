import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { WatchdogLevel, Watchdogs } from './engine/run.ts';

export interface QaiConfig {
  scenarios?: string[];
  /** Ne jouer que les parcours portant au moins un de ces tags. */
  tags?: string[];
  baseUrl?: string;
  states?: string;
  provider?: string;
  workers?: number;
  maxCost?: number;
  attempts?: number;
  assertTimeout?: number;
  artifacts?: string;
  strict?: boolean;
  /** Garde-fous réseau et console. Absent = tout à « off ». */
  watchdogs?: Watchdogs;
}

const FILE = 'qai.config.json';
const PATH_KEYS = ['states', 'provider', 'artifacts'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Les chemins d'un fichier de configuration se lisent **relativement à ce
 * fichier**, pas au répertoire courant. Sans ça, lancer QAI depuis un
 * sous-dossier casserait silencieusement la résolution des modules.
 */
function absolutize(config: QaiConfig, base: string): QaiConfig {
  const out: QaiConfig = { ...config };
  for (const key of PATH_KEYS) {
    const value = out[key];
    if (value !== undefined && !isAbsolute(value)) out[key] = resolve(base, value);
  }
  if (out.scenarios !== undefined) {
    out.scenarios = out.scenarios.map((path) => (isAbsolute(path) ? path : resolve(base, path)));
  }
  return out;
}

const LEVELS: ReadonlySet<string> = new Set(['off', 'warn', 'fail']);

/**
 * Un niveau inconnu est ignoré plutôt que corrigé au plus strict : une faute
 * de frappe ne doit pas faire tomber une suite entière, ni la rendre verte
 * sans qu'on l'ait demandé.
 */
function parseWatchdogs(raw: Record<string, unknown>): Watchdogs {
  const watchdogs: Watchdogs = {};
  for (const key of ['consoleErrors', 'requestFailures'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && LEVELS.has(value)) watchdogs[key] = value as WatchdogLevel;
  }
  if (Array.isArray(raw['allow'])) watchdogs.allow = raw['allow'] as string[];
  return watchdogs;
}

function parse(raw: string, path: string): QaiConfig {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} : ${error instanceof Error ? error.message : 'JSON illisible'}`);
  }
  if (!isRecord(document)) throw new Error(`${path} : le document n'est pas un objet`);

  const config: QaiConfig = {};
  const scenarios = document['scenarios'];
  if (typeof scenarios === 'string') config.scenarios = [scenarios];
  else if (Array.isArray(scenarios)) config.scenarios = scenarios as string[];

  // Les tags ne sont pas des chemins : ils ne passent pas par absolutize().
  const tags = document['tags'];
  if (typeof tags === 'string') config.tags = [tags];
  else if (Array.isArray(tags)) config.tags = tags as string[];

  for (const key of ['baseUrl', 'states', 'provider', 'artifacts'] as const) {
    const value = document[key];
    if (typeof value === 'string') config[key] = value;
  }
  for (const key of ['workers', 'maxCost', 'attempts', 'assertTimeout'] as const) {
    const value = document[key];
    if (typeof value === 'number') config[key] = value;
  }
  if (typeof document['strict'] === 'boolean') config.strict = document['strict'];

  const watchdogs = document['watchdogs'];
  if (isRecord(watchdogs)) config.watchdogs = parseWatchdogs(watchdogs);

  return absolutize(config, dirname(resolve(path)));
}

/**
 * Cherche `qai.config.json` en remontant depuis le répertoire courant, comme le
 * font les outils de la chaîne Node — une équipe lance ses tests depuis
 * n'importe où dans le dépôt.
 */
export async function loadConfig(explicit?: string): Promise<{ config: QaiConfig; path: string | null }> {
  if (explicit !== undefined) {
    return { config: parse(await readFile(explicit, 'utf8'), explicit), path: explicit };
  }

  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, FILE);
    try {
      return { config: parse(await readFile(candidate, 'utf8'), candidate), path: candidate };
    } catch (error) {
      // Un fichier présent mais invalide doit crier, pas être ignoré : le
      // silence ferait tourner la suite avec des réglages que personne n'a
      // voulus.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return { config: {}, path: null };
    dir = parent;
  }
}
