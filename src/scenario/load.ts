import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { Scenario, Step } from './types.ts';
import { verifies } from './types.ts';

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

/** Un texte qui dit quelque chose : ni vide, ni fait que de blancs. */
function isIntent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

const TARGET_PLATFORMS = new Set(['web', 'mobile', 'ios', 'android']);

/**
 * Les seules clés admises, à chaque niveau — celles du schéma publié.
 *
 * Une clé inconnue n'est pas ignorée : depuis qu'une étape peut ne faire que
 * vérifier, `Do:` ou `does:` à côté d'un `expect` ne laisse pas une étape
 * invalide, mais une étape valide SANS son geste. Le geste disparaît sans un
 * mot, et la vérification passe sur l'écran laissé par l'étape précédente.
 * Le schéma le refusait déjà ; le chargeur doit dire la même chose que lui.
 */
const SCENARIO_KEYS = ['id', 'title', 'tags', 'platforms', 'given', 'steps'];
const STEP_KEYS = ['id', 'do', 'per_platform', 'only', 'expect', 'capture'];
const GIVEN_KEYS = ['fixtures', 'state'];

/** Distance d'édition, pour suggérer la clé voulue derrière une faute de frappe. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const lowered = key.toLowerCase();
    let near: string | undefined;
    let best = 3;
    for (const candidate of allowed) {
      const d = distance(lowered, candidate);
      if (d < best) {
        best = d;
        near = candidate;
      }
    }
    throw new ScenarioError(
      `${where}: unknown key "${key}"${near === undefined ? '' : ` — did you mean "${near}"?`} (allowed: ${allowed.join(', ')})`,
      path,
    );
  }
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
  // Avant l'id : « Id: » mal orthographié doit être nommé, pas rapporté comme
  // un id absent.
  assertKnownKeys(
    value,
    STEP_KEYS,
    typeof id === 'string' && id.length > 0 ? `step "${id}"` : `step ${index}`,
    path,
  );
  if (typeof id !== 'string' || id.length === 0) {
    throw new ScenarioError(`step ${index} has no id`, path);
  }

  const step: Step = { id };

  /**
   * Une intention présente mais vide n'est pas une intention absente qu'on
   * aurait mal écrite : ignorée, elle ferait de l'étape une simple
   * vérification, et son geste disparaîtrait sans un mot. `do:` sans valeur
   * (null en YAML), `do: ""`, `per_platform: {}` ou une plateforme mal
   * orthographiée sont donc refusés, comme le fait le schéma.
   */
  if (value['do'] !== undefined) {
    if (!isIntent(value['do'])) {
      throw new ScenarioError(`step "${id}": "do" must be a non-empty string`, path);
    }
    step.do = value['do'];
  }
  if (value['per_platform'] !== undefined) {
    const perPlatform = value['per_platform'];
    if (!isRecord(perPlatform) || Object.keys(perPlatform).length === 0) {
      throw new ScenarioError(
        `step "${id}": "per_platform" must map at least one platform to an intent`,
        path,
      );
    }
    for (const [platform, intent] of Object.entries(perPlatform)) {
      if (!TARGET_PLATFORMS.has(platform)) {
        throw new ScenarioError(
          `step "${id}": unknown platform "${platform}" in per_platform (web, mobile, ios, android)`,
          path,
        );
      }
      if (!isIntent(intent)) {
        throw new ScenarioError(
          `step "${id}": per_platform.${platform} must be a non-empty string`,
          path,
        );
      }
    }
    step.per_platform = perPlatform as NonNullable<Step['per_platform']>;
  }
  if (Array.isArray(value['only'])) step.only = value['only'] as NonNullable<Step['only']>;
  if (value['expect'] !== undefined) {
    const expect = value['expect'];
    // Une assertion vide n'affirme rien, et une liste vide non plus : la
    // compter comme une vérification laisserait passer une étape qui ne prouve
    // rien.
    const valid = Array.isArray(expect)
      ? expect.length > 0 && expect.every(isIntent)
      : isIntent(expect);
    if (!valid) {
      throw new ScenarioError(
        `step "${id}": "expect" must be a non-empty string or a non-empty list of them`,
        path,
      );
    }
    step.expect = expect as NonNullable<Step['expect']>;
  }
  if (isRecord(value['capture'])) step.capture = value['capture'] as Record<string, string>;

  /**
   * Une étape agit, vérifie, ou les deux. Sans intention, elle ne fait que
   * vérifier l'écran laissé par la précédente — « la commande figure dans
   * l'historique » quand l'historique est déjà affiché. L'exiger obligeait à
   * inventer un geste, qui était ensuite joué et versionné comme s'il
   * prouvait quelque chose.
   *
   * Ni l'un ni l'autre, en revanche, n'est pas une étape : on refuse plutôt
   * que de laisser passer un bloc vide qui serait compté comme vert.
   */
  if (step.do === undefined && step.per_platform === undefined && !verifies(step)) {
    throw new ScenarioError(
      `step "${id}" has neither do nor per_platform, nor expect or capture — a step must act, verify, or both`,
      path,
    );
  }

  return step;
}

export function parseScenario(raw: string, path = '<inline>'): Scenario {
  assertNoBooleanKeys(raw, path);

  const doc: unknown = parse(raw);
  if (!isRecord(doc)) throw new ScenarioError('the document is empty or malformed', path);
  assertKnownKeys(doc, SCENARIO_KEYS, 'scenario', path);
  if (isRecord(doc['given'])) assertKnownKeys(doc['given'], GIVEN_KEYS, 'given', path);

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
