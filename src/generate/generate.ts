import { derivesPruned, pruneInteractive } from '../driver/prune.ts';
import type { Action, Driver, Locator, UINode } from '../driver/types.ts';
import {
  evaluateCheck,
  captureSource,
  readCapture,
  interpolate,
  interpolateLocator,
  SecretRegistry,
  MASK,
  envValuesIn,
  holdsMask,
  learnDerived,
  namedEnvValues,
  usesEnv,
} from '../engine/assert.ts';
import { formatIssue, platformIssue } from '../engine/consistency.ts';
import { resolveUpload } from '../engine/files.ts';
import { matchNodes, matchOne } from '../engine/match.ts';
import { suggestNearest } from '../engine/nearest.ts';
import { supports } from '../engine/run.ts';
import { maskedProvider } from '../model/masked.ts';
import type { ModelMessage, ModelProvider } from '../model/types.ts';
import type { Check, CaptureSpec, Resolution, StepResolution } from '../resolution/types.ts';
import { isObservationCheck, targetOf, valueOf, withTarget, withValue } from '../resolution/types.ts';
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
  authoredTexts,
  expectationsOf,
  intentFor,
  isEmptyOn,
  isVerificationOnly,
} from '../scenario/types.ts';
import { checksMessage, questionMessage, retryMessage, stepMessage, systemPrompt } from './prompt.ts';
import {
  actionIssue,
  captureIssue,
  checkIssue,
  fallbackIssue,
  frozenCapture,
  frozenFrom,
  holdsNumber,
  locatorNames,
  nameLiteral,
  namedCaptures,
  readsWholeText,
  tautologicalCapture,
  tautologicalCheck,
} from './proposal.ts';
import { printedIds, renderTree } from './render.ts';
import { checksProposalSchema, stepProposalSchema } from './schema.ts';

export interface GenerateInput {
  scenario: Scenario;
  driver: Driver;
  provider: ModelProvider;
  /** Les secrets déjà appris par les parcours précédents de la commande. */
  knownSecrets?: Set<string>;
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
  /**
   * Ce que QAI a réécrit puis revérifié (`{{reference}}` à la place de la valeur
   * du jour). Dit à la relecture, mais ce n'est pas un doute : `--strict` ne
   * s'y arrête pas.
   */
  notes?: string[];
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

/**
 * Les noms de cible qui portent un nombre : « Panier 1 » cesse d'exister dès que
 * le panier change.
 *
 * Signalés, pas renvoyés au modèle : « Étape 2 » ou « Top 10 » sont des libellés,
 * et adopter une cible réécrite n'est pas sûr. Le même élément à l'écran ne garantit
 * pas le même geste (`nth` ne compte pas comme le pilote, un fragment devient
 * ambigu après un geste antérieur). Une donnée sans chiffre (« Chaise de bureau »)
 * ne se détecte pas ici.
 */
function numberedTargets(actions: Action[]): string[] {
  const names = actions.flatMap((action) => {
    const target = targetOf(action);
    return target === null ? [] : locatorNames(target.primary as Record<string, unknown>);
  });
  return [...new Set(names.filter(holdsNumber))];
}

/**
 * Ne retient de la réponse que les bornes des captures interrogées.
 *
 * La question porte sur une capture : elle ne rouvre pas les vérifications déjà
 * prouvées de l'étape, et aucune réponse ne peut la faire échouer.
 */
function boundedCaptures(
  captures: Record<string, CaptureSpec>,
  names: readonly string[],
  output: unknown,
): { captures: Record<string, CaptureSpec>; answered: boolean } {
  // Sans décodage contraint, un modèle répond parfois par les captures seules.
  const root = isRecord(output) ? output : {};
  const answer = isRecord(root['captures']) ? root['captures'] : root;
  const out = { ...captures };
  let answered = true;
  for (const name of names) {
    const spec = answer[name];
    if (!isRecord(spec)) {
      answered = false;
      continue;
    }
    const usable = (bound: unknown): bound is string => typeof bound === 'string' && bound.trim() !== '';
    const { after, before } = spec;
    if (!usable(after) && !usable(before)) continue;
    out[name] = {
      ...(captures[name] as CaptureSpec),
      ...(usable(after) ? { after } : {}),
      ...(usable(before) ? { before } : {}),
    };
  }
  return { captures: out, answered };
}

const ENV_TEMPLATE = /\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Le masque recopié dans une proposition, encodé compris.
 *
 * Masquer l'écran donne au modèle un `[secret]` qu'il recopie volontiers : saisi
 * dans un champ, et versionné dans une adresse (`compte?jeton=[secret]`), il
 * ferait passer la génération sur une valeur qui n'existe pas.
 */
/** L'élément qu'un locator désigne, ou `null` : une capture vide le rend indéfini. */
function designated(root: UINode, locator: Locator, known: Readonly<Record<string, string>>): UINode | null {
  try {
    return matchOne(root, interpolateLocator(locator, known));
  } catch {
    return null;
  }
}

/**
 * Une vérification qui compare une capture au nœud qu'elle vient de lire.
 *
 * Elle ne peut pas échouer : le nœud est comparé à lui-même, ou retrouvé par sa
 * propre valeur. Corriger le littéral n'en fait pas une preuve, donc elle reste un
 * doute, réécrite ou non.
 */
function selfComparisons(
  checks: Pick<Proposal, 'captures' | 'assertions'>,
  expectations: readonly string[],
  root: UINode,
  known: Readonly<Record<string, string>>,
): string[] {
  return expectations.flatMap((key) => {
    const check: unknown = checks.assertions[key];
    if (!isRecord(check) || !isRecord(check['target'])) return [];
    const written = JSON.stringify(check);
    const target = designated(root, check['target'] as Locator, known);
    const used = Object.entries(checks.captures).find(
      ([name, spec]) =>
        written.includes(`{{${name}}}`) &&
        isRecord(spec) &&
        isRecord(spec['from']) &&
        target !== null &&
        target === designated(root, spec.from, known),
    );
    return used === undefined
      ? []
      : [`assertion "${key}" compares {{${used[0]}}} with the element it was just read from: it cannot fail`];
  });
}

/** `selfComparisons` sur les deux arbres du regard, réunis. */
function selfCompared(
  checks: Pick<Proposal, 'captures' | 'assertions'>,
  expectations: readonly string[],
  screen: Look,
  known: Readonly<Record<string, string>>,
): string[] {
  return [
    ...new Set([
      ...selfComparisons(checks, expectations, screen.shown, known),
      ...selfComparisons(checks, expectations, screen.root, known),
    ]),
  ];
}

/** Les captures figées dans le `from` d'une capture dont la description les nomme. */
function frozenSources(
  captures: Record<string, CaptureSpec>,
  step: Step,
  bag: Readonly<Record<string, string>>,
  produced: Readonly<Record<string, string>>,
): { captures: Record<string, CaptureSpec>; rewritten: boolean; notes: string[]; warnings: string[] } {
  const out = { ...captures };
  // Les captures se lisent dans l'ordre : seules les précédentes existent au rejeu.
  const known: Record<string, string> = { ...bag };
  const notes: string[] = [];
  const warnings: string[] = [];
  let rewritten = false;
  for (const [name, spec] of Object.entries(captures)) {
    const description = step.capture?.[name];
    if (typeof description === 'string' && isRecord(spec) && isRecord(spec['from'])) {
      const frozen = frozenFrom(description, spec.from, known);
      if (frozen.note !== undefined) {
        out[name] = { ...spec, from: frozen.from };
        notes.push(frozen.note);
        rewritten = true;
      }
      if (frozen.warning !== undefined) warnings.push(frozen.warning);
    }
    const read = produced[name];
    if (read !== undefined) known[name] = read;
  }
  return { captures: out, rewritten, notes, warnings };
}

/**
 * Le masque recopié dans une proposition, encodé compris.
 *
 * Masquer l'écran donne au modèle un `[secret]` qu'il recopie volontiers : saisi
 * dans un champ, et versionné dans une adresse (`compte?jeton=[secret]`), il
 * ferait passer la génération sur une valeur qui n'existe pas.
 */
function copiedMask(proposed: unknown): string[] {
  return holdsMask(proposed)
    ? [
        `"${MASK}" stands for a secret you are not shown: never copy it. Write {{env.NAME}} in a typed value if the intent names the variable, or use { "contains": "..." } on what surrounds it`,
      ]
    : [];
}

/**
 * Une variable d'environnement que l'intention ne nomme pas est refusée.
 *
 * Le modèle généralise volontiers la règle des secrets à toute valeur à
 * saisir : « renseigner l'adresse avec le jeu de données client-fr » est
 * devenu `{{env.QAI_USER}}`. Le cas bruyant — la variable n'existe pas —
 * échoue de lui-même. Le cas SILENCIEUX est pire : si la CI définit bien
 * `QAI_USER` pour le parcours de connexion, l'identifiant est saisi dans le
 * champ adresse sans erreur, et comme la valeur vient de l'environnement le
 * registre la masque dans chaque rapport — mauvaise valeur, et
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

/**
 * Un regard sur l'écran : l'arbre montré au modèle, et celui que le rejeu relit.
 *
 * Le modèle reçoit l'arbre élagué, parce qu'il en paie chaque ligne ; le rejeu
 * cherche dans l'arbre complet, où un élément sans nom (une icône, un espaceur)
 * correspond encore à une cible. Jugée sur le seul arbre élagué, `{ role: text }`
 * était unique ici et ambiguë au rejeu, sur les mêmes données. Captures et
 * assertions doivent donc tenir sur les deux.
 */
interface Look {
  location: string;
  /** L'arbre élagué, celui que le modèle reçoit. */
  shown: UINode;
  /** L'arbre complet, celui que le rejeu relit. */
  root: UINode;
  /**
   * `shown` est tiré de `root`, dans le même instantané : un même élément y porte
   * le même identifiant. Sinon, deux lectures, sans identifiant commun : voir
   * `samePositions`.
   */
  aligned: boolean;
}

/**
 * Une lecture pour les pilotes intégrés, dont l'élagage se rejoue sur l'arbre
 * complet (`src/driver/prune.ts`) ; deux pour un pilote tiers, élaguée puis
 * complète, puisque le contrat publié ne dit rien de son élagage.
 */
async function look(driver: Driver): Promise<Look> {
  if (derivesPruned(driver)) {
    const { location, root } = await driver.observe();
    return { location, shown: pruneInteractive(root), root, aligned: true };
  }
  const pruned = await driver.observe({ interactiveOnly: true });
  const full = await driver.observe();
  return { location: pruned.location, shown: pruned.root, root: full.root, aligned: false };
}

const LEFT_OUT = 'the unnamed and hidden elements your tree leaves out';

/**
 * Mesuré avec DeepSeek (#48) : « cibler par son nom » seul faisait recopier la
 * valeur (`{ name: "42" }`, 5 exécutions sur 5), vert ici puis rouge dès que la
 * donnée change. D'où la partie stable, et l'interdit dit en toutes lettres.
 */
const STABLE_NAME_OR_CONTAINER = 'Use { "contains": "..." } on a stable part of the name, or "within" a named container';
const NAMED_CONTAINER = 'Use "within" a named container';
const NEVER_THE_VALUE = 'Never put the value itself in "name"';

/** Un locator et ses conteneurs, du plus extérieur à la cible ; chacun garde les siens. */
function levels(locator: Locator): Locator[] {
  const out: Locator[] = [];
  for (let level: Locator | undefined = locator; level !== undefined; level = level.within) out.unshift(level);
  return out;
}

/** Ce que compte la position d'un niveau : le même locator, sans elle. */
function unpositioned(locator: Locator): Locator {
  const { nth: _, ...anywhere } = locator;
  return anywhere;
}

/**
 * Deux lectures d'un pilote tiers désignent-elles le même élément ?
 *
 * Elles n'ont pas d'identifiant commun, et la valeur lue ne les relie pas quand
 * elle bouge entre les deux (un minuteur). Le contrat d'`interactiveOnly` est de
 * retirer des nœuds : sans position, ce que l'arbre élagué trouve est parmi ce
 * que trouve l'arbre complet, dans le même ordre, et à nombre égal c'est la même
 * chose. Une cible unique des deux côtés et sans position est donc le même
 * élément ; une position aussi, quand chaque niveau qui en porte une compte
 * autant de candidats des deux côtés.
 */
function samePositions(screen: Look, locator: Locator): boolean {
  return levels(locator).every((level) => {
    if (level.nth === undefined) return true;
    const anywhere = unpositioned(level);
    return matchNodes(screen.shown, anywhere).length === matchNodes(screen.root, anywhere).length;
  });
}

/**
 * Où le rejeu trouve l'élément montré, quand l'arbre du modèle n'en montre qu'un.
 *
 * Retrouvé par identité, jamais par ce qu'il lit : une copie identique dans un
 * tiroir fermé, avant lui, n'est pas lui. Donnée seulement si cette position lit
 * le même élément sur l'arbre du modèle : sinon la cible conseillée serait refusée
 * à son tour, comme 0.5.0 la refusait, et le conseil tournerait en rond.
 */
function realPosition(screen: Look, locator: Locator): number | null {
  if (!screen.aligned) return null;
  const { nth: _, ...anywhere } = locator;
  const seen = matchNodes(screen.shown, anywhere);
  if (seen.length !== 1) return null;
  const only = (seen[0] as UINode).id;
  const position = matchNodes(screen.root, anywhere).findIndex((node) => node.id === only);
  if (position < 0) return null;
  return matchNodes(screen.shown, { ...anywhere, nth: position })[0]?.id === only ? position : null;
}

/**
 * Ce que le rejeu lit autrement que l'arbre du modèle, en nombres seulement : le
 * nœud en cause n'est pas sous ses yeux, et rien de l'arbre complet n'a à partir
 * chez le fournisseur.
 *
 * La cause est cherchée du conteneur le plus extérieur à la cible : la position
 * d'un conteneur que le rejeu compte parmi plus de candidats désigne un autre
 * conteneur, et le reste en découle. Sans nœud de plus au rejeu, à aucun niveau,
 * c'est l'écran qui a changé entre les deux lectures d'un pilote tiers : dire
 * qu'il « compte aussi » des éléments serait faux. Le nombre côté modèle est
 * celui des lignes que son arbre rendu écrit : `renderTree` tait un conteneur
 * invisible et tout ce qu'il contient.
 *
 * Pas de conseil de resserrer la cible pour `absent`, qu'il rendrait vide, ni
 * pour `countAtLeast`, qu'il ne ferait jamais passer : seul le conteneur nommé
 * vaut pour ce dernier.
 */
function replayReads(screen: Look, locator: Locator, kind: string, visibleOnly = false): string {
  const printed = printedIds(screen.shown);
  const tally = (anywhere: Locator, kept: (node: UINode) => boolean) => {
    const shown = matchNodes(screen.shown, anywhere).filter(kept);
    return {
      full: matchNodes(screen.root, anywhere).filter(kept).length,
      shown: shown.length,
      printed: shown.filter((node) => printed.has(node.id)).length,
    };
  };

  for (const container of levels(locator).slice(0, -1)) {
    if (container.nth === undefined) continue;
    const counts = tally(unpositioned(container), () => true);
    if (counts.full <= counts.shown) continue;
    const counted = `replay reads ${counts.full} element(s) matching its "within" where your tree shows ${counts.printed}: it also counts ${LEFT_OUT}`;
    if (kind === 'absent') return counted;
    if (kind === 'countAtLeast') return `${counted}. ${NAMED_CONTAINER}, not "nth", which counts them too`;
    return `${counted}. ${STABLE_NAME_OR_CONTAINER}, not "nth", which counts them too. ${NEVER_THE_VALUE}`;
  }

  const counts = tally(unpositioned(locator), (node) => !visibleOnly || node.state.visible);
  const read = `replay reads ${counts.full}${visibleOnly ? ' visible' : ''} element(s) matching this target where your tree shows ${counts.printed}`;
  if (counts.full <= counts.shown) return `${read}: the screen changed between two reads of it`;
  const counted = `${read}: it also counts ${LEFT_OUT}`;
  if (kind === 'absent' || kind === 'countAtLeast') return counted;
  const position = realPosition(screen, locator);
  return position === null
    ? `${counted}. ${STABLE_NAME_OR_CONTAINER}, not "nth", which counts them too. ${NEVER_THE_VALUE}`
    : `${counted}. ${STABLE_NAME_OR_CONTAINER}; if its name is only data, keep this target and add "nth": ${position} to it, where replay finds the element you see. ${NEVER_THE_VALUE}`;
}

/** Les vérifications qui ne lisent que la première correspondance (voir `evaluateCheck`). */
const FIRST_MATCH: ReadonlySet<string> = new Set(['textEquals', 'numberEquals', 'stateIs']);

/**
 * Sur un même instantané, ce que la vérification lit sur l'arbre du modèle, le
 * rejeu doit le lire aussi : la première correspondance quand elle seule compte,
 * et chaque correspondance sinon — une position (`nth`, ou celle d'un conteneur)
 * qui désigne un autre élément au rejeu y passerait sur lui.
 */
function readsElsewhere(screen: Look, check: Check & { target: Locator }, target: Locator): boolean {
  if (!screen.aligned) return false;
  const meant = matchNodes(screen.shown, target).map((node) => node.id);
  const read = matchNodes(screen.root, target).map((node) => node.id);
  if (FIRST_MATCH.has(check.check)) return meant[0] !== read[0];
  const reread = new Set(read);
  return meant.some((id) => !reread.has(id));
}

interface CheckOutcome {
  errors: string[];
  produced: Record<string, string>;
  /** Rapportés à l'utilisateur si la proposition est retenue, jamais rendus au modèle. */
  warnings?: string[];
  notes?: string[];
  /**
   * `errors` ne sont que des questions : la proposition tient, et `kept` est
   * ce qui sera retenu si la réponse fait pire.
   */
  questions?: true;
}

/**
 * Les captures et les assertions sont vérifiées contre l'écran réellement
 * obtenu. Pour une assertion, la vérité terrain est qu'elle **passe ici** :
 * on enregistre un état connu comme bon, donc une assertion fausse à la
 * génération serait un test faux pour toujours.
 *
 * Sur les deux arbres du regard : l'arbre du modèle dit ce qu'il voulait, celui du
 * rejeu ce qui sera lu. Rien n'est accepté qui ne le serait pas sur le premier
 * seul, comme en 0.5.0, et rien qui se lirait autrement sur le second. Un refus
 * dû au second ne cite que des nombres.
 */
function verifyChecks(
  screen: Look,
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
      // Séparer « introuvable » et « ambigu » faisait recopier les valeurs au
      // modèle (#48, 3 exécutions sur 3) : le message reste celui de 0.5.0 là où
      // son arbre montre la cause.
      const seen = matchOne(screen.shown, from);
      if (seen === null) {
        errors.push(`capture "${name}": target not found or ambiguous on this screen`);
        continue;
      }
      const shownValue = readCapture(seen, spec);
      if (shownValue === null) {
        errors.push(
          spec.after === undefined && spec.before === undefined
            ? `capture "${name}": unreadable value with extract="${spec.extract}"`
            : `capture "${name}": nothing readable between "after" and "before" in ${JSON.stringify(captureSource(seen, spec))}: copy the fixed words around the value exactly`,
        );
        continue;
      }
      // Le rejeu lit l'arbre complet : la valeur vient de là, et doit être celle
      // de l'élément montré — le même nœud, ou sur deux lectures la même valeur,
      // ou une cible qui y désigne le même élément.
      const node = matchOne(screen.root, from);
      const value = node === null ? null : readCapture(node, spec);
      if (
        node === null ||
        value === null ||
        (screen.aligned ? node.id !== seen.id : value !== shownValue && !samePositions(screen, from))
      ) {
        errors.push(`capture "${name}": found on your tree, but ${replayReads(screen, from, 'capture')}`);
        continue;
      }
      // Les deux valeurs sont égales, sauf sur les deux lectures d'un pilote tiers
      // quand l'élément est vivant : la valeur gardée est alors celle que le
      // modèle a vue, comme en 0.5.0, pour que rien de la seconde lecture ne lui
      // parvienne avec les captures connues.
      const read = shownValue;
      if (value !== read) {
        warnings.push(
          `capture "${name}" changed between the two reads of this screen: the value is live, and replay reads it at its own time`,
        );
      }
      learnDerived(secrets, seen, read);
      learnDerived(secrets, node, read);
      for (const anchor of [spec.after, spec.before]) {
        if (anchor !== undefined && holdsNumber(anchor)) {
          warnings.push(
            `capture "${name}" is bounded by "${anchor}", which holds a number: if it is data, the bound is gone on replay`,
          );
        } else if (anchor !== undefined && Object.values(bag).some((known) => known.trim().length >= 3 && anchor.includes(known))) {
          warnings.push(
            `capture "${name}" is bounded by "${anchor}", which holds the value of an earlier capture: the bound is gone on replay`,
          );
        }
      }
      // Un `from` nommé par une capture suit la valeur au rejeu.
      if (
        namedCaptures(nameLiteral(spec.from) ?? '').length === 0 &&
        (tautologicalCapture(from, spec.extract, seen, read) || tautologicalCapture(from, spec.extract, node, value))
      ) {
        warnings.push(
          `capture "${name}" is located by the very value it reads ("${read}"): when that value changes, replay reports "target not found" instead of reading the new one`,
        );
      }
      produced[name] = read;
      merged[name] = read;
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
        (tautological(check, screen.shown, merged) || tautological(check, screen.root, merged))
      ) {
        warnings.push(
          `assertion "${expectation}" is located by the very value it asserts ("${usesEnv(String(check.value)) ? MASK : interpolate(String(check.value), merged)}"): when that value changes, replay reports "no element" instead of "expected …, observed …"`,
        );
      }
      const on = (root: UINode) =>
        evaluateCheck(check, {
          root,
          location: screen.location,
          bag: merged,
          secrets,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        });
      const result = on(screen.shown);
      if (!result.ok) {
        errors.push(`assertion "${expectation}" false on this screen: ${result.reason}`);
        continue;
      }
      if (!('target' in check)) continue;
      const target = interpolateLocator(check.target, merged);
      if (!on(screen.root).ok || readsElsewhere(screen, check, target)) {
        errors.push(
          `assertion "${expectation}": true on your tree, but ${
            check.check === 'absent'
              ? replayReads(screen, target, check.check, true)
              : replayReads(screen, target, check.check)
          }`,
        );
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
  // Une cible nommée par la capture même qu'on compare suit la valeur au rejeu :
  // ce que le signalement redoute, un nom figé, n'existe pas ici.
  const value = String(check.value);
  if (namedCaptures(value).length > 0 && nameLiteral(check.target)?.includes(value) === true) return false;
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

/**
 * Les captures nommées par une attente, figées en littéral : voir
 * `frozenCapture`. `known` comprend les captures produites à cette étape.
 */
function frozenLiterals(
  assertions: Record<string, Check>,
  expectations: readonly string[],
  known: Readonly<Record<string, string>>,
): {
  assertions: Record<string, Check>;
  rewritten: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
  questions: { key: string; question: string; warning: string }[];
} {
  const out: Record<string, Check> = { ...assertions };
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const questions: { key: string; question: string; warning: string }[] = [];
  let rewritten = false;
  for (const key of expectations) {
    const outcome = frozenCapture(key, assertions[key], known);
    if (outcome === null) continue;
    if (outcome.check !== undefined) {
      out[key] = outcome.check as unknown as Check;
      rewritten = true;
    }
    if (outcome.note !== undefined) notes.push(outcome.note);
    if (outcome.error !== undefined) errors.push(outcome.error);
    if (outcome.question !== undefined) {
      questions.push({ key, question: outcome.question, warning: outcome.warning ?? '' });
    } else if (outcome.warning !== undefined) {
      warnings.push(outcome.warning);
    }
  }
  return { assertions: out, rewritten, errors, warnings, notes, questions };
}

/**
 * Une vérification vraie sur cet écran, évaluée comme au rejeu.
 *
 * Une forme invalide, une observation (réseau, console : elles ne parlent
 * d'aucun écran) ou une capture encore inconnue ne « tiennent » pas : c'est
 * le côté prudent, puisque ce qui tient avant le geste est renvoyé au modèle.
 *
 * Vraie sur l'un des deux arbres suffit : vraie avant sur celui du modèle, comme
 * en 0.5.0, ou sur celui du rejeu, elle ne prouve pas plus le geste.
 */
function holdsOn(
  check: unknown,
  screen: Look,
  bag: Readonly<Record<string, string>>,
  baseUrl: string | undefined,
): boolean {
  if (checkIssue(check, 'check') !== null) return false;
  const typed = check as Check;
  if (isObservationCheck(typed)) return false;
  try {
    return [screen.shown, screen.root].some(
      (root) =>
        evaluateCheck(typed, {
          root,
          location: screen.location,
          bag,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        }).ok,
    );
  } catch {
    // Une interpolation impossible avant le geste — la capture de cette étape
    // n'existe pas encore — n'est pas une vérification déjà vraie.
    return false;
  }
}

function alreadyTrueBefore(key: string): string {
  return `assertion "${key}" is already true on the current screen, before any gesture: it would pass even if the actions did nothing. If the step is meant to change this, assert what the step changes, and check that the actions carry out the intent; if it is a deliberate invariant, something the step must leave as it is, resend it unchanged`;
}

function alreadyTrueAfter(key: string, check: Check): string {
  return `assertion "${key}" was already true on the screen before the gestures, so it does not show they did anything: ${JSON.stringify(check)}. If the step is meant to change this, assert what the step changed on this screen; if it is a deliberate invariant, something the step must leave as it is, resend it unchanged`;
}

function staleWarning(key: string): string {
  return `assertion "${key}" was already true before the gesture: it holds, but does not prove the step did anything`;
}

export async function generateResolution(input: GenerateInput): Promise<GenerateResult> {
  const { scenario, driver } = input;
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
  // rejets rapportés, ni — surtout — dans ce qui part chez le fournisseur de
  // modèle, qui est un tiers : écrans, adresses et captures compris.
  const authored = authoredTexts(scenario, platform);
  const secrets = new SecretRegistry(authored, input.knownSecrets);
  secrets.addAll(namedEnvValues(authored));
  // Un `[secret]` que l'auteur écrit lui-même n'est pas le masque recopié.
  const guardsMask = (): boolean => secrets.size > 0 && !authored.some((text) => text.includes(MASK));
  const provider = maskedProvider(input.provider, (text) => secrets.redact(text));
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

    // Une étape qui ne fait que vérifier ne lit jamais l'écran d'avant : ni
    // phase A, ni « déjà vraie avant le geste », puisqu'il n'y a pas de geste.
    let before: Look | undefined;
    if (!verificationOnly) {
      await driver.settle();
      before = await look(driver);
    }

    /**
     * Une assertion déjà vraie AVANT le geste ne prouve pas qu'il a eu lieu.
     *
     * Mesuré avec DeepSeek : une étape résolue par une navigation qui recharge
     * l'application, avec une assertion vraie de toute façon — vert, et rien
     * de prouvé sur l'étape. Un invariant légitime existe pourtant (« l'en-tête
     * affiche toujours le nom de la boutique », « aucune erreur » en `absent`) :
     * l'assertion est donc renvoyée UNE fois au modèle, jamais refusée. S'il la
     * maintient, elle est acceptée avec un avertissement.
     *
     * Un seul renvoi par attente, pour toute l'étape, phases A et B confondues,
     * et pour toutes les questions (voir aussi `frozenCapture`) : la clé entre
     * ici quand le renvoi part, et n'est plus jamais renvoyée. Un renvoi qui
     * pousserait le modèle à tourner en rond, ou à lâcher la valeur pour un
     * `visible` qui ne tient plus avant, ferait pire que l'avertissement.
     *
     * Et une question ne fait jamais échouer une étape qui aurait été résolue
     * sans elle : la proposition interrogée est gardée, et retenue si la
     * réponse fait pire (refusée, ou à court de tours).
     */
    const challenged = new Set<string>();
    const expectations = expectationsOf(step);

    /** Un tour de précision : une panne n'y coûte rien, la proposition tient déjà. */
    const refine = async (messages: ModelMessage[], responseSchema: Record<string, unknown>): Promise<unknown> => {
      try {
        return (await provider.complete({ system: systemPrompt(platform), messages, responseSchema })).output;
      } catch {
        return null;
      }
    };

    const conversation: ModelMessage[] =
      before === undefined
        ? []
        : [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: stepMessage({
                    intent,
                    tree: renderTree(before.shown),
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
    let questioned: Proposal | null = null;

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
        // La réponse à une question rend la main, lisible ou non.
        if (questioned !== null) break;
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
              ...(guardsMask() ? copiedMask(candidate.actions) : []),
              ...verifyEnvTemplates(candidate.actions, intent),
              ...verifyGestures(driver, candidate.actions),
              ...(await verifyActions(driver, candidate.actions)),
            ];
      // Masqué avant de rejoindre le rapport ET la conversation : un rejet peut
      // recopier un nom d'écran, et un secret d'une étape antérieure y figure.
      const errors = raw.map((error) => secrets.redact(error));

      if (errors.length === 0 && !Array.isArray(candidate)) {
        // Toute variable employée, cible et capture comprises : seule la saisie
        // les enregistrait. Pas celles d'une proposition refusée, qui n'a rien lu.
        secrets.addAll(envValuesIn(JSON.stringify(candidate)));
        /**
         * Le renvoi part ICI, avant d'agir, quand il le peut : c'est le seul
         * moment où le modèle peut encore corriger ses gestes. Une recharge
         * proposée pour « chercher un article » se voit à ce stade — après, le
         * geste est joué et seule l'assertion reste à revoir. Jamais à
         * l'avant-dernier tour ni au dernier : la réponse en prendrait un, et
         * la phase B n'en aurait plus pour réparer une vérification fausse
         * après le geste, que la proposition interrogée aurait pu réparer. Une
         * assertion vraie avant mais fausse après serait refusée en phase B de
         * toute façon : la renvoyer ici ne coûte pas un vert légitime.
         */
        const start = before;
        const challenges =
          used < attempts - 1 && start !== undefined
            ? Object.entries(portableChecks(candidate.assertions, checkBase, () => {}).assertions)
                .filter(([key]) => expectations.includes(key) && !challenged.has(key))
                .filter(([, check]) => holdsOn(check, start, bag, checkBase))
                .map(([key]) => key)
            : [];
        if (challenges.length === 0) {
          proposal = candidate;
          break;
        }
        for (const key of challenges) challenged.add(key);
        questioned = candidate;
        const questions = challenges.map((key) => secrets.redact(alreadyTrueBefore(key)));
        rejections.push(...questions);
        conversation.push(
          { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
          { role: 'user', content: [{ type: 'text', text: questionMessage(questions) }] },
        );
        continue;
      }

      rejections.push(...errors);
      // Une réponse refusée rend la main : les tours restants servent à réparer
      // les vérifications, pas à insister sur une question.
      if (questioned !== null) break;
      conversation.push(
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
        { role: 'user', content: [{ type: 'text', text: retryMessage(errors) }] },
      );
    }

    // La réponse à la question n'a donné aucune proposition recevable : la
    // proposition interrogée reste ce qu'on avait de mieux, et ses gestes ont
    // été vérifiés. L'assertion déjà vraie avant y sera signalée en phase B.
    if (proposal === null && questioned !== null) proposal = questioned;

    if (proposal === null) {
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections, warnings });
      aborted = true;
      continue;
    }

    for (const name of numberedTargets(proposal.actions)) {
      warn(`target "${name}" holds a number: if it is data, replay will not find it; if so, use { "contains": "..." } on its stable part`);
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
          // La variable seule aussi : l'écran peut l'afficher sans son préfixe.
          secrets.addAll(envValuesIn(template));
          if (usesEnv(template) && !secrets.add(resolved)) {
            warn(
              `an environment value used here is too short (${resolved.length} chars) to be redacted safely: it reaches the model provider and appears as-is`,
            );
          }
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
    let after = await look(driver);

    /**
     * Réécrit les adresses, PUIS vérifie : la forme prouvée contre l'écran est
     * celle qui sera versionnée.
     */
    const assess = (
      screen: Look,
      candidate: Pick<Proposal, 'captures' | 'assertions'>,
    ): {
      checks: Pick<Proposal, 'captures' | 'assertions'>;
      outcome: CheckOutcome;
      kept?: { checks: Pick<Proposal, 'captures' | 'assertions'>; outcome: CheckOutcome };
    } => {
      // La base des vérifications, pas celle des navigations : réécrire une
      // adresse que le rejeu ne résoudra pas la rendrait fausse partout.
      const portableWarnings: string[] = [];
      const portable = portableChecks(candidate.assertions, checkBase, (warning) => {
        if (platform === 'web') portableWarnings.push(warning);
      });
      let checks = { captures: candidate.captures, assertions: portable.assertions };
      const agnostic = [
        ...screenAgnosticChecks(
          portable.assertions,
          screenAgnosticPrefix(platform, screen.location, checkBase),
        ),
        ...hostBoundChecks(portable.assertions, checkBase),
      ];
      const verify = (): CheckOutcome =>
        verifyChecks(screen, bag, checks, step, secrets, checkBase, observable);
      let verified = verify();
      // Les captures de cette étape comptent : « contient {{reference}} » peut
      // nommer la valeur qu'on vient de lire. La réécriture est vérifiée comme
      // le reste — c'est la forme versionnée qui doit passer ici.
      const known = { ...bag, ...verified.produced };
      const frozen = frozenLiterals(checks.assertions, expectations, known);
      const sources = frozenSources(checks.captures, step, bag, verified.produced);
      if (frozen.rewritten || sources.rewritten) {
        checks = { captures: sources.captures, assertions: frozen.assertions };
        verified = verify();
      }
      if (verified.errors.length === 0) secrets.addAll(envValuesIn(JSON.stringify(checks)));

      const notes = [...sources.notes, ...frozen.notes].map((note) => secrets.redact(note));
      const copied = guardsMask() ? copiedMask([checks.captures, Object.values(checks.assertions)]) : [];
      const errors = [
        ...[...copied, ...portable.errors, ...agnostic, ...frozen.errors].map((error) => secrets.redact(error)),
        ...verified.errors,
      ];
      const warnings = [
        ...(verified.warnings ?? []),
        ...[...portableWarnings, ...sources.warnings, ...frozen.warnings, ...selfCompared(checks, expectations, screen, { ...bag, ...verified.produced })].map(
          (warning) => secrets.redact(warning),
        ),
      ];

      if (errors.length > 0) {
        return { checks, outcome: { errors, produced: verified.produced, warnings, notes } };
      }

      // Seulement sur une proposition par ailleurs acceptable : le renvoi est
      // une question, pas un motif de plus noyé parmi des refus. Une étape qui
      // ne fait que vérifier n'a pas de geste dont l'effet serait à prouver.
      const pending: { key: string; question: string; warning: string }[] = [...frozen.questions];
      if (before !== undefined) {
        for (const key of expectations) {
          const check = checks.assertions[key];
          if (check === undefined || !holdsOn(check, before, known, checkBase)) continue;
          pending.push({ key, question: alreadyTrueAfter(key, check), warning: staleWarning(key) });
        }
      }
      const questions: string[] = [];
      // Ce que la proposition retenue telle quelle signalerait : les questions
      // devenues avertissements.
      const settled: string[] = [];
      // Les clés interrogées à ce tour-ci : une clé à deux questions les reçoit
      // ensemble, en un seul renvoi.
      const asking = new Set<string>();
      for (const { key, question, warning } of pending) {
        const redacted = secrets.redact(warning);
        if (asking.has(key) || (!challenged.has(key) && used < attempts)) {
          // La boucle repart dès qu'une erreur reste et qu'un tour reste : ce
          // renvoi part donc bien, et compte pour l'unique renvoi de la clé.
          asking.add(key);
          questions.push(secrets.redact(question));
          settled.push(redacted);
        } else {
          warnings.push(redacted);
        }
      }
      for (const key of asking) challenged.add(key);

      const outcome = { errors: [], produced: verified.produced, warnings, notes };
      if (questions.length === 0) return { checks, outcome };
      return {
        checks,
        outcome: { ...outcome, errors: questions, questions: true },
        kept: { checks, outcome: { ...outcome, warnings: [...warnings, ...settled] } },
      };
    };

    let { checks, outcome, kept } = assess(after, proposal);

    const checksConversation: ModelMessage[] = [];
    // Une étape qui ne fait que vérifier n'a encore rien proposé : ses
    // manques initiaux sont la question posée au modèle, pas un rejet.
    let proposed = !verificationOnly;
    while (outcome.errors.length > 0 && used < attempts) {
      used += 1;
      if (proposed) rejections.push(...outcome.errors);
      const hadProposal = proposed;
      proposed = true;

      if (checksConversation.length === 0) {
        checksConversation.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: checksMessage({
                tree: renderTree(after.shown),
                location: after.location,
                expectations: expectationsOf(step),
                captures: step.capture ?? {},
                availableCaptures: bag,
                verificationOnly,
                // Ce qui a été refusé dans la proposition de la phase A : sans
                // ce rappel, le modèle repartait de zéro sans savoir pourquoi —
                // et ne pouvait pas maintenir un invariant qu'on lui renvoie.
                // Rien pour une étape qui ne fait que vérifier : elle n'a encore
                // rien proposé, ses manques sont la question elle-même.
                ...(hadProposal
                  ? outcome.questions === true
                    ? { questioned: outcome.errors, proposal: JSON.stringify(checks) }
                    : { rejected: outcome.errors }
                  : {}),
              }),
            },
          ],
        });
      } else {
        checksConversation.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: outcome.questions === true ? questionMessage(outcome.errors) : retryMessage(outcome.errors),
            },
          ],
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

      after = await look(driver);
      const assessed = assess(after, candidate);
      ({ checks, outcome } = assessed);
      // La dernière proposition valide : une réponse qui tient, mais
      // interrogée à son tour, la remplace.
      if (assessed.kept !== undefined) kept = assessed.kept;
    }

    // La réponse à une question a fait pire, et plus aucun tour ne la répare :
    // la proposition interrogée tenait, elle est retenue, avec l'avertissement
    // qu'aurait donné l'absence de question. Ses refus restent au rapport.
    if (outcome.errors.length > 0 && kept !== undefined) {
      if (outcome.questions !== true) rejections.push(...outcome.errors);
      ({ checks, outcome } = kept);
    }

    if (outcome.errors.length > 0) {
      // Le dernier refus n'a plus de tour pour revenir au modèle, mais c'est
      // lui qui explique l'échec : sans lui, l'étape échouait sans motif.
      rejections.push(...outcome.errors);
      reports.push({ stepId: step.id, intent, status: 'failed', attempts: used, rejections, warnings });
      aborted = true;
      continue;
    }

    /**
     * Une capture qui rapporte un texte entier : une question hors du compte des
     * tours, jamais sans un tour restant. Seules ses bornes sont retenues, et la
     * forme bornée repasse par toutes les vérifications ; si l'une tombe, rien ne
     * change. Seul un modèle qui a répondu efface le doute : une panne ou des
     * bornes refusées le laissent signalé.
     */
    const screen = after;
    const produced = outcome.produced;
    const loose = Object.keys(checks.captures).filter((name) => {
      const spec = checks.captures[name] as CaptureSpec;
      const read = produced[name];
      if (read === undefined) return false;
      // Acceptée, la capture lit le même élément sur les deux arbres : l'arbre
      // montré suffit, comme en 0.5.0.
      const node = designated(screen.shown, spec.from, { ...bag, ...produced });
      return node !== null && readsWholeText(spec, read, captureSource(node, spec));
    });
    let settled = loose.length === 0;
    if (loose.length > 0 && used < attempts) {
      const asked = loose.map(
        (name) =>
          `- capture "${name}" read the whole text "${produced[name]}", and it is meant to hold ${JSON.stringify(step.capture?.[name])}: if that is only part of this text, add "after" and/or "before", the fixed words around the value; if it is the whole text, resend it unchanged`,
      );
      const asking: ModelMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: ['Before these captures are accepted:', ...asked, '', `What you proposed: ${JSON.stringify({ captures: checks.captures })}`].join('\n'),
            },
          ],
        },
      ];
      // Deux essais : une borne mal recopiée se corrige dès qu'on montre le refus,
      // et sans elle la capture reste entière et la suite compare une phrase.
      for (let tries = 0; tries < 2; tries += 1) {
        const output = await refine(asking, checksProposalSchema(platform));
        if (output === null) break;
        const bounded = boundedCaptures(checks.captures, loose, output);
        if (JSON.stringify(bounded.captures) === JSON.stringify(checks.captures)) {
          settled = bounded.answered;
          break;
        }
        const retried = assess(after, { captures: bounded.captures, assertions: checks.assertions });
        const retained = retried.outcome.errors.length === 0 ? retried : retried.kept;
        if (retained !== undefined) {
          const notes = [...(outcome.notes ?? []), ...(retained.outcome.notes ?? [])];
          ({ checks, outcome } = retained);
          outcome = { ...outcome, notes };
          settled = true;
          break;
        }
        asking.push(
          { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] },
          { role: 'user', content: [{ type: 'text', text: retryMessage(retried.outcome.errors) }] },
        );
      }
    }
    if (!settled) {
      for (const name of loose) {
        warn(`capture "${name}" reads the whole text "${produced[name]}": if the value is only part of it, bound it with "after" and "before"`);
      }
    }

    for (const warning of outcome.warnings ?? []) warn(warning);
    Object.assign(bag, outcome.produced);

    // Déjà relativisées avant l'exécution : on versionne exactement ce qui a
    // été joué.
    const resolved: StepResolution = { actions: proposal.actions, healedAt: null };
    if (Object.keys(checks.captures).length > 0) resolved.captures = checks.captures;
    if (Object.keys(checks.assertions).length > 0) resolved.assertions = checks.assertions;
    steps[step.id] = resolved;

    const notes = [...new Set(outcome.notes ?? [])];
    reports.push({
      stepId: step.id,
      intent,
      status: 'resolved',
      attempts: used,
      rejections,
      warnings,
      ...(notes.length > 0 ? { notes } : {}),
    });
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
