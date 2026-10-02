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
import { isObservationCheck, targetOf, valueOf, withValue } from '../resolution/types.ts';
import { checkBaseFor, isAbsoluteUrl, relativeToBase } from '../resolution/url.ts';
import type { Scenario, Step } from '../scenario/types.ts';
import {
  appliesTo,
  expectationsOf,
  intentFor,
  isEmptyOn,
  isVerificationOnly,
} from '../scenario/types.ts';
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
   * Racine de l'application testée. Sert à ramener une navigation absolue, ou
   * une vérification d'adresse absolue, à une forme relative : une résolution
   * versionnée doit rejouer ailleurs que sur la machine qui l'a écrite.
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

const MALFORMED = 'malformed response: "actions" must be a non-empty list of known gestures';

/**
 * Contrôle structurel minimal.
 *
 * La validation profonde est délibérément laissée à la vérification qui suit :
 * un locator mal formé échouera à se résoudre contre l'application réelle, ce
 * qui est un signal plus sûr qu'un schéma — et le message d'erreur qui revient
 * au modèle décrit alors l'application, pas le schéma.
 *
 * Rend la proposition, ou la raison de son refus. Une liste vide a son propre
 * message : sur une étape qui a une intention, zéro geste n'est pas une forme
 * mal écrite mais une intention jamais accomplie — un vert qui ne prouverait
 * rien.
 */
function asProposal(output: unknown): Proposal | string {
  if (!isRecord(output)) return MALFORMED;
  const actions = output['actions'];
  if (!Array.isArray(actions)) return MALFORMED;
  if (actions.length === 0) {
    return '"actions" is empty, but this step has an intent: propose the gestures that carry it out';
  }
  for (const action of actions) {
    if (!isRecord(action) || typeof action['kind'] !== 'string') return MALFORMED;
    if (!ACTION_KINDS.has(action['kind'])) return MALFORMED;
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
  baseUrl: string | undefined,
  observable: boolean,
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
    // Un pilote qui n'observe ni réseau ni console rendrait ces vérifications
    // vraies faute d'avoir regardé : les écrire figerait un vert sans preuve.
    if (!observable && isObservationCheck(check)) {
      errors.push(
        `assertion "${expectation}": ${check.check} cannot be observed on this platform — no network or console activity is reported here`,
      );
      continue;
    }
    try {
      const result = evaluateCheck(check, {
        root,
        location,
        bag: merged,
        secrets,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
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
 * délibérée hors de l'application, pas une adresse recopiée par accident. Les
 * règles elles-mêmes vivent dans `resolution/url.ts`, partagées avec les
 * vérifications d'adresse.
 */
function relativize(action: Action, baseUrl: string | undefined, warn: (m: string) => void): Action {
  if (action.kind !== 'navigate') return action;
  if (baseUrl === undefined) {
    // `generateResolution` est exporté : un harnais qui omet `baseUrl`
    // n'obtient aucune relativisation. Se taire lui livrerait une résolution
    // liée à sa machine sans qu'il l'apprenne jamais.
    if (isAbsoluteUrl(action.to)) {
      warn(
        `navigate "${action.to}" is saved as an absolute URL: pass baseUrl to generateResolution so the resolution replays elsewhere`,
      );
    }
    return action;
  }
  const to = relativeToBase(action.to, baseUrl);
  return to === null ? action : { ...action, to };
}

/**
 * Ramène un `urlEquals` absolu à la forme relative à la base.
 *
 * Même défaut que `navigate`, même remède, mêmes règles : le modèle recopie
 * l'adresse observée, port compris, et l'assertion passe ici puis échoue
 * partout ailleurs. Appliqué AVANT la vérification, pour que ce qui est
 * versionné soit ce qui a été prouvé — et seulement à la génération : une
 * réparation change la façon d'atteindre un élément, jamais ce qui est
 * affirmé. Le sens est intact : la valeur relative est résolue contre la base
 * puis comparée strictement, l'adresse attendue est la même.
 *
 * `urlContains` n'est PAS réécrit, mais rendu au modèle. Une sous-chaîne
 * absolue ancre l'origine et le début du chemin ; la forme relative les perd —
 * « http://h/orders » devenu « orders » est vrai sur « /login?next=/orders »,
 * précisément la redirection qu'une vérification de droits d'accès doit
 * attraper. Aucune réécriture d'une sous-chaîne n'en garde le sens : c'est au
 * modèle de choisir entre l'égalité et un fragment qu'il assume.
 *
 * Un gabarit (« {{…}} ») n'est pas touché : sa valeur n'existe qu'à
 * l'exécution. Une autre origine non plus, comme pour `navigate`.
 */
function portableChecks(
  assertions: Record<string, Check>,
  baseUrl: string | undefined,
  warn: (message: string) => void,
): { assertions: Record<string, Check>; errors: string[] } {
  const out: Record<string, Check> = {};
  const errors: string[] = [];

  for (const [key, check] of Object.entries(assertions)) {
    out[key] = check;
    if (check.check !== 'urlEquals' && check.check !== 'urlContains') continue;
    const value: unknown = check.value;
    if (typeof value !== 'string' || value.includes('{{') || !isAbsoluteUrl(value)) continue;

    if (baseUrl === undefined) {
      warn(
        `${check.check} "${value}" is saved as an absolute URL: pass baseUrl to generateResolution so the resolution replays elsewhere`,
      );
      continue;
    }
    const relative = relativeToBase(value, baseUrl);
    if (relative === null) continue;

    if (check.check === 'urlContains') {
      errors.push(
        `assertion "${key}": urlContains "${value}" is an absolute address of the application under test, which only matches on this host and port — use urlEquals (stored relative to the root, compared exactly), or urlContains with a fragment that alone identifies the page`,
      );
      continue;
    }
    out[key] = { ...check, value: relative };
  }

  return { assertions: out, errors };
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
  // Même base qu'au rejeu pour les vérifications d'adresse : web seulement.
  const checkBase = checkBaseFor(platform, input.baseUrl);
  // Un pilote qui ne rapporte ni réseau ni console ne peut pas prouver leur
  // absence : les vérifications d'observation y sont refusées dès l'écriture.
  const observable = driver.drainObservations !== undefined;
  let aborted = false;

  for (const step of scenario.steps) {
    const intent = intentFor(step, platform);
    /**
     * Sans intention, rien à demander au modèle côté gestes : la phase A est
     * sautée, et la résolution n'aura AUCUNE action. C'est garanti ici, pas
     * confié à la consigne — un geste inventé pour une étape qui ne fait que
     * vérifier serait joué et versionné comme s'il prouvait quelque chose.
     */
    const verificationOnly = isVerificationOnly(step, platform);

    if (aborted || !appliesTo(step, platform)) {
      reports.push({ stepId: step.id, intent, status: 'skipped', attempts: 0, rejections: [] });
      continue;
    }

    // Ni geste ni vérification ici : résolue, l'étape serait un vert vide.
    // On ne demande rien au modèle, il n'y a rien à lui demander.
    if (isEmptyOn(step, platform)) {
      reports.push({
        stepId: step.id,
        intent,
        status: 'failed',
        attempts: 0,
        rejections: [
          `no intent and nothing to verify on ${platform}: add expect or capture, or restrict the step with "only"`,
        ],
      });
      aborted = true;
      continue;
    }

    const rejections: string[] = [];
    let used = 0;
    // Un avertissement, pas un rejet : il est rapporté une fois, quel que soit
    // le nombre de tours qui le recroisent.
    // Masqué comme les rejets : l'adresse avertie peut porter un secret déjà
    // saisi, et `qai resolve` imprime ces lignes.
    const warn = (message: string): void => {
      const redacted = secrets.redact(message);
      if (!rejections.includes(redacted)) rejections.push(redacted);
    };

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

    let proposal: Proposal | null = verificationOnly
      ? { actions: [], captures: {}, assertions: {} }
      : null;

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
        typeof candidate === 'string'
          ? [candidate]
          : [
              ...verifyEnvTemplates(candidate.actions, intent),
              ...(await verifyActions(driver, candidate.actions)),
            ];
      // Masqué avant de rejoindre le rapport ET la conversation : un rejet peut
      // recopier un nom d'écran, et un secret d'une étape antérieure y figure.
      const errors = raw.map((error) => secrets.redact(error));

      if (errors.length === 0 && typeof candidate !== 'string') {
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
      // Web seulement : ailleurs, une navigation est un lien profond ou une
      // relance, et l'entrée de lancement (un bundle) n'est pas une base.
      actions:
        platform === 'web'
          ? proposal.actions.map((action) => relativize(action, input.baseUrl, warn))
          : proposal.actions,
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

    /**
     * Réécrit les adresses, PUIS vérifie : la forme prouvée contre l'écran est
     * celle qui sera versionnée.
     */
    const assess = (
      screen: { root: UINode; location: string },
      candidate: Pick<Proposal, 'captures' | 'assertions'>,
    ): { checks: Pick<Proposal, 'captures' | 'assertions'>; outcome: CheckOutcome } => {
      // La base des vérifications, pas celle des navigations : réécrire une
      // adresse que le rejeu ne résoudra pas la rendrait fausse partout.
      const portable = portableChecks(
        candidate.assertions,
        checkBase,
        platform === 'web' ? warn : () => {},
      );
      const checks = { captures: candidate.captures, assertions: portable.assertions };
      const verified = verifyChecks(
        screen.root,
        screen.location,
        bag,
        checks,
        step,
        secrets,
        checkBase,
        observable,
      );
      return {
        checks,
        outcome: {
          errors: [...portable.errors.map((error) => secrets.redact(error)), ...verified.errors],
          produced: verified.produced,
        },
      };
    };

    let { checks, outcome } = assess(after, proposal);

    const checksConversation: ModelMessage[] = [];
    // Une étape qui ne fait que vérifier n'a encore rien proposé : ses
    // manques initiaux sont la question posée au modèle, pas un rejet.
    let proposed = !verificationOnly;
    while (outcome.errors.length > 0 && used < attempts) {
      used += 1;
      if (proposed) rejections.push(...outcome.errors);
      proposed = true;

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
                verificationOnly,
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

      // Le schéma de ce tour n'a pas de champ « actions », mais un
      // fournisseur sans décodage contraint peut en renvoyer : sur une étape
      // qui ne fait que vérifier, ce serait un geste inventé.
      const output: unknown = response.output;
      if (
        verificationOnly &&
        isRecord(output) &&
        Array.isArray(output['actions']) &&
        output['actions'].length > 0
      ) {
        outcome = {
          errors: [
            'this step has no intent, it only verifies the current screen: return no "actions", only captures and assertions',
          ],
          produced: {},
        };
        continue;
      }

      const candidate = asChecks(output);
      if (candidate === null) {
        outcome = { errors: ['malformed response'], produced: {} };
        continue;
      }

      after = await driver.observe({ interactiveOnly: true });
      ({ checks, outcome } = assess(after, candidate));
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
