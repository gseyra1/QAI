import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface QaiConfig {
  scenarios?: string[];
  baseUrl?: string;
  states?: string;
  provider?: string;
  workers?: number;
  maxCost?: number;
  attempts?: number;
  assertTimeout?: number;
  artifacts?: string;
  strict?: boolean;
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

  for (const key of ['baseUrl', 'states', 'provider', 'artifacts'] as const) {
    const value = document[key];
    if (typeof value === 'string') config[key] = value;
  }
  for (const key of ['workers', 'maxCost', 'attempts', 'assertTimeout'] as const) {
    const value = document[key];
    if (typeof value === 'number') config[key] = value;
  }
  if (typeof document['strict'] === 'boolean') config.strict = document['strict'];

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
