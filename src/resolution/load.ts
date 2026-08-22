import { readFile } from 'node:fs/promises';
import type { Resolution, StepResolution } from './types.ts';
import { RESOLUTION_VERSION } from './types.ts';

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
    throw new ResolutionError(error instanceof Error ? error.message : 'unreadable JSON', path);
  }

  if (!isRecord(doc)) throw new ResolutionError('the document is not an object', path);

  const scenario = doc['scenario'];
  const platform = doc['platform'];
  const recordedAt = doc['recordedAt'];
  const steps = doc['steps'];

  if (typeof scenario !== 'string') throw new ResolutionError('missing scenario field', path);
  if (typeof platform !== 'string') throw new ResolutionError('missing platform field', path);
  if (!PLATFORMS.has(platform)) {
    throw new ResolutionError(
      `unknown platform "${platform}" (expected: ${[...PLATFORMS].join(', ')})`,
      path,
    );
  }
  if (typeof recordedAt !== 'string') throw new ResolutionError('missing recordedAt field', path);
  if (!isRecord(steps)) throw new ResolutionError('missing steps field', path);

  // Champ absent = 1 : les fichiers écrits avant l'introduction du champ
  // doivent continuer à se charger tels quels.
  const rawVersion = doc['version'];
  let version = RESOLUTION_VERSION;
  if (rawVersion !== undefined) {
    if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
      throw new ResolutionError('champ version invalide (entier ≥ 1 attendu)', path);
    }
    if (rawVersion > RESOLUTION_VERSION) {
      // Lire quand même produirait des verts qui ne prouvent rien : un format
      // plus récent peut décrire une observation que ce moteur ne sait pas
      // reproduire.
      throw new ResolutionError(
        `résolution en v${rawVersion}, ce QAI lit jusqu'à la v${RESOLUTION_VERSION} — mettre à jour QAI ou régénérer la résolution`,
        path,
      );
    }
    version = rawVersion;
  }

  const parsed: Record<string, StepResolution> = {};
  for (const [stepId, value] of Object.entries(steps)) {
    if (!isRecord(value)) throw new ResolutionError(`step ${stepId} is malformed`, path);
    if (!Array.isArray(value['actions'])) {
      throw new ResolutionError(`step ${stepId}: missing actions field`, path);
    }
    parsed[stepId] = value as unknown as StepResolution;
  }

  const resolution: Resolution = {
    version,
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
