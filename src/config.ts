import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isAppPath } from './driver/ios/entry.ts';
import type { WatchdogLevel, Watchdogs } from './engine/run.ts';

/** Les plateformes que la ligne de commande sait piloter. */
export type CliPlatform = 'web' | 'ios';
export const CLI_PLATFORMS: ReadonlySet<string> = new Set<CliPlatform>(['web', 'ios']);

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
  /** `web` par défaut. `ios` est expérimental. */
  platform?: CliPlatform;
  /** L'application iOS : identifiant de bundle, ou chemin d'un `.app`/`.ipa`. */
  app?: string;
  /** UDID ou nom de l'appareil iOS. */
  device?: string;
  /** Serveur Appium, pour `ios`. */
  appiumUrl?: string;
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
  // `app` n'est un chemin que s'il désigne un bundle : un identifiant
  // « com.example.app » absolutisé deviendrait un fichier inexistant.
  const app = out.app;
  if (app !== undefined && isAppPath(app) && !isAbsolute(app) && !/^https?:\/\//i.test(app)) {
    out.app = resolve(base, app);
  }
  return out;
}

const LEVELS: ReadonlySet<string> = new Set(['off', 'warn', 'fail']);

/**
 * Un niveau inconnu arrête le chargement.
 *
 * L'ignorer retombait sur `off`, donc une faute de frappe sur « fail »
 * **désarmait** le garde-fou que l'utilisateur croyait armer, et la suite
 * passait au vert sans qu'il l'ait demandé — exactement le résultat que le
 * silence prétendait éviter. C'est déjà le traitement réservé à un réglage
 * numérique illisible : « --workers abc » arrête la commande plutôt que de se
 * dissoudre. Un garde-fou mérite la même rigueur : sa raison d'être est
 * d'être armé.
 *
 * `allow` est validé pour la même raison : une entrée non textuelle ne se
 * verrait qu'au moment d'appeler `includes` dessus, six étapes plus loin.
 */
const WATCHDOG_KEYS: ReadonlySet<string> = new Set(['consoleErrors', 'requestFailures', 'allow']);

function parseWatchdogs(raw: Record<string, unknown>, path: string): Watchdogs {
  const watchdogs: Watchdogs = {};
  const attendus = [...LEVELS].map((level) => `"${level}"`).join(', ');

  // Une clé inconnue est presque toujours une faute de frappe sur une clé
  // connue — « requestFailure » sans « s » — et l'ignorer désarme le garde-fou
  // que l'utilisateur croit armer, exactement le silence que ce module refuse
  // pour une valeur illisible.
  for (const key of Object.keys(raw)) {
    if (!WATCHDOG_KEYS.has(key)) {
      throw new Error(
        `${path}: unknown watchdogs key "${key}" (expected: ${[...WATCHDOG_KEYS].join(', ')})`,
      );
    }
  }

  for (const key of ['consoleErrors', 'requestFailures'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !LEVELS.has(value)) {
      throw new Error(`${path}: watchdogs.${key} must be one of ${attendus}`);
    }
    watchdogs[key] = value as WatchdogLevel;
  }

  const allow = raw['allow'];
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((item) => typeof item !== 'string')) {
      throw new Error(`${path}: watchdogs.allow must be an array of strings`);
    }
    watchdogs.allow = allow as string[];
  }

  return watchdogs;
}

function parse(raw: string, path: string): QaiConfig {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : 'unreadable JSON'}`);
  }
  if (!isRecord(document)) throw new Error(`${path}: the document is not an object`);

  const config: QaiConfig = {};
  const scenarios = document['scenarios'];
  if (typeof scenarios === 'string') config.scenarios = [scenarios];
  else if (Array.isArray(scenarios)) config.scenarios = scenarios as string[];

  // Les tags ne sont pas des chemins : ils ne passent pas par absolutize().
  const tags = document['tags'];
  if (typeof tags === 'string') config.tags = [tags];
  else if (Array.isArray(tags)) config.tags = tags as string[];

  for (const key of ['baseUrl', 'states', 'provider', 'artifacts', 'app', 'device', 'appiumUrl'] as const) {
    const value = document[key];
    if (typeof value === 'string') config[key] = value;
  }
  for (const key of ['workers', 'maxCost', 'attempts', 'assertTimeout'] as const) {
    const value = document[key];
    if (typeof value === 'number') config[key] = value;
  }
  if (typeof document['strict'] === 'boolean') config.strict = document['strict'];

  // Une plateforme inconnue arrête le chargement : « iso » retombant sur le
  // web ferait passer une suite mobile pour verte sans avoir touché l'appareil.
  const platform = document['platform'];
  if (platform !== undefined) {
    if (typeof platform !== 'string' || !CLI_PLATFORMS.has(platform)) {
      throw new Error(`${path}: platform must be "web" or "ios"`);
    }
    config.platform = platform as CliPlatform;
  }

  const watchdogs = document['watchdogs'];
  if (watchdogs !== undefined) {
    // Présent mais pas un objet — « watchdogs: "fail" » — est une erreur, pas
    // un no-op : le laisser passer désarmerait le garde-fou en silence.
    if (!isRecord(watchdogs)) throw new Error(`${path}: watchdogs must be an object`);
    config.watchdogs = parseWatchdogs(watchdogs, path);
  }

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
