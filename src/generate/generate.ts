import type { Action, Driver, Locator, UINode } from '../driver/types.ts';
import { evaluateCheck, extractValue, interpolate, interpolateLocator } from '../engine/assert.ts';
import { matchOne } from '../engine/match.ts';
import { suggestNearest } from '../engine/nearest.ts';
import type { ModelMessage, ModelProvider } from '../model/types.ts';
import type { Check, CaptureSpec, Resolution, StepResolution } from '../resolution/types.ts';
import { targetOf, valueOf, withValue } from '../resolution/types.ts';
import type { Scenario, Step } from '../scenario/types.ts';
import { appliesTo, expectationsOf, intentFor } from '../scenario/types.ts';
import { checksMessage, retryMessage, stepMessage, SYSTEM_PROMPT } from './prompt.ts';
import { renderTree } from './render.ts';
import { checksProposalSchema, stepProposalSchema } from './schema.ts';

export interface GenerateInput {
  scenario: Scenario;
  driver: Driver;
  provider: ModelProvider;
  /** Tentatives par phase avant d'abandonner l'étape. */
  attemptsPerStep?: number;
  appVersion?: string;
}

export interface GenerateStepReport {
  stepId: string;
  intent: string;
  status: 'resolved' | 'failed' | 'skipped';
  attempts: number;
  rejections: string[];
}

export interface GenerateResult {
  status: 'complete' | 'incomplete';
  resolution: Resolution;
  steps: GenerateStepReport[];
}

const ACTION_KINDS = new Set([
  'navigate', 'click', 'fill', 'select', 'press', 'scrollTo', 'hover', 'swipe', 'expectDialog',
  'upload',
]);

interface Proposal {
  actions: Action[];
  captures: Record<string, CaptureSpec>;
  assertions: Record<string, Check>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Contrôle structurel minimal.
 *
 * La validation profonde est délibérément laissée à la vérification qui suit :
 * un locator mal formé échouera à se résoudre contre l'application réelle, ce
 * qui est un signal plus sûr qu'un schéma — et le message d'erreur qui revient
 * au modèle décrit alors l'application, pas le schéma.
 */
function asProposal(output: unknown): Proposal | null {
  if (!isRecord(output)) return null;
  const actions = output['actions'];
  if (!Array.isArray(actions) || actions.length === 0) return null;
  for (const action of actions) {
    if (!isRecord(action) || typeof action['kind'] !== 'string') return null;
    if (!ACTION_KINDS.has(action['kind'])) return null;
  }
  return {
    actions: actions as Action[],
    captures: isRecord(output['captures']) ? (output['captures'] as Record<string, CaptureSpec>) : {},
    assertions: isRecord(output['assertions'])
      ? (output['assertions'] as Record<string, Check>)
      : {},
  };
}

function asChecks(output: unknown): Pick<Proposal, 'captures' | 'assertions'> | null {
  if (!isRecord(output)) return null;
  return {
    captures: isRecord(output['captures']) ? (output['captures'] as Record<string, CaptureSpec>) : {},
    assertions: isRecord(output['assertions'])
      ? (output['assertions'] as Record<string, Check>)
      : {},
  };
}

/** Chaque cible est confrontée à l'application avant d'agir. */
async function verifyActions(driver: Driver, actions: Action[]): Promise<string[]> {
  const errors: string[] = [];

  /**
   * L'arbre n'est observé que si une cible se perd, et une seule fois pour
   * toutes. Rendre au modèle les libellés proches de ce qu'il a proposé
   * raccourcit la boucle : il corrige un mot au lieu de re-deviner l'écran.
   */
  let observed: UINode | null = null;
  const suggest = async (target: Locator): Promise<string> => {
    observed ??= (await driver.observe({ interactiveOnly: true })).root;
    return suggestNearest(observed, target);
  };

  for (const [index, action] of actions.entries()) {
    const target = targetOf(action);
    if (target === null) continue;

    let outcome;
    try {
      outcome = await driver.resolve(target);
    } catch (error) {
      errors.push(`action ${index} : ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (outcome.found) {
      if (outcome.usedFallback) {
        errors.push(
          `action ${index} : seul le repli technique a fonctionné, le ciblage sémantique est faux`,
        );
      }
      continue;
    }
    if (outcome.reason === 'ambiguous') {
      errors.push(
        `action ${index} : cible ambiguë, ${outcome.matches} éléments correspondent — précise avec "within" ou "nth"`,
      );
    } else if (outcome.reason === 'not-visible') {
      errors.push(`action ${index} : cible trouvée mais non visible`);
    } else {
      errors.push(
        `action ${index} : aucun élément ne correspond à cette cible${await suggest(target.primary)}`,
      );
    }
  }

  return errors;
}

interface CheckOutcome {
  errors: string[];
  produced: Record<string, string>;
}

/**
 * Les captures et les assertions sont vérifiées contre l'écran réellement
 * obtenu. Pour une assertion, la vérité terrain est qu'elle **passe ici** :
 * on enregistre un état connu comme bon, donc une assertion fausse à la
 * génération serait un test faux pour toujours.
 */
function verifyChecks(
  root: UINode,
  location: string,
  bag: Readonly<Record<string, string>>,
  proposal: Pick<Proposal, 'captures' | 'assertions'>,
  step: Step,
): CheckOutcome {
  const errors: string[] = [];
  const produced: Record<string, string> = {};
  const merged: Record<string, string> = { ...bag };

  for (const name of Object.keys(step.capture ?? {})) {
    const spec = proposal.captures[name];
    if (spec === undefined) {
      errors.push(`capture « ${name} » manquante`);
      continue;
    }
    try {
      const node = matchOne(root, interpolateLocator(spec.from, merged));
      if (node === null) {
        errors.push(`capture « ${name} » : cible introuvable ou ambiguë sur cet écran`);
        continue;
      }
      const value = extractValue(node, spec.extract);
      if (value === null) {
        errors.push(`capture « ${name} » : valeur illisible avec extract="${spec.extract}"`);
        continue;
      }
      produced[name] = value;
      merged[name] = value;
    } catch (error) {
      errors.push(`capture « ${name} » : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const expectations = expectationsOf(step);
  for (const expectation of expectations) {
    const check = proposal.assertions[expectation];
    if (check === undefined) {
      errors.push(`assertion « ${expectation} » manquante — recopie le texte exactement en clé`);
      continue;
    }
    try {
      const result = evaluateCheck(check, { root, location, bag: merged });
      if (!result.ok) {
        errors.push(`assertion « ${expectation} » fausse sur cet écran : ${result.reason}`);
      }
    } catch (error) {
      errors.push(
        `assertion « ${expectation} » : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const key of Object.keys(proposal.assertions)) {
    if (!expectations.includes(key)) {
      errors.push(`assertion « ${key} » inconnue du scénario — ne l'invente pas`);
    }
  }

  return { errors, produced };
}

export async function generateResolution(input: GenerateInput): Promise<GenerateResult> {
  const { scenario, driver, provider } = input;
  const attempts = input.attemptsPerStep ?? 3;
  const platform = driver.platform;

  const steps: Record<string, StepResolution> = {};
  const reports: GenerateStepReport[] = [];
  const bag: Record<string, string> = {};
  let aborted = false;

  for (const step of scenario.steps) {
    const intent = intentFor(step, platform);

    if (aborted || !appliesTo(step, platform)) {
      reports.push({ stepId: step.id, intent, status: 'skipped', attempts: 0, rejections: [] });
      continue;
    }

    const rejections: string[] = [];
    let used = 0;

    await driver.settle();
    const before = await driver.observe({ interactiveOnly: true });

    const conversation: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: stepMessage({
              intent,
              tree: renderTree(before.root),
              location: before.location,
              expectations: expectationsOf(step),
              captureNames: Object.keys(step.capture ?? {}),
              availableCaptures: bag,
            }),
          },
        ],
      },
    ];

    let proposal: Proposal | null = null;

    while (used < attempts && proposal === null) {
      used += 1;
      const response = await provider.complete({
        system: SYSTEM_PROMPT,
        messages: conversation,
        responseSchema: stepProposalSchema(),
      });

      const candidate = asProposal(response.output);
      const errors =
        candidate === null
          ? ['réponse mal formée : « actions » doit être une liste non vide de gestes connus']
          : await verifyActions(driver, candidate.actions);

      if (errors.length === 0 && candidate !== null) {
        proposal = candidate;
        break;
      }

      rejections.push(...errors);
      conversation.push(
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
        { role: 'user', content: [{ type: 'text', text: retryMessage(errors) }] },
      );
    }

    if (proposal === null) {
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections });
      aborted = true;
      continue;
    }

    try {
      // Les valeurs sont interpolées ici aussi : sans ça, la génération
      // saisirait « {{env.MOT_DE_PASSE}} » littéralement dans le champ et
      // résoudrait l'étape suivante contre un écran de connexion refusée.
      for (const action of proposal.actions) {
        const template = valueOf(action);
        await driver.act(
          template === null ? action : withValue(action, interpolate(template, bag)),
        );
      }
    } catch (error) {
      rejections.push(error instanceof Error ? error.message : String(error));
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections });
      aborted = true;
      continue;
    }

    await driver.settle();
    let after = await driver.observe({ interactiveOnly: true });
    let checks: Pick<Proposal, 'captures' | 'assertions'> = proposal;
    let outcome = verifyChecks(after.root, after.location, bag, checks, step);

    const checksConversation: ModelMessage[] = [];
    while (outcome.errors.length > 0 && used < attempts) {
      used += 1;
      rejections.push(...outcome.errors);

      if (checksConversation.length === 0) {
        checksConversation.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: checksMessage({
                tree: renderTree(after.root),
                location: after.location,
                expectations: expectationsOf(step),
                captureNames: Object.keys(step.capture ?? {}),
                availableCaptures: bag,
              }),
            },
          ],
        });
      } else {
        checksConversation.push({
          role: 'user',
          content: [{ type: 'text', text: retryMessage(outcome.errors) }],
        });
      }

      const response = await provider.complete({
        system: SYSTEM_PROMPT,
        messages: checksConversation,
        responseSchema: checksProposalSchema(),
      });

      checksConversation.push({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(response.output) }],
      });

      const candidate = asChecks(response.output);
      if (candidate === null) {
        outcome = { errors: ['réponse mal formée'], produced: {} };
        continue;
      }

      after = await driver.observe({ interactiveOnly: true });
      checks = candidate;
      outcome = verifyChecks(after.root, after.location, bag, checks, step);
    }

    if (outcome.errors.length > 0) {
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections });
      aborted = true;
      continue;
    }

    Object.assign(bag, outcome.produced);

    const resolved: StepResolution = { actions: proposal.actions, healedAt: null };
    if (Object.keys(checks.captures).length > 0) resolved.captures = checks.captures;
    if (Object.keys(checks.assertions).length > 0) resolved.assertions = checks.assertions;
    steps[step.id] = resolved;

    reports.push({ stepId: step.id, intent, status: 'resolved', attempts: used, rejections });
  }

  const resolution: Resolution = {
    scenario: scenario.id,
    platform,
    recordedAt: new Date().toISOString(),
    steps,
  };
  if (input.appVersion !== undefined) resolution.appVersion = input.appVersion;

  return {
    status: reports.some((report) => report.status === 'failed') ? 'incomplete' : 'complete',
    resolution,
    steps: reports,
  };
}
