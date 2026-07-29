import { readFile } from 'node:fs/promises';
import type { Resolution, StepResolution } from './types.ts';

export class ResolutionError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'ResolutionError';
    this.path = path;
  }
}

const PLATFORMS: ReadonlySet<string> = new Set(['web', 'ios', 'android']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseResolution(raw: string, path = '<inline>'): Resolution {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new ResolutionError(error instanceof Error ? error.message : 'JSON illisible', path);
  }

  if (!isRecord(doc)) throw new ResolutionError('le document n\'est pas un objet', path);

  const scenario = doc['scenario'];
  const platform = doc['platform'];
  const recordedAt = doc['recordedAt'];
  const steps = doc['steps'];

  if (typeof scenario !== 'string') throw new ResolutionError('champ scenario manquant', path);
  if (typeof platform !== 'string') throw new ResolutionError('champ platform manquant', path);
  if (!PLATFORMS.has(platform)) {
    throw new ResolutionError(
      `plateforme inconnue « ${platform} » (attendu : ${[...PLATFORMS].join(', ')})`,
      path,
    );
  }
  if (typeof recordedAt !== 'string') throw new ResolutionError('champ recordedAt manquant', path);
  if (!isRecord(steps)) throw new ResolutionError('champ steps manquant', path);

  const parsed: Record<string, StepResolution> = {};
  for (const [stepId, value] of Object.entries(steps)) {
    if (!isRecord(value)) throw new ResolutionError(`étape ${stepId} mal formée`, path);
    if (!Array.isArray(value['actions'])) {
      throw new ResolutionError(`étape ${stepId} : champ actions manquant`, path);
    }
    parsed[stepId] = value as unknown as StepResolution;
  }

  const resolution: Resolution = {
    scenario,
    platform: platform as Resolution['platform'],
    recordedAt,
    steps: parsed,
  };
  if (typeof doc['appVersion'] === 'string') resolution.appVersion = doc['appVersion'];
  return resolution;
}

export async function loadResolution(path: string): Promise<Resolution> {
  return parseResolution(await readFile(path, 'utf8'), path);
}
