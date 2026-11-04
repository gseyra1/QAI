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
 * Les valeurs d'environnement que des textes désignent par leur nom.
 *
 * À masquer dès le premier écran : un compte déjà affiché au chargement partait
 * en clair, avant l'étape qui le saisit. Le nom s'écrit en capitales (voir la
 * consigne) avec un soulignement : `CI`, `API` ou `DEBUG` dans une intention sont
 * des mots, et `DEBUG=true` masquerait « true » sur tous les écrans. Saisie, une
 * telle variable reste enregistrée, et `{{env.CI}}` la désigne sans doute.
 */
export function namedEnvValues(texts: readonly string[]): string[] {
  const names = new Set(
    texts.flatMap((text) => text.match(/[A-Za-z0-9_]+/g) ?? []).filter((word) => /^_*[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(word)),
  );
  return [
    ...[...names].flatMap((name) => process.env[name] ?? []),
    ...texts.flatMap((text) => envValuesIn(text)),
  ];
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

/** Un texte réécrit, et d'où vient chaque unité dans le texte d'origine. */
interface View {
  text: string;
  starts: number[];
  ends: number[];
}

/** Une séquence UTF-8 complète à partir de `at`, ou un octet seul dans le jeu d'une ancienne page. */
function decodeSequence(bytes: readonly number[], at: number): { chars: string; length: number } {
  const lead = bytes[at] as number;
  const length = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
  if (length > 0 && at + length <= bytes.length) {
    try {
      const sequence = Uint8Array.from(bytes.slice(at, at + length));
      return { chars: new TextDecoder('utf-8', { fatal: true }).decode(sequence), length };
    } catch {
      // Séquence invalide : l'octet seul, ci-dessous.
    }
  }
  return { chars: new TextDecoder('windows-1252').decode(Uint8Array.of(lead)), length: 1 };
}

function emptyView(): View {
  return { text: '', starts: [], ends: [] };
}

function rawView(text: string): View {
  return {
    text,
    starts: Array.from({ length: text.length }, (_, index) => index),
    ends: Array.from({ length: text.length }, (_, index) => index + 1),
  };
}

function emit(out: View, chars: string, start: number, end: number): void {
  for (let unit = 0; unit < chars.length; unit += 1) {
    out.starts.push(start);
    out.ends.push(end);
  }
  out.text += chars;
}

/** Un tour de décodage d'URL. */
function percentDecoded(view: View): View {
  const { text, starts, ends } = view;
  const out = emptyView();
  for (let at = 0; at < text.length; ) {
    const bytes: number[] = [];
    let next = at;
    while (text[next] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(next + 1, next + 3))) {
      bytes.push(Number.parseInt(text.slice(next + 1, next + 3), 16));
      next += 3;
    }
    if (bytes.length === 0) {
      emit(out, text[at] as string, starts[at] as number, ends[at] as number);
      at += 1;
      continue;
    }
    for (let index = 0; index < bytes.length; ) {
      const { chars, length } = decodeSequence(bytes, index);
      emit(out, chars, starts[at + index * 3] as number, ends[at + (index + length) * 3 - 1] as number);
      index += length;
    }
    at = next;
  }
  return out;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Les échappements d'une chaîne JSON : une cible part sérialisée, une adresse en porte. */
function jsonUnescaped(view: View): View {
  const { text, starts, ends } = view;
  const out = emptyView();
  for (let at = 0; at < text.length; ) {
    const escaped = text[at] === '\\' ? text[at + 1] : undefined;
    const known = escaped === undefined ? undefined : JSON_ESCAPES[escaped];
    if (known !== undefined) {
      emit(out, known, starts[at] as number, ends[at + 1] as number);
      at += 2;
    } else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
      const char = String.fromCharCode(Number.parseInt(text.slice(at + 2, at + 6), 16));
      emit(out, char, starts[at] as number, ends[at + 5] as number);
      at += 6;
    } else {
      emit(out, text[at] as string, starts[at] as number, ends[at] as number);
      at += 1;
    }
  }
  return out;
}

/** Les espaces réduits comme l'observation les réduit. */
function collapsed(view: View): View {
  const { text, starts, ends } = view;
  const out = emptyView();
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (!/\s/.test(char)) emit(out, char, starts[at] as number, ends[at] as number);
    else if (at > 0 && !/\s/.test(text[at - 1] as string)) emit(out, ' ', starts[at] as number, ends[at] as number);
  }
  return out;
}

/** Au-delà, ce n'est plus une application qui encode. */
const MAX_ENCODINGS = 3;

/**
 * Le texte tel qu'il est, et tel qu'il se lit une fois décodé.
 *
 * Plusieurs lectures côte à côte, jamais une seule à force de réécritures : dans
 * « Remise 20% 4242 », le décodage lit `%20` et `% 42`, et une forme unique perdait
 * la valeur écrite en clair. Chaque lecture est cherchée pour elle-même, à coût
 * linéaire et borné. Une expression construite sur le secret faisait déborder la
 * pile à partir de quelques kilo-octets, et l'erreur recopiait le secret.
 */
function readings(text: string): View[] {
  const decoded = [rawView(text)];
  for (let round = 0; round < MAX_ENCODINGS && (decoded.at(-1) as View).text.includes('%'); round += 1) {
    decoded.push(percentDecoded(decoded.at(-1) as View));
  }
  const all = decoded.flatMap((view) => (view.text.includes('\\') ? [view, jsonUnescaped(view)] : [view]));
  return all.map(collapsed);
}

/**
 * Les écritures d'une valeur à chercher dans ces lectures.
 *
 * L'analyseur d'URL change `\\` en `/` et retire tabulations et retours, un
 * formulaire écrit l'espace `+`, et une valeur peut porter elle-même un `%xx`. Les
 * espaces ne sont retirés que des valeurs qui en ont : les retirer du texte collait
 * les mots voisins, et `test` sortait de « the exit code ».
 */
function writings(value: string): string[] {
  const written = collapsed(rawView(value)).text.trim();
  const forms = [
    written,
    written.replaceAll('\\', '/'),
    written.replaceAll(/\s/g, ''),
    value.trim().replaceAll(/\s/g, '+'),
    percentDecoded(rawView(written)).text,
  ];
  return [...new Set(forms)].filter((form) => form !== '');
}

/** Vrai quand `value`, encodée ou non, porte le masque. */
export function holdsMask(value: unknown): boolean {
  return readings(JSON.stringify(value) ?? '').some((view) => view.text.includes(MASK));
}

/**
 * Remplace par positions, pas par substitutions successives : deux secrets qui
 * se chevauchent ou s'emboîtent laissaient la fin de l'un en clair.
 *
 * `keep` protège des passages entiers : une occurrence entièrement à l'intérieur
 * reste telle quelle. Le masque en fait toujours partie : `secret` comme mot de
 * passe de test le remasquait à chaque passage.
 */
function maskSpans(text: string, secrets: Iterable<string>, keep: readonly string[]): string {
  const kept: [number, number][] = [];
  for (const passage of [...keep, MASK]) {
    if (passage === '') continue;
    for (let at = text.indexOf(passage); at >= 0; at = text.indexOf(passage, at + 1)) {
      kept.push([at, at + passage.length]);
    }
  }
  const spans: [number, number][] = [];
  const forms = [...secrets];
  for (const view of readings(text)) {
    for (const secret of forms) {
      for (let at = view.text.indexOf(secret); at >= 0; at = view.text.indexOf(secret, at + 1)) {
        spans.push([view.starts[at] as number, view.ends[at + secret.length - 1] as number]);
      }
    }
  }
  const visible = spans
    .filter(([start, end]) => !kept.some(([from, to]) => from <= start && end <= to))
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of visible) {
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
  return maskSpans(text, secrets.flatMap(writings), []);
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
  readonly #values: Set<string>;
  readonly #authored: readonly string[];

  /**
   * `authored` : ce que l'auteur a écrit, rendu tel quel. Une attente qui nomme
   * une valeur doit revenir mot pour mot, c'est sa clé ; et ce texte est déjà
   * versionné en clair. La valeur reste masquée partout ailleurs, à l'écran
   * comme dans l'adresse.
   *
   * `known` : les valeurs déjà apprises par les parcours précédents de la même
   * commande. Un compte saisi par le parcours de connexion s'affiche dans le
   * suivant, qui ne nomme aucune variable.
   */
  constructor(authored: readonly string[] = [], known: Set<string> = new Set()) {
    this.#authored = authored;
    this.#values = known;
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
    // Sans ses espaces : « a b » peut se lire « ab » dans une adresse.
    if (value.replaceAll(/\s/g, '').length <= 2) return false;
    for (const form of writings(value)) this.#values.add(form);
    return true;
  }

  addAll(values: Iterable<string>): void {
    for (const value of values) this.add(value);
  }

  redact(text: string): string {
    return this.#values.size === 0 ? text : maskSpans(text, this.#values, this.#authored);
  }

  get size(): number {
    return this.#values.size;
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

/**
 * Une valeur lue sur un nœud qui porte un secret en dérive.
 *
 * `extract: number` retire zéros et séparateurs : le masque ne reconnaît plus le
 * résultat, et la capture partait en clair.
 */
export function learnDerived(secrets: SecretRegistry, node: UINode, read: string): void {
  const sources = [node.name, node.value ?? ''];
  if (sources.some((source) => secrets.redact(source) !== source)) secrets.add(read);
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
  // La conversion réécrit le texte : « 00738291 » devient 738291, que le masque
  // ne reconnaît plus. Le masque se décide donc sur le texte lu.
  const read = context.secrets !== undefined && context.secrets.redact(observed) !== observed ? MASK : left;
  if (left === null || right === null) {
    return { ok: false, reason: `non-numeric value: "${observed}" vs "${shown}"` };
  }
  // `right` est la valeur attendue reconvertie : la masquer aussi, sans quoi un
  // secret qui se trouve être numérique — un code, un matricule — ressortirait
  // par le message d'inégalité au lieu du message de format.
  return left === right
    ? { ok: true }
    : { ok: false, reason: `expected ${secret ? MASK : right}, observed ${read}` };
}
