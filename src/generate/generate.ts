import type { Action, Driver, Locator, UINode } from '../driver/types.ts';
import {
  evaluateCheck,
  extractValue,
  interpolate,
  interpolateLocator,
  SecretRegistry,
  usesEnv,
} from '../engine/assert.ts';
import { formatIssue, platformIssue } from '../engine/consistency.ts';
import { resolveUpload } from '../engine/files.ts';
import { matchNodes, matchOne } from '../engine/match.ts';
import { suggestNearest } from '../engine/nearest.ts';
import { supports } from '../engine/run.ts';
import type { ModelMessage, ModelProvider } from '../model/types.ts';
import type { Check, CaptureSpec, Resolution, StepResolution } from '../resolution/types.ts';
import { isObservationCheck, targetOf, valueOf, withValue } from '../resolution/types.ts';
import {
  checkBaseFor,
  isAbsoluteUrl,
  isBaselessNavigation,
  relativeToBase,
  screenAgnosticPrefix,
} from '../resolution/url.ts';
import type { Scenario, Step } from '../scenario/types.ts';
import {
  appliesTo,
  expectationsOf,
  intentFor,
  isEmptyOn,
  isVerificationOnly,
} from '../scenario/types.ts';
import { checksMessage, retryMessage, stepMessage, systemPrompt } from './prompt.ts';
import {
  actionIssue,
  captureIssue,
  checkIssue,
  fallbackIssue,
  tautologicalCapture,
  tautologicalCheck,
} from './proposal.ts';
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
  /**
   * Ce qui a été accepté mais mérite d'être lu : une adresse laissée absolue,
   * une cible retrouvée par sa propre valeur. Séparé des rejets, pour que
   * « attempt rejected » ne décrive jamais une proposition retenue.
   */
  warnings: string[];
}

export interface GenerateResult {
  status: 'complete' | 'incomplete';
  resolution: Resolution;
  steps: GenerateStepReport[];
}

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
 * Contrôle de forme des gestes, clé par clé.
 *
 * Longtemps minimal, au motif qu'un locator mal formé échouerait de lui-même
 * contre l'application. C'est faux pour une clé de trop : ignorée à la
 * résolution, elle était versionnée telle quelle, dans un fichier que le
 * schéma publié refuse. La forme est donc contrôlée ici (`proposal.ts`), et la
 * vérification contre l'application suit.
 *
 * Rend la proposition, ou les raisons de son refus. Une liste vide a son
 * propre message : sur une étape qui a une intention, zéro geste n'est pas une
 * forme mal écrite mais une intention jamais accomplie — un vert qui ne
 * prouverait rien. Captures et assertions sont contrôlées avec l'écran
 * obtenu, dans `verifyChecks`.
 */
function asProposal(output: unknown): Proposal | string[] {
  if (!isRecord(output)) return [MALFORMED];
  const actions = output['actions'];
  if (!Array.isArray(actions)) return [MALFORMED];
  if (actions.length === 0) {
    return ['"actions" is empty, but this step has an intent: propose the gestures that carry it out'];
  }
  const issues = actions
    .map((action, index) => actionIssue(action, `action ${index}`))
    .filter((issue): issue is string => issue !== null);
  if (issues.length > 0) return issues;
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

/**
 * Ce que ce pilote refuserait au rejeu, refusé ici au modèle.
 *
 * Sans ce contrôle, le refus tombait au moment d'agir : l'étape échouait sans
 * reprise, et la génération s'arrêtait là. Rendu en rejet, il laisse au modèle
 * — à qui la consigne parle du web — le tour qu'il faut pour se corriger.
 */
function verifyGestures(driver: Driver, actions: Action[]): string[] {
  const errors: string[] = [];
  for (const [index, action] of actions.entries()) {
    if (!supports(driver, action)) {
      errors.push(`action ${index}: "${action.kind}" is not supported on ${driver.platform} — use another gesture`);
      continue;
    }
    // Hors du web, il n'y a pas de base : un chemin relatif ne désigne rien.
    if (action.kind === 'navigate' && driver.platform !== 'web' && !isBaselessNavigation(action.to)) {
      errors.push(
        `action ${index}: navigate "${action.to}" is a relative path, which means nothing on ${driver.platform} — use a deep link (myapp://…), "." or "/" to relaunch the app, or reach the screen with gestures`,
      );
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
        continue;
      }
      const mismatch = await fallbackIssue(target, outcome.node, async () => {
        observed ??= (await driver.observe({ interactiveOnly: true })).root;
        return observed;
      });
      if (mismatch !== null) errors.push(`action ${index}: ${mismatch}`);
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
  /** Rapportés à l'utilisateur si la proposition est retenue, jamais rendus au modèle. */
  warnings?: string[];
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
  const warnings: string[] = [];
  const produced: Record<string, string> = {};
  const merged: Record<string, string> = { ...bag };

  for (const name of Object.keys(step.capture ?? {})) {
    const spec = proposal.captures[name];
    if (spec === undefined) {
      errors.push(`capture "${name}" missing`);
      continue;
    }
    const malformed = captureIssue(spec, `capture "${name}"`);
    if (malformed !== null) {
      errors.push(malformed);
      continue;
    }
    try {
      const from = interpolateLocator(spec.from, merged);
      const node = matchOne(root, from);
      if (node === null) {
        errors.push(`capture "${name}": target not found or ambiguous on this screen`);
        continue;
      }
      const value = extractValue(node, spec.extract);
      if (value === null) {
        errors.push(`capture "${name}": unreadable value with extract="${spec.extract}"`);
        continue;
      }
      if (tautologicalCapture(from, spec.extract, node, value)) {
        warnings.push(
          `capture "${name}" is located by the very value it reads ("${value}"): when that value changes, replay reports "target not found" instead of reading the new one`,
        );
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
    const malformed = checkIssue(check, `assertion "${expectation}"`);
    if (malformed !== null) {
      errors.push(malformed);
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
      if (
        (check.check === 'textEquals' ||
          check.check === 'textContains' ||
          check.check === 'numberEquals') &&
        tautological(check, root, merged)
      ) {
        warnings.push(
          `assertion "${expectation}" is located by the very value it asserts ("${usesEnv(String(check.value)) ? '***' : interpolate(String(check.value), merged)}"): when that value changes, replay reports "no element" instead of "expected …, observed …"`,
        );
      }
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
  return {
    errors: errors.map((error) => secrets.redact(error)),
    produced,
    warnings: warnings.map((warning) => secrets.redact(warning)),
  };
}

/** Voir `tautologicalCheck` : la cible retrouvée par la valeur même qu'elle affirme. */
function tautological(
  check: Extract<Check, { check: 'textEquals' | 'textContains' | 'numberEquals' }>,
  root: UINode,
  bag: Readonly<Record<string, string>>,
): boolean {
  const target = interpolateLocator(check.target, bag);
  const expected = interpolate(String(check.value), bag);
  return tautologicalCheck(check.check, target, expected, matchNodes(root, target));
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
    // Une forme invalide est refusée plus loin, avec son motif : ne pas lever ici.
    if (!isRecord(check as unknown)) continue;
    if (check.check !== 'urlEquals' && check.check !== 'urlContains') continue;
    const value: unknown = check.value;
    if (typeof value !== 'string' || value.includes('{{')) continue;
    if (!isAbsoluteUrl(value)) {
      /**
       * Un chemin d'origine — « / », « /orders » — désigne la même origine, mais
       * se résout contre la RACINE du serveur, pas contre la base : sous une
       * base à préfixe (« …/app/ »), « / » affirmerait une page hors de
       * l'application. Réécrit comme une adresse absolue, et par la même règle
       * que `navigate` (« / » devient « . ») : un chemin hors du chemin de base
       * reste un chemin d'origine. `urlContains` n'est pas touché : « /login »
       * y est un fragment, pas une adresse.
       */
      if (check.check !== 'urlEquals' || !value.startsWith('/') || value.startsWith('//')) continue;
      if (baseUrl === undefined) continue;
      const relative = relativeToBase(value, baseUrl);
      if (relative !== null) out[key] = { ...check, value: relative };
      continue;
    }

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

/**
 * Refuse un `urlContains` vrai sur tous les écrans de l'application.
 *
 * Hors du web, chaque adresse commence par l'identifiant d'application : le
 * modèle le recopie volontiers, et « on est sur l'écran des commandes »
 * devient une sous-chaîne de ce préfixe, vraie partout. La vérification ne
 * peut pas l'attraper — l'assertion passe ici, comme elle passera sur
 * n'importe quel autre écran. C'est le pendant du refus de l'adresse absolue
 * sur le web : dans les deux cas, une vérification d'adresse qui ne peut pas
 * échouer.
 */
function screenAgnosticChecks(
  assertions: Record<string, Check>,
  prefix: string | undefined,
): string[] {
  if (prefix === undefined) return [];
  const errors: string[] = [];
  for (const [key, check] of Object.entries(assertions)) {
    if (!isRecord(check as unknown) || check.check !== 'urlContains') continue;
    const value: unknown = check.value;
    // Une adresse absolue est déjà rendue au modèle par portableChecks : la
    // signaler deux fois noierait le motif.
    if (typeof value !== 'string' || value.includes('{{') || isAbsoluteUrl(value)) continue;
    if (!prefix.includes(value)) continue;
    errors.push(
      `assertion "${key}": urlContains "${value}" only names the application ("${prefix}"), which every screen shares, so it can never fail — use urlEquals on the whole location, or urlContains with the screen title`,
    );
  }
  return errors;
}

/**
 * Refuse un `urlContains` qui épingle l'hôte de développement.
 *
 * « localhost:4173/commandes » n'a pas de schéma : il échappe donc à la
 * réécriture des adresses absolues, mais il fixe l'hôte et le port tout aussi
 * sûrement. Vert sur la machine qui l'a écrit, rouge partout ailleurs — et ce
 * rouge-là accuse l'application, pas le fichier.
 */
function hostBoundChecks(assertions: Record<string, Check>, baseUrl: string | undefined): string[] {
  if (baseUrl === undefined) return [];
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return [];
  }
  if (host === '') return [];
  const errors: string[] = [];
  for (const [key, check] of Object.entries(assertions)) {
    if (!isRecord(check as unknown) || check.check !== 'urlContains') continue;
    const value: unknown = check.value;
    if (typeof value !== 'string' || value.includes('{{') || isAbsoluteUrl(value)) continue;
    if (!value.includes(host)) continue;
    errors.push(
      `assertion "${key}": urlContains "${value}" names the host "${host}", which only matches on this host and port — use urlEquals (stored relative to the root), or a fragment of the path`,
    );
  }
  return errors;
}

export async function generateResolution(input: GenerateInput): Promise<GenerateResult> {
  const { scenario, driver, provider } = input;
  const attempts = input.attemptsPerStep ?? 5;
  const baseDir = input.baseDir ?? process.cwd();
  const platform = driver.platform;

  // Un parcours sans étape ici produirait une résolution vide, que le rejeu
  // jouerait en vert sans rien faire. Refusé avant le moindre appel au modèle.
  const refused = platformIssue(scenario, platform);
  if (refused !== null) throw new Error(formatIssue(refused));

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
      reports.push({ stepId: step.id, intent, status: 'skipped', attempts: 0, rejections: [], warnings: [] });
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
        warnings: [],
      });
      aborted = true;
      continue;
    }

    const rejections: string[] = [];
    const warnings: string[] = [];
    let used = 0;
    // Un avertissement, pas un rejet : il est rapporté une fois, quel que soit
    // le nombre de tours qui le recroisent.
    // Masqué comme les rejets : l'adresse avertie peut porter un secret déjà
    // saisi, et `qai resolve` imprime ces lignes.
    const warn = (message: string): void => {
      const redacted = secrets.redact(message);
      if (!warnings.includes(redacted)) warnings.push(redacted);
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
          system: systemPrompt(platform),
          messages: conversation,
          responseSchema: stepProposalSchema(platform),
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
        Array.isArray(candidate)
          ? candidate
          : [
              ...verifyEnvTemplates(candidate.actions, intent),
              ...verifyGestures(driver, candidate.actions),
              ...(await verifyActions(driver, candidate.actions)),
            ];
      // Masqué avant de rejoindre le rapport ET la conversation : un rejet peut
      // recopier un nom d'écran, et un secret d'une étape antérieure y figure.
      const errors = raw.map((error) => secrets.redact(error));

      if (errors.length === 0 && !Array.isArray(candidate)) {
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
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections, warnings });
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
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections, warnings });
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
      const agnostic = [
        ...screenAgnosticChecks(
          portable.assertions,
          screenAgnosticPrefix(platform, screen.location, checkBase),
        ),
        ...hostBoundChecks(portable.assertions, checkBase),
      ];
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
          errors: [
            ...[...portable.errors, ...agnostic].map((error) => secrets.redact(error)),
            ...verified.errors,
          ],
          produced: verified.produced,
          warnings: verified.warnings ?? [],
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
          system: systemPrompt(platform),
          messages: checksConversation,
          responseSchema: checksProposalSchema(platform),
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
      // Le dernier refus n'a plus de tour pour revenir au modèle, mais c'est
      // lui qui explique l'échec : sans lui, l'étape échouait sans motif.
      rejections.push(...outcome.errors);
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections, warnings });
      aborted = true;
      continue;
    }

    for (const warning of outcome.warnings ?? []) warn(warning);
    Object.assign(bag, outcome.produced);

    // Déjà relativisées avant l'exécution : on versionne exactement ce qui a
    // été joué.
    const resolved: StepResolution = { actions: proposal.actions, healedAt: null };
    if (Object.keys(checks.captures).length > 0) resolved.captures = checks.captures;
    if (Object.keys(checks.assertions).length > 0) resolved.assertions = checks.assertions;
    steps[step.id] = resolved;

    reports.push({ stepId: step.id, intent, status: 'resolved', attempts: used, rejections, warnings });
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
