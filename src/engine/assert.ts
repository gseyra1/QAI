import type { Locator, UINode } from '../driver/types.ts';
import type { Check, ExtractKind } from '../resolution/types.ts';
import { matchNodes } from './match.ts';

export class InterpolationError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`capture(s) inconnue(s) : ${missing.join(', ')}`);
    this.name = 'InterpolationError';
    this.missing = missing;
  }
}

export function interpolate(template: string, bag: Readonly<Record<string, string>>): string {
  const missing: string[] = [];
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = bag[name];
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

const STATE_LABEL = { checked: 'coché', disabled: 'désactivé', selected: 'sélectionné' } as const;

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
    const observed = context.location;
    if (check.check === 'urlContains') {
      return observed.includes(expected)
        ? { ok: true }
        : { ok: false, reason: `« ${expected} » absent de l'URL « ${observed} »` };
    }
    return observed === expected
      ? { ok: true }
      : { ok: false, reason: `attendu l'URL « ${expected} », observé « ${observed} »` };
  }

  const matched = matchNodes(root, interpolateLocator(check.target, bag));

  if (check.check === 'absent') {
    const visible = matched.filter((node) => node.state.visible);
    return visible.length === 0
      ? { ok: true }
      : { ok: false, reason: `${visible.length} élément(s) encore présent(s)` };
  }

  if (check.check === 'countAtLeast') {
    return matched.length >= check.value
      ? { ok: true }
      : { ok: false, reason: `attendu au moins ${check.value}, observé ${matched.length}` };
  }

  if (matched.length === 0) return { ok: false, reason: 'aucun élément ne correspond à la cible' };

  if (check.check === 'visible') {
    return matched.some((node) => node.state.visible)
      ? { ok: true }
      : { ok: false, reason: 'élément présent mais non visible' };
  }

  if (check.check === 'stateIs') {
    const node = matched[0] as UINode;
    return node.state[check.value] === true
      ? { ok: true }
      : { ok: false, reason: `l'élément n'est pas ${STATE_LABEL[check.value]}` };
  }

  const expected = interpolate(check.value, bag);

  if (check.check === 'textContains') {
    return matched.some((node) => textOf(node).includes(expected))
      ? { ok: true }
      : { ok: false, reason: `« ${expected} » introuvable dans « ${textOf(matched[0] as UINode)} »` };
  }

  const observed = textOf(matched[0] as UINode);

  if (check.check === 'textEquals') {
    return observed === expected
      ? { ok: true }
      : { ok: false, reason: `attendu « ${expected} », observé « ${observed} »` };
  }

  const left = toNumber(observed);
  const right = toNumber(expected);
  if (left === null || right === null) {
    return { ok: false, reason: `valeur non numérique : « ${observed} » vs « ${expected} »` };
  }
  return left === right
    ? { ok: true }
    : { ok: false, reason: `attendu ${right}, observé ${left}` };
}
