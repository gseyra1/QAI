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
  | { check: 'stateIs'; target: Locator; value: 'checked' | 'disabled' | 'selected' };

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
 */
export const RESOLUTION_VERSION = 1;

export interface Resolution {
  /** Absent dans les fichiers d'avant l'introduction du champ : vaut 1. */
  version?: number;
  scenario: string;
  platform: Platform;
  recordedAt: string;
  appVersion?: string;
  steps: Record<string, StepResolution>;
}

const WITH_TARGET = new Set(['click', 'fill', 'select', 'scrollTo', 'hover']);

/** Les actions sans cible (navigate, press, swipe) ne peuvent pas être réparées. */
export function targetOf(action: Action): ResolvedTarget | null {
  return WITH_TARGET.has(action.kind) ? ((action as { target: ResolvedTarget }).target ?? null) : null;
}

export function withTarget(action: Action, target: ResolvedTarget): Action {
  return targetOf(action) === null ? action : { ...action, target } as Action;
}
