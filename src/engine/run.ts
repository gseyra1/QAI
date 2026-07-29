import type {
  Action,
  Driver,
  Platform,
  ResolvedTarget,
  ResolveOutcome,
  UISnapshot,
} from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import { targetOf, withTarget } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { appliesTo, expectationsOf, intentFor, platformMatches } from '../scenario/types.ts';
import { evaluateCheck, extractValue, InterpolationError, interpolateLocator } from './assert.ts';
import { matchOne } from './match.ts';

export interface AssertionFailure {
  assertion: string;
  reason: string;
}

export type StepStatus = 'passed' | 'healed' | 'failed' | 'skipped';

/**
 * Une réparation appliquée, sous une forme réinjectable dans le fichier de
 * résolution. Sans ça, la réparation ne serait qu'une ligne de rapport : le
 * diff relu en revue — l'argument de confiance du produit — n'existerait pas.
 */
export interface AppliedHeal {
  stepId: string;
  actionIndex: number;
  target: ResolvedTarget;
  note: string;
  /** Le ciblage sémantique a échoué ; seul le repli technique a fonctionné. */
  degraded: boolean;
}

export interface StepReport {
  stepId: string;
  intent: string;
  status: StepStatus;
  failures: AssertionFailure[];
  error?: string;
  healNotes?: string[];
  /** N'empêche pas le succès, mais doit remonter au client. */
  warnings?: string[];
  durationMs: number;
}

/** Trois états, pas deux : « réparé » n'est pas un succès silencieux. */
export type ScenarioStatus = 'passed' | 'healed' | 'failed';

export interface ScenarioReport {
  scenarioId: string;
  title: string;
  platform: Platform;
  status: ScenarioStatus;
  steps: StepReport[];
  captures: Record<string, string>;
  heals: AppliedHeal[];
  healCount: number;
  startedAt: string;
  durationMs: number;
}

export interface HealRequest {
  stepId: string;
  actionIndex: number;
  intent: string;
  target: ResolvedTarget;
  outcome: Extract<ResolveOutcome, { found: false }>;
  snapshot: UISnapshot;
}

export type HealResult =
  | { healed: true; target: ResolvedTarget; note: string; degraded?: boolean }
  | { healed: false; reason: string };

/**
 * Point d'entrée de l'étage 2. Le moteur ne l'appelle que sur un échec de
 * *résolution de cible* — jamais sur une assertion fausse. Cette restriction
 * est structurelle et non configurable : un réparateur autorisé à retoucher les
 * assertions apprendrait à faire passer les régressions.
 */
export interface Healer {
  heal(request: HealRequest): Promise<HealResult>;
}

export interface RunInput {
  scenario: Scenario;
  resolution: Resolution;
  driver: Driver;
  healer?: Healer;
  /** Au-delà, on s'arrête : une dérive massive n'est pas un test périmé. */
  healBudget?: number;
}

function supports(driver: Driver, action: Action): boolean {
  if (action.kind === 'hover') return driver.capabilities.hover;
  if (action.kind === 'swipe') return driver.capabilities.swipe;
  if (action.kind === 'navigate') return driver.capabilities.navigateByUrl;
  return true;
}

/** Agir sur un élément désactivé n'a pas de sens ; le survol et le défilement, si. */
const NEEDS_ENABLED = new Set(['click', 'fill', 'select']);

function describeTarget(target: ResolvedTarget): string {
  const { name, role } = target.primary;
  if (typeof name === 'string') return name;
  if (name !== undefined) return name.contains;
  return role ?? 'la cible';
}

function describeOutcome(outcome: Extract<ResolveOutcome, { found: false }>): string {
  if (outcome.reason === 'ambiguous') {
    return `cible ambiguë : ${outcome.matches} éléments correspondent, le cache doit être régénéré`;
  }
  if (outcome.reason === 'not-visible') return 'cible trouvée mais non visible';
  return 'cible introuvable';
}

type ActionsOutcome =
  | { ok: true; heals: AppliedHeal[]; warnings: string[] }
  | { ok: false; error: string };

interface ActionsContext {
  driver: Driver;
  healer: Healer | undefined;
  healBudget: number;
  healCount: number;
  stepId: string;
  intent: string;
}

async function performActions(actions: Action[], context: ActionsContext): Promise<ActionsOutcome> {
  const { driver, healer } = context;
  const heals: AppliedHeal[] = [];
  const warnings: string[] = [];

  for (const [index, original] of actions.entries()) {
    if (!supports(driver, original)) {
      return { ok: false, error: `action « ${original.kind} » non supportée sur ${driver.platform}` };
    }

    let action = original;
    const target = targetOf(action);

    if (target !== null) {
      let outcome = await driver.resolve(target);

      if (!outcome.found && outcome.reason !== 'ambiguous') {
        // Le réessai après repos écarte l'instabilité de rendu avant d'engager
        // un appel de modèle. Une cible ambiguë, elle, ne se stabilisera pas.
        await driver.settle();
        outcome = await driver.resolve(target);
      }

      if (!outcome.found) {
        const failure = describeOutcome(outcome);

        if (healer === undefined) return { ok: false, error: failure };
        if (context.healCount >= context.healBudget) {
          return {
            ok: false,
            error: `${failure} — budget de réparation épuisé (${context.healBudget})`,
          };
        }

        const snapshot = await driver.observe({ screenshot: true });
        const healed = await healer.heal({
          stepId: context.stepId,
          actionIndex: index,
          intent: context.intent,
          target,
          outcome,
          snapshot,
        });

        if (!healed.healed) {
          return { ok: false, error: `${failure} — réparation impossible : ${healed.reason}` };
        }

        action = withTarget(action, healed.target);
        heals.push({
          stepId: context.stepId,
          actionIndex: index,
          target: healed.target,
          note: healed.note,
          degraded: healed.degraded === true,
        });
        context.healCount += 1;
      } else if (NEEDS_ENABLED.has(action.kind) && outcome.node.state.disabled === true) {
        // Trouvé mais inerte : c'est l'application qui est en cause, pas le
        // cache. Aucune réparation n'a de sens, et le message doit le dire
        // plutôt que de laisser remonter un délai d'attente du driver.
        return { ok: false, error: `« ${describeTarget(target)} » est présent mais désactivé` };
      } else if (outcome.usedFallback) {
        // Le ciblage sémantique est mort, seul le repli technique tient. Le
        // parcours fonctionne, donc échouer serait crier au loup — mais se
        // taire laisserait chaque locator dégrader vers un identifiant de test,
        // et la portabilité mobile mourir en silence. On répare tant qu'on peut.
        const label = describeTarget(target);
        const restored =
          healer !== undefined && context.healCount < context.healBudget
            ? await healer.heal({
                stepId: context.stepId,
                actionIndex: index,
                intent: context.intent,
                target,
                outcome: { found: false, reason: 'no-match', matches: 0 },
                snapshot: await driver.observe({ screenshot: true }),
              })
            : { healed: false as const, reason: 'aucun réparateur disponible' };

        if (restored.healed) {
          action = withTarget(action, restored.target);
          heals.push({
            stepId: context.stepId,
            actionIndex: index,
            target: restored.target,
            note: restored.note,
            degraded: restored.degraded === true,
          });
          context.healCount += 1;
        } else {
          warnings.push(
            `« ${label} » n'a été atteint que par son repli technique : l'accessibilité de l'application s'est dégradée et ce ciblage ne survivra pas au portage mobile`,
          );
        }
      }
    }

    try {
      await driver.act(action);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { ok: true, heals, warnings };
}

export async function runScenario(input: RunInput): Promise<ScenarioReport> {
  const { scenario, resolution, driver, healer } = input;
  const healBudget = input.healBudget ?? 3;
  const platform = driver.platform;
  const startedAt = new Date().toISOString();
  const started = Date.now();

  const bag: Record<string, string> = {};
  const steps: StepReport[] = [];
  const applied: AppliedHeal[] = [];
  const context: ActionsContext = {
    driver,
    healer,
    healBudget,
    healCount: 0,
    stepId: '',
    intent: '',
  };
  let aborted = false;

  const scenarioApplies =
    scenario.platforms === undefined ||
    scenario.platforms.some((declared) => platformMatches(declared, platform));

  for (const step of scenario.steps) {
    const intent = intentFor(step, platform);
    const stepStarted = Date.now();

    const fail = (error: string): void => {
      steps.push({
        stepId: step.id,
        intent,
        status: 'failed',
        failures: [],
        error,
        durationMs: Date.now() - stepStarted,
      });
      aborted = true;
    };

    if (aborted || !scenarioApplies || !appliesTo(step, platform)) {
      steps.push({ stepId: step.id, intent, status: 'skipped', failures: [], durationMs: 0 });
      continue;
    }

    const cached = resolution.steps[step.id];
    if (cached === undefined) {
      fail('aucune résolution en cache pour cette étape');
      continue;
    }

    context.stepId = step.id;
    context.intent = intent;
    const outcome = await performActions(cached.actions, context);
    if (!outcome.ok) {
      fail(outcome.error);
      continue;
    }

    await driver.settle();
    const snapshot = await driver.observe();

    // Une capture qui échoue n'interrompt pas l'étape : c'est le plus souvent le
    // symptôme d'une assertion fausse, et masquer celle-ci priverait le rapport
    // de son information la plus utile.
    const captureErrors: string[] = [];
    for (const [name, spec] of Object.entries(cached.captures ?? {})) {
      try {
        const node = matchOne(snapshot.root, interpolateLocator(spec.from, bag));
        if (node === null) {
          captureErrors.push(`capture « ${name} » : cible introuvable ou ambiguë`);
          continue;
        }
        const value = extractValue(node, spec.extract);
        if (value === null) {
          captureErrors.push(`capture « ${name} » : valeur illisible`);
          continue;
        }
        bag[name] = value;
      } catch (error) {
        captureErrors.push(
          `capture « ${name} » : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // À partir d'ici, plus aucune réparation n'est possible : une assertion qui
    // échoue est une régression de l'application, pas un test périmé.
    const failures: AssertionFailure[] = [];
    for (const assertion of expectationsOf(step)) {
      const check = cached.assertions?.[assertion];
      if (check === undefined) {
        failures.push({ assertion, reason: 'aucune forme machine en cache' });
        continue;
      }
      try {
        const result = evaluateCheck(check, snapshot.root, bag);
        if (!result.ok) failures.push({ assertion, reason: result.reason });
      } catch (error) {
        failures.push({
          assertion,
          reason: error instanceof InterpolationError ? error.message : String(error),
        });
      }
    }

    const broken = failures.length > 0 || captureErrors.length > 0;
    const report: StepReport = {
      stepId: step.id,
      intent,
      status: broken ? 'failed' : outcome.heals.length > 0 ? 'healed' : 'passed',
      failures,
      durationMs: Date.now() - stepStarted,
    };
    if (captureErrors.length > 0) report.error = captureErrors.join(' ; ');
    if (outcome.heals.length > 0) {
      report.healNotes = outcome.heals.map((heal) => heal.note);
      applied.push(...outcome.heals);
    }
    if (outcome.warnings.length > 0) report.warnings = outcome.warnings;
    steps.push(report);

    if (broken) aborted = true;
  }

  const failed = steps.some((step) => step.status === 'failed');
  const healed = steps.some((step) => step.status === 'healed');

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    platform,
    status: failed ? 'failed' : healed ? 'healed' : 'passed',
    steps,
    captures: bag,
    heals: applied,
    healCount: context.healCount,
    startedAt,
    durationMs: Date.now() - started,
  };
}
