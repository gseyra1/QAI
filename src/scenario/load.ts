import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { Scenario, Step } from './types.ts';

export class ScenarioError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'ScenarioError';
    this.path = path;
  }
}

/**
 * Clés interdites parce que YAML 1.1 les interprète comme des booléens. Un
 * scénario qui en contiendrait verrait la clé disparaître silencieusement — on
 * refuse plutôt que de laisser passer un bloc invisible.
 */
const YAML_BOOLEAN_KEYS = new Set(['true', 'false', 'on', 'off', 'yes', 'no', 'y', 'n']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoBooleanKeys(raw: string, path: string): void {
  for (const match of raw.matchAll(/^\s*([A-Za-z_]+)\s*:/gm)) {
    const key = match[1];
    if (key !== undefined && YAML_BOOLEAN_KEYS.has(key.toLowerCase())) {
      throw new ScenarioError(
        `the key "${key}" is forbidden: YAML 1.1 converts it to a boolean. Use per_platform.`,
        path,
      );
    }
  }
}

function parseStep(value: unknown, index: number, path: string): Step {
  if (!isRecord(value)) throw new ScenarioError(`step ${index} is not an object`, path);

  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new ScenarioError(`step ${index} has no id`, path);
  }

  const step: Step = { id };

  if (typeof value['do'] === 'string') step.do = value['do'];
  if (isRecord(value['per_platform'])) {
    step.per_platform = value['per_platform'] as NonNullable<Step['per_platform']>;
  }
  if (Array.isArray(value['only'])) step.only = value['only'] as NonNullable<Step['only']>;
  if (typeof value['expect'] === 'string' || Array.isArray(value['expect'])) {
    step.expect = value['expect'] as NonNullable<Step['expect']>;
  }
  if (isRecord(value['capture'])) step.capture = value['capture'] as Record<string, string>;

  if (step.do === undefined && step.per_platform === undefined) {
    throw new ScenarioError(`step "${id}" has neither do nor per_platform`, path);
  }

  return step;
}

export function parseScenario(raw: string, path = '<inline>'): Scenario {
  assertNoBooleanKeys(raw, path);

  const doc: unknown = parse(raw);
  if (!isRecord(doc)) throw new ScenarioError('the document is empty or malformed', path);

  const id = doc['id'];
  const title = doc['title'];
  const steps = doc['steps'];

  if (typeof id !== 'string') throw new ScenarioError('missing id', path);
  if (typeof title !== 'string') throw new ScenarioError('missing title', path);
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ScenarioError('missing or empty steps', path);
  }

  const parsed = steps.map((step, index) => parseStep(step, index, path));

  const seen = new Set<string>();
  for (const step of parsed) {
    if (seen.has(step.id)) {
      throw new ScenarioError(
        `duplicate step id "${step.id}" — it is the anchor of the resolution cache`,
        path,
      );
    }
    seen.add(step.id);
  }

  const scenario: Scenario = { id, title, steps: parsed };
  if (Array.isArray(doc['tags'])) scenario.tags = doc['tags'] as string[];
  if (Array.isArray(doc['platforms'])) scenario.platforms = doc['platforms'] as NonNullable<Scenario['platforms']>;
  if (isRecord(doc['given'])) scenario.given = doc['given'] as NonNullable<Scenario['given']>;

  return scenario;
}

export async function loadScenario(path: string): Promise<Scenario> {
  return parseScenario(await readFile(path, 'utf8'), path);
}
