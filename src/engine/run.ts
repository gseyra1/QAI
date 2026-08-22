import type {
  Action,
  Driver,
  Platform,
  ResolvedTarget,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import { targetOf, valueOf, withTarget, withValue } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { appliesTo, expectationsOf, intentFor, platformMatches } from '../scenario/types.ts';
import {
  evaluateCheck,
  extractValue,
  interpolate,
  InterpolationError,
  interpolateLocator,
  redact,
  usesEnv,
} from './assert.ts';
import { matchOne } from './match.ts';
import { suggestNearest } from './nearest.ts';

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
  /** Identifiant rendu par `captureArtifact`, pour l'échec de cette étape. */
  screenshot?: string;
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
  /**
   * Fenêtre pendant laquelle une assertion encore fausse est réévaluée.
   *
   * Le repos réseau ne signe pas la fin du rendu : une scène 3D, une animation
   * d'entrée ou un module chargé à la demande arrivent après. Sans cette
   * fenêtre, une application de ce type ne peut affirmer aucun écran.
   */
  assertTimeoutMs?: number;
  /**
   * Range une capture d'écran et rend son identifiant.
   *
   * Le moteur n'écrit pas sur disque : il rend les octets, l'appelant décide
   * où ils vont. Une capture n'est prise qu'à l'échec — 300 Kio par étape
   * rendraient une suite de cinquante parcours ingérable.
   */
  captureArtifact?: (name: string, bytes: Uint8Array) => Promise<string>;
}

function supports(driver: Driver, action: Action): boolean {
  if (action.kind === 'hover') return driver.capabilities.hover;
  if (action.kind === 'swipe') return driver.capabilities.swipe;
  if (action.kind === 'navigate') return driver.capabilities.navigateByUrl;
  if (action.kind === 'expectDialog') return driver.capabilities.dialogs;
  return true;
}

/** Agir sur un élément désactivé n'a pas de sens ; le survol et le défilement, si. */
const NEEDS_ENABLED = new Set(['click', 'fill', 'select']);

function describeTarget(target: ResolvedTarget): string {
  const { name, role } = target.primary;
  if (typeof name === 'string') return name;
  if (name !== undefined) return name.contains;
  return role ?? 'the target';
}

function describeOutcome(outcome: Extract<ResolveOutcome, { found: false }>): string {
  if (outcome.reason === 'ambiguous') {
    return `ambiguous target: ${outcome.matches} elements match, the cache must be regenerated`;
  }
  if (outcome.reason === 'not-visible') return 'target found but not visible';
  return 'target not found';
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
  bag: Readonly<Record<string, string>>;
}

async function performActions(actions: Action[], context: ActionsContext): Promise<ActionsOutcome> {
  const { driver, healer } = context;
  const heals: AppliedHeal[] = [];
  const warnings: string[] = [];
  /** Valeurs résolues depuis l'environnement, à effacer de tout message. */
  const secrets: string[] = [];

  for (const [index, original] of actions.entries()) {
    if (!supports(driver, original)) {
      return { ok: false, error: `action "${original.kind}" not supported on ${driver.platform}` };
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
        const repairable = healer !== undefined && context.healCount < context.healBudget;

        /**
         * Un seul instantané sert les deux usages : suggérer les libellés
         * proches, et alimenter le réparateur. Observer deux fois doublerait le
         * coût du chemin d'échec sans rien apprendre de plus.
         *
         * Sur une cible ambiguë, il n'y a rien à suggérer : le nom correspond
         * déjà, trop bien même.
         */
        const snapshot =
          outcome.reason === 'no-match' || repairable
            ? await driver.observe({ screenshot: repairable })
            : null;

        const failure =
          describeOutcome(outcome) +
          (snapshot !== null && outcome.reason === 'no-match'
            ? suggestNearest(snapshot.root, target.primary)
            : '');

        if (healer === undefined) return { ok: false, error: failure };
        if (!repairable) {
          return {
            ok: false,
            error: `${failure} — heal budget exhausted (${context.healBudget})`,
          };
        }

        const healed = await healer.heal({
          stepId: context.stepId,
          actionIndex: index,
          intent: context.intent,
          target,
          outcome,
          snapshot: snapshot ?? (await driver.observe({ screenshot: true })),
        });

        if (!healed.healed) {
          return { ok: false, error: `${failure} — repair impossible: ${healed.reason}` };
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
        return { ok: false, error: `"${describeTarget(target)}" is present but disabled` };
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
            : { healed: false as const, reason: 'no healer available' };

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
            `"${label}" was only reached through its technical fallback: the application's accessibility has degraded and this targeting will not survive the mobile port`,
          );
        }
      }
    }

    /**
     * La valeur est interpolée juste avant d'agir, jamais à l'écriture.
     *
     * C'est ce qui permet à `{{env.MOT_DE_PASSE}}` de ne jamais exister
     * ailleurs que dans la mémoire du processus : le fichier de résolution vit
     * dans git, et un secret recopié dedans y resterait pour toujours. Le même
     * mécanisme rend `{{capture}}` utilisable dans une saisie — saisir dans un
     * champ ce qu'on vient de lire à l'écran précédent.
     */
    const template = valueOf(action);
    if (template !== null) {
      try {
        const resolved = interpolate(template, context.bag);
        if (usesEnv(template)) secrets.push(resolved);
        action = withValue(action, resolved);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    try {
      await driver.act(action);
    } catch (error) {
      // Un message de driver peut recopier ce qui a été saisi ; un rapport
      // d'échec, lui, finit dans les journaux d'une CI.
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: redact(message, secrets) };
    }
  }

  /**
   * Une politique armée que personne n'a consommée signale presque toujours
   * que le bouton de confirmation a disparu de l'application : le clic a
   * réussi, mais sans le dialogue attendu. Le parcours ne prouve alors plus ce
   * qu'il croit prouver, et se taire laisserait passer la régression.
   */
  const pending = context.driver.takePendingDialogs?.() ?? 0;
  if (pending > 0) {
    warnings.push(
      `${pending} dialogue(s) attendu(s) ne se sont pas présentés : la confirmation native a peut-être disparu de l'application`,
    );
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
    bag,
  };
  let aborted = false;

  const scenarioApplies =
    scenario.platforms === undefined ||
    scenario.platforms.some((declared) => platformMatches(declared, platform));

  for (const step of scenario.steps) {
    const intent = intentFor(step, platform);
    const stepStarted = Date.now();

    /**
     * Une capture n'est prise qu'à l'échec, et son absence ne doit jamais
     * transformer un échec de test en erreur d'outil : le diagnostic est un
     * bonus, le verdict est l'essentiel.
     */
    const shoot = async (): Promise<string | undefined> => {
      if (input.captureArtifact === undefined) return undefined;
      try {
        const snapshot = await driver.observe({ screenshot: true });
        if (snapshot.screenshot === undefined) return undefined;
        return await input.captureArtifact(`${scenario.id}-${step.id}.png`, snapshot.screenshot);
      } catch {
        return undefined;
      }
    };

    const fail = async (error: string): Promise<void> => {
      const screenshot = await shoot();
      steps.push({
        stepId: step.id,
        intent,
        status: 'failed',
        failures: [],
        error,
        ...(screenshot !== undefined ? { screenshot } : {}),
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
      await fail('no cached resolution for this step');
      continue;
    }

    context.stepId = step.id;
    context.intent = intent;
    const outcome = await performActions(cached.actions, context);
    if (!outcome.ok) {
      await fail(outcome.error);
      continue;
    }

    await driver.settle();

    /**
     * Captures puis assertions, sur un écran donné.
     *
     * Les deux vivent dans la même passe parce qu'une assertion peut référencer
     * une capture : les relire ensemble garantit qu'elles parlent du même
     * instant, ce qui serait faux si on rejouait les unes sans les autres.
     */
    const evaluate = (
      root: UINode,
      location: string,
    ): { captureErrors: string[]; failures: AssertionFailure[] } => {
      // Une capture qui échoue n'interrompt pas l'étape : c'est le plus souvent
      // le symptôme d'une assertion fausse, et masquer celle-ci priverait le
      // rapport de son information la plus utile.
      const captureErrors: string[] = [];
      for (const [name, spec] of Object.entries(cached.captures ?? {})) {
        try {
          const node = matchOne(root, interpolateLocator(spec.from, bag));
          if (node === null) {
            captureErrors.push(`capture "${name}": target not found or ambiguous`);
            continue;
          }
          const value = extractValue(node, spec.extract);
          if (value === null) {
            captureErrors.push(`capture "${name}": unreadable value`);
            continue;
          }
          bag[name] = value;
        } catch (error) {
          captureErrors.push(
            `capture "${name}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // À partir d'ici, plus aucune réparation n'est possible : une assertion
      // qui échoue est une régression de l'application, pas un test périmé.
      const failures: AssertionFailure[] = [];
      for (const assertion of expectationsOf(step)) {
        const check = cached.assertions?.[assertion];
        if (check === undefined) {
          failures.push({ assertion, reason: 'no machine form in cache' });
          continue;
        }
        try {
          const result = evaluateCheck(check, { root, location, bag });
          if (!result.ok) failures.push({ assertion, reason: result.reason });
        } catch (error) {
          failures.push({
            assertion,
            reason: error instanceof InterpolationError ? error.message : String(error),
          });
        }
      }

      return { captureErrors, failures };
    };

    /**
     * Réévaluer tant que quelque chose est faux, dans une fenêtre bornée.
     *
     * Ce n'est pas une tolérance sur ce qui est affirmé : l'assertion n'est ni
     * réécrite ni assouplie, on lui laisse seulement le temps d'être vraie.
     * Sans ça, tout écran dont le rendu se termine après le repos réseau — une
     * scène 3D, un module chargé à la demande — serait indémontrable.
     */
    let snapshot = await driver.observe();
    let { captureErrors, failures } = evaluate(snapshot.root, snapshot.location);
    const deadline = Date.now() + (input.assertTimeoutMs ?? 5000);

    while ((captureErrors.length > 0 || failures.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Ré-observer rend aussi l'URL courante : une redirection qui arrive
      // après le repos réseau est ainsi vue par les vérifications d'URL.
      snapshot = await driver.observe();
      ({ captureErrors, failures } = evaluate(snapshot.root, snapshot.location));
    }

    const broken = failures.length > 0 || captureErrors.length > 0;
    const report: StepReport = {
      stepId: step.id,
      intent,
      status: broken ? 'failed' : outcome.heals.length > 0 ? 'healed' : 'passed',
      failures,
      durationMs: Date.now() - stepStarted,
    };
    if (captureErrors.length > 0) report.error = captureErrors.join('; ');
    if (outcome.heals.length > 0) {
      report.healNotes = outcome.heals.map((heal) => heal.note);
      applied.push(...outcome.heals);
    }
    if (outcome.warnings.length > 0) report.warnings = outcome.warnings;
    if (broken) {
      const screenshot = await shoot();
      if (screenshot !== undefined) report.screenshot = screenshot;
    }
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
