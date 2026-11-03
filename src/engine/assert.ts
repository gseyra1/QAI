import type { ConsoleEntry, Locator, NetworkEntry, Observations, UINode } from '../driver/types.ts';
import type { Check, ExtractKind } from '../resolution/types.ts';
import { hasScheme, isDegenerateUrlValue, resolveAgainstBase } from '../resolution/url.ts';
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
 * Les valeurs que les gabarits `{{env.NOM}}` d'un texte désignent.
 *
 * Connues avant le premier geste, elles sont masquées même sur un écran qui les
 * affiche avant l'étape qui les saisit. Une variable absente n'a rien à masquer.
 */
export function envValuesIn(text: string): string[] {
  const values: string[] = [];
  PLACEHOLDER.lastIndex = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!name.startsWith(ENV_PREFIX)) continue;
    const value = process.env[name.slice(ENV_PREFIX.length)];
    if (value !== undefined) values.push(value);
  }
  return values;
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

/**
 * Ce que rapports et modèle lisent à la place d'un secret.
 *
 * Pas `***` : une application affiche « Carte **** 4242 », et le masque ne se
 * distinguait plus du vrai texte. Recopié par le modèle, il ne pouvait donc pas
 * être refusé sans se tromper dans un sens ou dans l'autre.
 */
export const MASK = '[secret]';

/** Un octet en `%xx`, dans les deux casses que produit un encodeur. */
function percent(byte: number): string {
  const digits = byte.toString(16).padStart(2, '0');
  return `%${digits.replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`)}`;
}

function charPattern(char: string): string {
  const forms = [
    char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'),
    [...new TextEncoder().encode(char)].map(percent).join(''),
  ];
  // Échappés dans le JSON d'une cible ; `\\` devient `/` dans une adresse.
  if (char === '"') forms.push('\\\\"');
  if (char === '\\') forms.push('\\\\\\\\', '/');
  return `(?:${forms.join('|')})`;
}

/** Rien (l'analyseur d'URL retire tabulations et retours), ou un espace sous toutes ses formes. */
const SPACE = String.raw`(?:\s|%20|%0[9aAdD]|\+|\\[nrt])*`;

/**
 * Une valeur, sous toutes les formes qu'elle prend sans cesser d'être ce secret.
 *
 * Comparer des sous-chaînes laissait passer toute valeur transformée, et aucune
 * liste de formes ne suffit : le navigateur n'encode pas comme `encodeURI`, et
 * une application encode ce qu'elle veut (`a%5Bb@c`). On compare donc caractère
 * par caractère, chacun pouvant être en clair ou encodé, et les espaces réduits
 * comme l'observation les réduit. Reste hors de portée ce que l'application
 * reformate (« 1000 » réaffiché « 1 000 »).
 */
function secretPattern(value: string): RegExp {
  const words = value.trim().split(/\s+/);
  return new RegExp(words.map((word) => [...word].map(charPattern).join('')).join(SPACE), 'g');
}

function occurrences(text: string, pattern: RegExp): [number, number][] {
  const spans: [number, number][] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    spans.push([match.index, match.index + match[0].length]);
    pattern.lastIndex = match.index + 1;
  }
  return spans;
}

/**
 * Remplace par positions, pas par substitutions successives : deux secrets qui
 * se chevauchent ou s'emboîtent laissaient la fin de l'un en clair.
 *
 * `keep` protège des passages entiers : une occurrence entièrement à l'intérieur
 * reste telle quelle.
 */
function maskSpans(text: string, patterns: readonly RegExp[], keep: readonly string[]): string {
  const kept: [number, number][] = [];
  for (const passage of keep) {
    if (passage === '') continue;
    for (let at = text.indexOf(passage); at >= 0; at = text.indexOf(passage, at + 1)) {
      kept.push([at, at + passage.length]);
    }
  }
  const spans = patterns
    .flatMap((pattern) => occurrences(text, pattern))
    .filter(([start, end]) => !kept.some(([from, to]) => from <= start && end <= to))
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = '';
  let from = 0;
  for (const [start, end] of merged) {
    out += text.slice(from, start) + MASK;
    from = end;
  }
  return out + text.slice(from);
}

/** Le texte d'un rapport, débarrassé des valeurs venues de l'environnement. */
export function redact(text: string, secrets: readonly string[]): string {
  return maskSpans(text, secrets.filter((secret) => secret.trim() !== '').map(secretPattern), []);
}

/**
 * Le registre des secrets d'une exécution.
 *
 * Le masquage par vérification ne suffit pas, parce qu'un secret est un *flux*,
 * pas une valeur locale : `{{env.MOT_DE_PASSE}}` saisi à l'étape 1, ré-affiché
 * par l'application, capturé, puis comparé à l'étape 5 — à ce moment la
 * vérification ne voit qu'une capture ordinaire, sans marqueur d'origine. Une
 * URL de requête ou un message de console peuvent porter le même secret sans
 * qu'aucun `value` ne le déclare.
 *
 * On enregistre donc la valeur résolue **à sa source** (la saisie, l'assertion
 * qui puise dans l'environnement) une fois pour toute l'exécution, et on masque
 * par sous-chaîne toute sortie visible : raison d'échec, capture rapportée, URL
 * réseau, texte console. Le registre ne peut masquer que ce que QAI sait être
 * un secret — une valeur venue de l'environnement ; un jeton que l'application
 * expose de son propre chef, sans passer par `{{env.X}}`, reste hors de portée.
 */
export class SecretRegistry {
  readonly #patterns = new Map<string, RegExp>();
  readonly #authored: readonly string[];

  /**
   * `authored` : ce que l'auteur a écrit, rendu tel quel. Une attente qui nomme
   * une valeur doit revenir mot pour mot, c'est sa clé ; et ce texte est déjà
   * versionné en clair. La valeur reste masquée partout ailleurs, à l'écran
   * comme dans l'adresse.
   */
  constructor(authored: readonly string[] = []) {
    this.#authored = authored;
  }

  /**
   * Rend `false` quand la valeur est trop courte pour être masquée sans dégât.
   *
   * Le masquage par sous-chaîne a deux angles morts symétriques : une valeur
   * trop **transformée** par l'application n'est plus reconnue (« 1000 »
   * réaffiché « 1 000 »), et une valeur trop **courte** ne se distingue plus
   * du texte ordinaire — enregistrer « ab » effacerait ce fragment dans tout
   * le rapport. On refuse donc les valeurs de deux caractères ou moins, et on
   * le dit à l'appelant plutôt que de le taire : le silence laisserait croire
   * à une protection qui n'existe pas.
   */
  add(value: string): boolean {
    if (value.trim().length <= 2) return false;
    if (!this.#patterns.has(value)) this.#patterns.set(value, secretPattern(value));
    return true;
  }

  addAll(values: Iterable<string>): void {
    for (const value of values) this.add(value);
  }

  redact(text: string): string {
    return this.#patterns.size === 0 ? text : maskSpans(text, [...this.#patterns.values()], this.#authored);
  }

  get size(): number {
    return this.#patterns.size;
  }
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
  /**
   * Le registre de l'exécution. Quand il est fourni, la raison d'échec est
   * masquée contre **tous** les secrets connus — pas seulement ceux que le
   * `value` de cette vérification déclare — ce qui rattrape un secret arrivé
   * par une capture ou une observation.
   */
  secrets?: SecretRegistry;
  /**
   * La base de l'exécution, contre laquelle se résout un `urlEquals` relatif.
   * Absente — sur mobile, ou pour un harnais qui ne la donne pas — la
   * comparaison reste brute.
   */
  baseUrl?: string;
}

/** Une requête est en échec si elle n'a pas abouti, ou si le serveur a refusé. */
export function isFailed(entry: NetworkEntry): boolean {
  return entry.status === null || entry.status >= 400;
}

function allowed(text: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some((pattern) => text.includes(pattern)) === true;
}

/**
 * Les valeurs venues de l'environnement, résolues, pour le filet de sécurité.
 *
 * `countAtLeast` porte un nombre et `stateIs` un littéral : seule une valeur
 * de type chaîne peut contenir un gabarit, d'où le test de type plutôt qu'une
 * confiance dans la déclaration.
 */
export function envSecrets(check: Check, bag: Readonly<Record<string, string>>): string[] {
  const template: unknown = (check as { value?: unknown }).value;
  if (typeof template !== 'string' || !usesEnv(template)) return [];
  try {
    // La variable seule aussi : « Bearer {{env.X}} » ne s'affiche pas toujours
    // avec son préfixe.
    return [interpolate(template, bag), ...envValuesIn(template)];
  } catch {
    // Une variable absente n'a aucune valeur à masquer. L'échec est signalé
    // ailleurs, par le nom de la variable — qui n'est pas le secret.
    return [];
  }
}

/**
 * Masque, à l'unique sortie, ce qu'une branche aurait laissé passer.
 *
 * Chaque vérification calcule déjà son propre `shown`, mais ce masquage est à
 * refaire à la main dans chaque nouvelle branche — et `numberEquals` l'avait
 * oublié dans ses deux messages, ce qui recopiait un secret en clair dans un
 * rapport, donc dans les journaux d'une CI. Corriger la branche ne corrige que
 * cette branche ; le filet, lui, retire la classe entière du bug : une
 * vérification future qui oublie `shown` ne peut plus rien divulguer.
 */
export function evaluateCheck(check: Check, context: CheckContext): CheckResult {
  // Ce que cette vérification puise elle-même dans l'environnement rejoint le
  // registre : une assertion sur `{{env.X}}` enseigne le secret aux étapes
  // suivantes, qui pourraient sinon le laisser fuir par une capture.
  const own = envSecrets(check, context.bag);
  context.secrets?.addAll(own);

  const result = evaluate(check, context);
  if (result.ok) return result;

  // Le registre, quand il existe, masque contre tous les secrets connus — pas
  // seulement `own` — ce qui rattrape la fuite par capture ou par observation.
  if (context.secrets !== undefined) return { ok: false, reason: context.secrets.redact(result.reason) };
  return own.length === 0 ? result : { ok: false, reason: redact(result.reason, own) };
}

function evaluate(check: Check, context: CheckContext): CheckResult {
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
   *
   * Seule la base est résolue, pas la comparaison assouplie : un `urlEquals`
   * relatif devient l'adresse complète sous la base de l'exécution, puis est
   * comparé strictement. C'est ce qui le rend rejouable sur un autre port sans
   * rien céder sur ce qu'il affirme. `urlContains`, lui, reste une sous-chaîne
   * brute : un fragment n'a pas de base.
   */
  if (check.check === 'urlContains' || check.check === 'urlEquals') {
    const interpolated = interpolate(check.value, bag);
    const observed = context.location;
    if (check.check === 'urlContains') {
      // Toute adresse contient la chaîne vide : une capture revenue vide au
      // rejeu ferait de cette vérification un vert inconditionnel.
      if (interpolated === '') {
        return { ok: false, reason: 'urlContains value is empty: every URL contains it, so it proves nothing' };
      }
      const shown = usesEnv(check.value) ? MASK : interpolated;
      return observed.includes(interpolated)
        ? { ok: true }
        : { ok: false, reason: `"${shown}" not found in URL "${observed}"` };
    }
    const expected = resolveAgainstBase(interpolated, context.baseUrl);
    if (observed === expected) return { ok: true };
    const shown = usesEnv(check.value) ? MASK : expected;
    // Une valeur relative sans base, ou vide, ne peut jamais passer : le dire
    // évite de chercher la régression dans l'application.
    const unresolved = isDegenerateUrlValue(interpolated)
      ? ' (empty value, or surrounding blanks: not resolved against the base)'
      : context.baseUrl === undefined && !hasScheme(interpolated)
        ? ' (relative value, but no base URL is known to resolve it)'
        : '';
    return { ok: false, reason: `expected URL "${shown}", observed "${observed}"${unresolved}` };
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
      reason: `${failed.length} failed request(s), including ${first.method} ${first.url} → ${first.status ?? 'network failure'}`,
    };
  }

  if (check.check === 'noConsoleErrors') {
    const errors = (context.observations?.console ?? [])
      .filter((entry) => entry.level === 'error')
      .filter((entry) => !allowed(entry.text, check.allow));
    if (errors.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `${errors.length} console error(s), including "${(errors[0] as ConsoleEntry).text}"`,
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
  const secret = usesEnv(check.value);
  const shown = secret ? MASK : expected;

  if (check.check === 'textContains') {
    // Même garde que pour urlContains : tout texte contient la chaîne vide, et
    // une capture revenue vide au rejeu ferait de « contient {{x}} » un vert
    // inconditionnel.
    if (expected === '') {
      return { ok: false, reason: 'textContains value is empty: every text contains it, so it proves nothing' };
    }
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
    return { ok: false, reason: `non-numeric value: "${observed}" vs "${shown}"` };
  }
  // `right` est la valeur attendue reconvertie : la masquer aussi, sans quoi un
  // secret qui se trouve être numérique — un code, un matricule — ressortirait
  // par le message d'inégalité au lieu du message de format.
  return left === right
    ? { ok: true }
    : { ok: false, reason: `expected ${secret ? MASK : right}, observed ${left}` };
}
