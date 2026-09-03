import type { Action, Locator, Platform, ResolvedTarget } from '../driver/types.ts';

export type ExtractKind = 'text' | 'value' | 'number';

export interface CaptureSpec {
  from: Locator;
  extract: ExtractKind;
}

/**
 * Forme machine d'une assertion. La clé sous laquelle elle est rangée est le
 * texte exact de l'assertion du scénario : reformuler une assertion invalide
 * donc son entrée, ce qui est voulu — une assertion réécrite peut avoir changé
 * de sens, contrairement à une intention simplement reformulée.
 */
export type Check =
  | { check: 'visible'; target: Locator }
  | { check: 'absent'; target: Locator }
  | { check: 'textEquals'; target: Locator; value: string }
  | { check: 'textContains'; target: Locator; value: string }
  | { check: 'countAtLeast'; target: Locator; value: number }
  | { check: 'numberEquals'; target: Locator; value: string }
  | { check: 'stateIs'; target: Locator; value: 'checked' | 'disabled' | 'selected' }
  /**
   * Les deux seules vérifications sans cible : une URL n'est pas un nœud.
   *
   * Sans elles, « l'utilisateur est redirigé vers la connexion » — donc toute
   * la famille des parcours d'authentification et de droits d'accès — reste
   * inexprimable, alors que le moteur observe déjà `location` à chaque
   * instantané.
   */
  | { check: 'urlContains'; value: string }
  | { check: 'urlEquals'; value: string }
  /**
   * Les deux vérifications qui portent sur ce que l'application a *fait*,
   * pas sur ce qu'elle affiche.
   *
   * `allow` liste des fragments d'URL ou de message tolérés : une intégration
   * tierce bruyante ne doit pas apprendre à l'équipe à désactiver le garde-fou.
   * Elles ne sont évaluées qu'une fois : une erreur console ne devient pas
   * fausse en attendant.
   */
  | { check: 'noFailedRequests'; allow?: string[] }
  | { check: 'noConsoleErrors'; allow?: string[] };

/** Vrai pour les vérifications portant sur les observations, pas sur l'arbre. */
export function isObservationCheck(check: Check): boolean {
  return check.check === 'noFailedRequests' || check.check === 'noConsoleErrors';
}

export interface StepResolution {
  /**
   * Une intention se traduit souvent en plusieurs gestes primitifs
   * (« se connecter » = saisir l'identifiant, saisir le mot de passe, valider).
   * Les assertions et les captures sont évaluées une fois, après le dernier.
   */
  actions: Action[];
  assertions?: Record<string, Check>;
  captures?: Record<string, CaptureSpec>;
  /** Horodatage de la dernière réparation, `null` si la résolution est d'origine. */
  healedAt?: string | null;
  healNote?: string;
}

/**
 * Version du **format** de résolution, pas de l'application testée.
 *
 * Un fichier sans champ `version` vaut 1 : c'est ce que produisaient les
 * versions antérieures, et refuser de les lire casserait toutes les suites
 * existantes. Le numéro ne monte que lorsque l'observation change — un arbre
 * enrichi peut rendre un locator enregistré ambigu, et il vaut mieux le dire
 * qu'échouer six étapes plus loin.
 *
 * **v2** : les deux commits qui précèdent élargissent les noms observés. Le
 * texte d'un conteneur générique entre dans l'arbre, et le libellé d'une icône
 * contribue au nom de son bouton. Une résolution v1 verte peut donc devenir
 * rouge sans que l'application ait bougé — « Total » qui n'apparaissait qu'une
 * fois peut désormais apparaître deux, et `button "Élèves"` s'appelle
 * maintenant `button "team Élèves"`. Le numéro est là pour que ce soit dit,
 * plutôt que découvert.
 */
export const RESOLUTION_VERSION = 2;

export interface Resolution {
  /** Absent dans les fichiers d'avant l'introduction du champ : vaut 1. */
  version?: number;
  scenario: string;
  platform: Platform;
  recordedAt: string;
  appVersion?: string;
  steps: Record<string, StepResolution>;
}

const WITH_TARGET = new Set(['click', 'fill', 'select', 'scrollTo', 'hover', 'upload']);

/** Les actions sans cible (navigate, press, swipe) ne peuvent pas être réparées. */
export function targetOf(action: Action): ResolvedTarget | null {
  return WITH_TARGET.has(action.kind) ? ((action as { target: ResolvedTarget }).target ?? null) : null;
}

export function withTarget(action: Action, target: ResolvedTarget): Action {
  return targetOf(action) === null ? action : { ...action, target } as Action;
}

/**
 * La valeur littérale d'une action, quand elle en porte une.
 *
 * Ces valeurs sont des templates : elles sont interpolées au moment d'agir —
 * au rejeu comme à la génération — et jamais à l'écriture. C'est ce qui permet
 * à un mot de passe de rester dans l'environnement plutôt que dans un fichier
 * versionné, et à une saisie de reprendre ce qu'une étape précédente a lu.
 */
export function valueOf(action: Action): string | null {
  if (action.kind === 'fill') return action.value;
  if (action.kind === 'select') return action.option;
  return null;
}

export function withValue(action: Action, value: string): Action {
  if (action.kind === 'fill') return { ...action, value };
  if (action.kind === 'select') return { ...action, option: value };
  return action;
}
