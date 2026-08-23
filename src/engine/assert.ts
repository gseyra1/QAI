import type { ConsoleEntry, Locator, NetworkEntry, Observations, UINode } from '../driver/types.ts';
import type { Check, ExtractKind } from '../resolution/types.ts';
import { matchNodes } from './match.ts';

export class InterpolationError extends Error {
  /** Les noms non résolus, préfixe `env.` compris. */
  readonly missing: string[];

  constructor(missing: string[]) {
    const captures = missing.filter((name) => !name.startsWith(ENV_PREFIX));
    const variables = missing
      .filter((name) => name.startsWith(ENV_PREFIX))
      .map((name) => name.slice(ENV_PREFIX.length));

    const parts: string[] = [];
    if (captures.length > 0) parts.push(`unknown capture(s): ${captures.join(', ')}`);
    if (variables.length > 0) {
      parts.push(`undefined environment variable(s): ${variables.join(', ')}`);
    }

    super(parts.join(' ; '));
    this.name = 'InterpolationError';
    this.missing = missing;
  }
}

const ENV_PREFIX = 'env.';
const PLACEHOLDER = /\{\{(env\.[A-Za-z_][A-Za-z0-9_]*|\w+)\}\}/g;

/**
 * Un template puise-t-il dans l'environnement ?
 *
 * Sert au masquage : ce qui vient de `env.` est un secret par hypothèse, et un
 * rapport de test finit dans les journaux d'une CI, c'est-à-dire à peu près
 * partout.
 */
export function usesEnv(template: string): boolean {
  // Même garde que `interpolate` : le schéma de sortie autorise une valeur
  // numérique (countAtLeast l'exige), donc ce qui arrive ici n'est pas
  // toujours une chaîne malgré le type.
  PLACEHOLDER.lastIndex = 0;
  for (const match of String(template).matchAll(PLACEHOLDER)) {
    if ((match[1] as string).startsWith(ENV_PREFIX)) return true;
  }
  return false;
}

/**
 * Substitue les captures et les variables d'environnement.
 *
 * `{{env.NOM}}` est résolu **à l'exécution**, jamais à l'écriture : le fichier
 * de résolution vit dans git, et un mot de passe recopié dedans y resterait
 * pour toujours. C'est ce qui rend un parcours de connexion écrivable — sans
 * quoi aucune application authentifiée n'est testable de bout en bout.
 *
 * Une variable absente lève, elle ne produit pas une chaîne vide : un champ
 * mot de passe rempli avec du vide échouerait six étapes plus loin, sur un
 * message qui ne dirait rien de la cause.
 */
export function interpolate(template: string, bag: Readonly<Record<string, string>>): string {
  const missing: string[] = [];
  // Une résolution vient d'un fichier ou d'un modèle : le schéma de sortie
  // autorise une valeur numérique (countAtLeast l'exige), donc ce qui arrive
  // ici n'est pas toujours une chaîne malgré le type. Planter sur .replace
  // transformerait une valeur légitime en TypeError cryptique.
  const out = String(template).replace(PLACEHOLDER, (_match, name: string) => {
    const value = name.startsWith(ENV_PREFIX)
      ? process.env[name.slice(ENV_PREFIX.length)]
      : bag[name];
    if (value === undefined) {
      missing.push(name);
      return '';
    }
    return value;
  });
  if (missing.length > 0) throw new InterpolationError(missing);
  return out;
}

/** Le texte d'un rapport, débarrassé des valeurs venues de l'environnement. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

/**
 * Substitue les captures jusque dans les noms ciblés.
 *
 * Sans ça, « le panier contient {{article}} » ne serait pas exprimable : le nom
 * accessible d'une liste étiquetée vaut son `aria-label`, pas le texte de ses
 * items, donc la seule formulation correcte est de cibler l'item par son nom —
 * lequel n'est connu qu'à l'exécution.
 */
export function interpolateLocator(locator: Locator, bag: Readonly<Record<string, string>>): Locator {
  const out: Locator = {};
  if (locator.role !== undefined) out.role = locator.role;
  if (locator.nth !== undefined) out.nth = locator.nth;
  if (locator.name !== undefined) {
    out.name =
      typeof locator.name === 'string'
        ? interpolate(locator.name, bag)
        : { contains: interpolate(locator.name.contains, bag) };
  }
  if (locator.within !== undefined) out.within = interpolateLocator(locator.within, bag);
  return out;
}

/**
 * Lecture d'un nombre affiché, tolérante aux formats français et anglais.
 *
 * Quand les deux séparateurs sont présents, le dernier est le séparateur
 * décimal. Un point suivi de trois chiffres est traité comme séparateur de
 * milliers : c'est le pari juste sur des montants affichés, qui sont le cas
 * dominant dans une interface.
 */
export function toNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (cleaned === '') return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    normalized = cleaned.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.split(',').join('');
  } else if (lastDot >= 0) {
    normalized = /\.\d{1,2}$/.test(cleaned) ? cleaned : cleaned.split('.').join('');
  } else {
    normalized = cleaned;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Un champ de saisie porte son contenu dans `value`, tout le reste dans `name`. */
export function textOf(node: UINode): string {
  return node.value !== undefined && node.value !== '' ? node.value : node.name;
}

export function extractValue(node: UINode, kind: ExtractKind): string | null {
  if (kind === 'text') return node.name;
  if (kind === 'value') return node.value ?? '';
  const parsed = toNumber(textOf(node));
  return parsed === null ? null : String(parsed);
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

const STATE_LABEL = { checked: 'checked', disabled: 'disabled', selected: 'selected' } as const;

/**
 * Tout ce sur quoi une assertion peut porter, à un instant donné.
 *
 * Un objet plutôt que des paramètres : ce contexte s'élargira — le réseau et
 * la console observés pendant l'étape doivent pouvoir devenir assertables sans
 * changer la signature à chaque fois, ni obliger chaque appelant à réordonner
 * ses arguments.
 */
export interface CheckContext {
  root: UINode;
  /** URL sur le web, identifiant d'écran ou d'activité sur mobile. */
  location: string;
  bag: Readonly<Record<string, string>>;
  /** Ce que l'application a fait pendant l'étape. Vide si le driver ne sait pas observer. */
  observations?: Observations;
}

/** Une requête est en échec si elle n'a pas abouti, ou si le serveur a refusé. */
export function isFailed(entry: NetworkEntry): boolean {
  return entry.status === null || entry.status >= 400;
}

function allowed(text: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some((pattern) => text.includes(pattern)) === true;
}

export function evaluateCheck(check: Check, context: CheckContext): CheckResult {
  const { root, bag } = context;

  /**
   * Les vérifications d'URL passent avant toute recherche dans l'arbre : une
   * URL n'est pas un nœud, elle n'a donc pas de cible à résoudre.
   *
   * La comparaison est brute, sans normalisation. Une barre finale, un
   * paramètre de requête ou un fragment font partie de ce qui est affirmé —
   * les effacer ferait passer une redirection vers « /connexion?next=/admin »
   * pour une redirection vers « /connexion », alors que la différence est
   * précisément ce qu'un parcours de droits d'accès cherche à prouver.
   */
  if (check.check === 'urlContains' || check.check === 'urlEquals') {
    const expected = interpolate(check.value, bag);
    const shown = usesEnv(check.value) ? '***' : expected;
    const observed = context.location;
    if (check.check === 'urlContains') {
      return observed.includes(expected)
        ? { ok: true }
        : { ok: false, reason: `« ${shown} » absent de l'URL « ${observed} »` };
    }
    return observed === expected
      ? { ok: true }
      : { ok: false, reason: `attendu l'URL « ${shown} », observé « ${observed} »` };
  }

  /**
   * Les garde-fous d'observation passent aussi avant l'arbre : ils ne parlent
   * pas d'un élément mais de ce que l'application a fait pour l'afficher.
   */
  if (check.check === 'noFailedRequests') {
    const failed = (context.observations?.network ?? [])
      .filter(isFailed)
      .filter((entry) => !allowed(entry.url, check.allow));
    if (failed.length === 0) return { ok: true };
    const first = failed[0] as NetworkEntry;
    return {
      ok: false,
      reason: `${failed.length} requête(s) en échec, dont ${first.method} ${first.url} → ${first.status ?? 'échec réseau'}`,
    };
  }

  if (check.check === 'noConsoleErrors') {
    const errors = (context.observations?.console ?? [])
      .filter((entry) => entry.level === 'error')
      .filter((entry) => !allowed(entry.text, check.allow));
    if (errors.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `${errors.length} erreur(s) console, dont « ${(errors[0] as ConsoleEntry).text} »`,
    };
  }

  const matched = matchNodes(root, interpolateLocator(check.target, bag));

  if (check.check === 'absent') {
    const visible = matched.filter((node) => node.state.visible);
    return visible.length === 0
      ? { ok: true }
      : { ok: false, reason: `${visible.length} element(s) still present` };
  }

  if (check.check === 'countAtLeast') {
    return matched.length >= check.value
      ? { ok: true }
      : { ok: false, reason: `expected at least ${check.value}, observed ${matched.length}` };
  }

  if (matched.length === 0) return { ok: false, reason: 'no element matches the target' };

  if (check.check === 'visible') {
    return matched.some((node) => node.state.visible)
      ? { ok: true }
      : { ok: false, reason: 'element present but not visible' };
  }

  if (check.check === 'stateIs') {
    const node = matched[0] as UINode;
    return node.state[check.value] === true
      ? { ok: true }
      : { ok: false, reason: `element is not ${STATE_LABEL[check.value]}` };
  }

  const expected = interpolate(check.value, bag);
  // Ce qui vient de l'environnement est un secret par hypothèse, et un rapport
  // d'échec finit dans les journaux d'une CI.
  const shown = usesEnv(check.value) ? '***' : expected;

  if (check.check === 'textContains') {
    return matched.some((node) => textOf(node).includes(expected))
      ? { ok: true }
      : { ok: false, reason: `"${shown}" not found in "${textOf(matched[0] as UINode)}"` };
  }

  const observed = textOf(matched[0] as UINode);

  if (check.check === 'textEquals') {
    return observed === expected
      ? { ok: true }
      : { ok: false, reason: `expected "${shown}", observed "${observed}"` };
  }

  const left = toNumber(observed);
  const right = toNumber(expected);
  if (left === null || right === null) {
    return { ok: false, reason: `non-numeric value: "${observed}" vs "${expected}"` };
  }
  return left === right
    ? { ok: true }
    : { ok: false, reason: `expected ${right}, observed ${left}` };
}
