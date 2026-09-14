import type { Action, Driver, Locator, UINode } from '../driver/types.ts';
import {
  evaluateCheck,
  extractValue,
  interpolate,
  interpolateLocator,
  SecretRegistry,
  usesEnv,
} from '../engine/assert.ts';
import { resolveUpload } from '../engine/files.ts';
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
  /**
   * Dossier du scénario, d'où se résolvent les fichiers à téléverser.
   *
   * Le rejeu résout depuis là ; la génération, elle, laissait Playwright
   * résoudre depuis le répertoire courant. Le même chemin ne désignait donc
   * pas le même fichier selon la commande, et une résolution écrite depuis la
   * racine du dépôt cassait au premier rejeu.
   */
  baseDir?: string;
  /**
   * Racine de l'application testée. Sert à ramener une navigation absolue à un
   * chemin relatif : une résolution versionnée doit rejouer ailleurs que sur la
   * machine qui l'a écrite.
   */
  baseUrl?: string;
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

const ENV_TEMPLATE = /\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Une variable d'environnement que l'intention ne nomme pas est refusée.
 *
 * Le modèle généralise volontiers la règle des secrets à toute valeur à
 * saisir : « renseigner l'adresse avec le jeu de données client-fr » est
 * devenu `{{env.QAI_USER}}`. Le cas bruyant — la variable n'existe pas —
 * échoue de lui-même. Le cas SILENCIEUX est pire : si la CI définit bien
 * `QAI_USER` pour le parcours de connexion, l'identifiant est saisi dans le
 * champ adresse sans erreur, et comme la valeur vient de l'environnement le
 * registre la masque en `***` dans chaque rapport — mauvaise valeur, et
 * invisible pour qui relit.
 *
 * C'est garantissable, donc c'est garanti : on ne le confie pas à la consigne.
 */
function verifyEnvTemplates(actions: Action[], intent: string): string[] {
  const errors: string[] = [];
  for (const [index, action] of actions.entries()) {
    const value = valueOf(action);
    if (value === null) continue;
    ENV_TEMPLATE.lastIndex = 0;
    for (const match of value.matchAll(ENV_TEMPLATE)) {
      const name = match[1] as string;
      if (!intent.includes(name)) {
        errors.push(
          `action ${index}: {{env.${name}}} — the intent does not name this variable, so it is not the value being asked for; read it off the screen or use the scenario's own data`,
        );
      }
    }
  }
  return errors;
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
      errors.push(`action ${index}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (outcome.found) {
      if (outcome.usedFallback) {
        errors.push(
          `action ${index}: only the technical fallback worked, the semantic targeting is wrong`,
        );
      }
      continue;
    }
    if (outcome.reason === 'ambiguous') {
      errors.push(
        `action ${index}: ambiguous target, ${outcome.matches} elements match — disambiguate with "within" or "nth"`,
      );
    } else if (outcome.reason === 'not-visible') {
      errors.push(`action ${index}: target found but not visible`);
    } else {
      errors.push(
        `action ${index}: no element matches this target${await suggest(target.primary)}`,
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
  secrets: SecretRegistry,
): CheckOutcome {
  const errors: string[] = [];
  const produced: Record<string, string> = {};
  const merged: Record<string, string> = { ...bag };

  for (const name of Object.keys(step.capture ?? {})) {
    const spec = proposal.captures[name];
    if (spec === undefined) {
      errors.push(`capture "${name}" missing`);
      continue;
    }
    try {
      const node = matchOne(root, interpolateLocator(spec.from, merged));
      if (node === null) {
        errors.push(`capture "${name}": target not found or ambiguous on this screen`);
        continue;
      }
      const value = extractValue(node, spec.extract);
      if (value === null) {
        errors.push(`capture "${name}": unreadable value with extract="${spec.extract}"`);
        continue;
      }
      produced[name] = value;
      merged[name] = value;
    } catch (error) {
      errors.push(`capture "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Symétrique du refus des assertions inventées : une capture hors scénario
  // serait persistée sans jamais être vérifiée, et casserait un rejeu sain.
  for (const name of Object.keys(proposal.captures)) {
    if (step.capture?.[name] === undefined) {
      errors.push(`capture "${name}" not in the scenario — do not invent it`);
    }
  }

  const expectations = expectationsOf(step);
  for (const expectation of expectations) {
    const check = proposal.assertions[expectation];
    if (check === undefined) {
      errors.push(`assertion "${expectation}" missing — copy the assertion text exactly as the key`);
      continue;
    }
    try {
      const result = evaluateCheck(check, { root, location, bag: merged, secrets });
      if (!result.ok) {
        errors.push(`assertion "${expectation}" false on this screen: ${result.reason}`);
      }
    } catch (error) {
      errors.push(
        `assertion "${expectation}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const key of Object.keys(proposal.assertions)) {
    if (!expectations.includes(key)) {
      errors.push(`assertion "${key}" not in the scenario — do not invent it`);
    }
  }

  // Un dernier passage : les erreurs de capture recopient un message de driver,
  // et un secret d'une étape antérieure a pu s'y glisser. Les raisons
  // d'assertion sont déjà masquées par evaluateCheck ; ceci couvre le reste.
  return { errors: errors.map((error) => secrets.redact(error)), produced };
}

/**
 * Ce qu'on renvoie au modèle quand son fournisseur a levé.
 *
 * Le message d'exception dit souvent précisément ce qui manque — « réponse
 * tronquée », « JSON invalide » — donc le lui rendre vaut mieux que de le
 * remplacer par une formule générique.
 */
function modelFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `your answer could not be read (${message}) — return a single valid JSON object, nothing else`;
}

/**
 * Ramène une navigation à un chemin relatif à la racine testée.
 *
 * Le modèle recopie volontiers l'URL qu'il voit — port de développement
 * compris. Écrite telle quelle dans un fichier versionné, elle ne rejoue que
 * sur la machine qui l'a générée : le port change, et le parcours meurt sur un
 * « network failure » qui ne dit rien de l'application. La vérification ne peut
 * pas l'attraper, puisque l'URL absolue fonctionne parfaitement à la
 * génération — c'est plus tard, ailleurs, qu'elle casse.
 *
 * Une URL d'un AUTRE domaine est conservée : c'est alors une navigation
 * délibérée hors de l'application, pas une adresse recopiée par accident.
 */
function relativize(action: Action, baseUrl: string | undefined, warn: (m: string) => void): Action {
  if (action.kind !== 'navigate') return action;
  if (baseUrl === undefined) {
    // `generateResolution` est exporté : un harnais qui omet `baseUrl`
    // n'obtient aucune relativisation. Se taire lui livrerait une résolution
    // liée à sa machine sans qu'il l'apprenne jamais.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(action.to)) {
      warn(
        `navigate "${action.to}" is saved as an absolute URL: pass baseUrl to generateResolution so the resolution replays elsewhere`,
      );
    }
    return action;
  }
  try {
    const root = normalizedBase(baseUrl);
    const target = new URL(action.to, root);
    if (target.origin !== root.origin) return action;

    /**
     * Relatif à la BASE, pas à l'origine.
     *
     * Une application servie sous un préfixe — « https://staging/ecole/ » —
     * perdait ce préfixe : un chemin absolu « /ecole/eleves » écrit à la
     * génération devient « https://autre-hote/ecole/eleves » au rejeu si la
     * base change de préfixe, et « /eleves » écrasait carrément le préfixe.
     * Une forme relative suit la base où qu'elle soit montée.
     */
    if (!target.pathname.startsWith(root.pathname)) {
      return { ...action, to: `${target.pathname}${target.search}${target.hash}` };
    }
    const relative = target.pathname.slice(root.pathname.length);
    // La base elle-même ne donne pas une chaîne vide, qui se lirait comme un
    // champ oublié : « . » est la référence relative au dossier courant, et
    // `new URL('.', base)` rend exactement la base.
    const to = relative === '' && target.search === '' && target.hash === '' ? '.' : relative;
    return { ...action, to: `${to}${target.search}${target.hash}` };
  } catch {
    // Ni une URL absolue ni un chemin résolvable : on n'y touche pas, la
    // vérification en dira plus que nous.
    return action;
  }
}

/**
 * La base, terminée par « / ».
 *
 * Sans la barre finale, `new URL('eleves', 'https://x/ecole')` rend
 * `https://x/eleves` : le dernier segment est traité comme un fichier, pas
 * comme un dossier, et le préfixe disparaît silencieusement.
 */
function normalizedBase(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

export async function generateResolution(input: GenerateInput): Promise<GenerateResult> {
  const { scenario, driver, provider } = input;
  const attempts = input.attemptsPerStep ?? 5;
  const baseDir = input.baseDir ?? process.cwd();
  const platform = driver.platform;

  const steps: Record<string, StepResolution> = {};
  const reports: GenerateStepReport[] = [];
  const bag: Record<string, string> = {};
  // Comme au rejeu : un secret saisi via {{env.X}} ne doit fuir ni dans les
  // rejets rapportés, ni — surtout — dans les messages renvoyés au fournisseur
  // de modèle, qui est un tiers.
  const secrets = new SecretRegistry();
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
              captures: step.capture ?? {},
              availableCaptures: bag,
            }),
          },
        ],
      },
    ];

    let proposal: Proposal | null = null;

    while (used < attempts && proposal === null) {
      used += 1;
      let response;
      try {
        response = await provider.complete({
          system: SYSTEM_PROMPT,
          messages: conversation,
          responseSchema: stepProposalSchema(),
        });
      } catch (error) {
        // Une réponse illisible est un rejet, pas une panne du moteur. Un
        // fournisseur sans décodage contraint par schéma lève ici — JSON.parse
        // échoue chez lui, avant toute validation — et c'est son mode de panne
        // NORMAL, pas un cas théorique. Laisser filer l'exception abandonnait
        // tous les scénarios restants sur une seule réponse tronquée.
        rejections.push(secrets.redact(error instanceof Error ? error.message : String(error)));
        conversation.push({
          role: 'user',
          content: [{ type: 'text', text: retryMessage([modelFailure(error)]) }],
        });
        continue;
      }

      const candidate = asProposal(response.output);
      const raw =
        candidate === null
          ? ['malformed response: "actions" must be a non-empty list of known gestures']
          : [
              ...verifyEnvTemplates(candidate.actions, intent),
              ...(await verifyActions(driver, candidate.actions)),
            ];
      // Masqué avant de rejoindre le rapport ET la conversation : un rejet peut
      // recopier un nom d'écran, et un secret d'une étape antérieure y figure.
      const errors = raw.map((error) => secrets.redact(error));

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

    /**
     * Relativisé AVANT d'exécuter, pas au moment d'écrire.
     *
     * Sinon la génération valide une forme — l'URL absolue que le modèle a
     * proposée — et en versionne une autre, jamais exécutée. C'est exactement
     * la classe de défaut que cette PR corrige par ailleurs : vert ici, cassé
     * au rejeu. En jouant la forme versionnée, la génération la prouve.
     */
    proposal = {
      ...proposal,
      actions: proposal.actions.map((action) =>
        relativize(action, input.baseUrl, (message) => rejections.push(message)),
      ),
    };

    try {
      // Les valeurs sont interpolées ici aussi : sans ça, la génération
      // saisirait « {{env.MOT_DE_PASSE}} » littéralement dans le champ et
      // résoudrait l'étape suivante contre un écran de connexion refusée.
      for (const action of proposal.actions) {
        // Même cadrage qu'au rejeu, et au même moment : un chemin refusé doit
        // l'être pendant qu'on écrit la résolution, pas trois semaines plus
        // tard en CI. Le refus remonte en rejet, donc le modèle en est informé
        // et peut proposer autre chose.
        const staged =
          action.kind === 'upload'
            ? { ...action, files: action.files.map((file) => resolveUpload(baseDir, file)) }
            : action;
        const template = valueOf(staged);
        if (template === null) {
          await driver.act(staged);
        } else {
          const resolved = interpolate(template, bag);
          if (usesEnv(template)) secrets.add(resolved);
          await driver.act(withValue(staged, resolved));
        }
      }
    } catch (error) {
      rejections.push(secrets.redact(error instanceof Error ? error.message : String(error)));
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections });
      aborted = true;
      continue;
    }

    await driver.settle();
    let after = await driver.observe({ interactiveOnly: true });
    let checks: Pick<Proposal, 'captures' | 'assertions'> = proposal;
    let outcome = verifyChecks(after.root, after.location, bag, checks, step, secrets);

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
                captures: step.capture ?? {},
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

      let response;
      try {
        response = await provider.complete({
          system: SYSTEM_PROMPT,
          messages: checksConversation,
          responseSchema: checksProposalSchema(),
        });
      } catch (error) {
        // Même traitement qu'en phase A : un fournisseur qui lève consomme une
        // tentative et reçoit l'erreur, il n'interrompt pas la génération.
        outcome = { errors: [modelFailure(error)], produced: {} };
        continue;
      }

      checksConversation.push({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(response.output) }],
      });

      const candidate = asChecks(response.output);
      if (candidate === null) {
        outcome = { errors: ['malformed response'], produced: {} };
        continue;
      }

      after = await driver.observe({ interactiveOnly: true });
      checks = candidate;
      outcome = verifyChecks(after.root, after.location, bag, checks, step, secrets);
    }

    if (outcome.errors.length > 0) {
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections });
      aborted = true;
      continue;
    }

    Object.assign(bag, outcome.produced);

    // Déjà relativisées avant l'exécution : on versionne exactement ce qui a
    // été joué.
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
