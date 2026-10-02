import type { Action, Locator, Platform, ResolvedTarget } from '../driver/types.ts';
import { hasScheme } from './url.ts';

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
  /**
   * Depuis la v3, une valeur relative se résout contre la base de l'exécution
   * avant la comparaison : écrite absolue, elle portait le port de la machine
   * qui l'a générée et ne rejouait nulle part ailleurs.
   */
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
   *
   * Vide si, et seulement si, l'étape ne fait que vérifier : sans intention à
   * accomplir, tout geste serait inventé. La génération le garantit, et le
   * contrôle de cohérence attrape un cache qui l'a oublié.
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
 * existantes. Le numéro monte quand l'observation change — un arbre enrichi
 * peut rendre un locator enregistré ambigu, et il vaut mieux le dire
 * qu'échouer six étapes plus loin — et aussi quand le SENS d'un champ stocké
 * change : un QAI plus ancien lirait alors le même fichier autrement, et ses
 * verts ne prouveraient plus ce que le fichier affirme. Le refus d'un format
 * trop récent, dans `load.ts`, est ce qui l'en empêche.
 *
 * **v2** : les noms observés s'élargissent. Le texte d'un conteneur générique
 * entre dans l'arbre, et le libellé d'une icône contribue au nom de son
 * bouton. Une résolution v1 verte peut donc devenir rouge sans que
 * l'application ait bougé — « Total » qui n'apparaissait qu'une fois peut
 * désormais apparaître deux, et `button "Élèves"` s'appelle maintenant
 * `button "team Élèves"`.
 *
 * **v3** : deux sens nouveaux, aucune observation nouvelle. Une valeur
 * `urlEquals` relative se résout contre la base de l'exécution — c'est ce qui
 * rend une vérification d'adresse rejouable sur un autre port. Et `actions: []`
 * est permis, pour une étape qui ne fait que vérifier. Un QAI v2 comparerait la
 * valeur relative telle quelle et échouerait sans raison : il doit refuser le
 * fichier, pas le lire.
 */
export const RESOLUTION_VERSION = 3;

/**
 * La dernière version dont le changement portait sur l'observation.
 *
 * C'est elle, et non `RESOLUTION_VERSION`, qui décide de l'avertissement
 * « résolution périmée » : un fichier v2 est un fichier v3 parfaitement
 * valide — ses cibles ont été calculées sous l'observation d'aujourd'hui — et
 * l'avertir pousserait à régénérer pour rien, donc à ne plus lire
 * l'avertissement le jour où il comptera.
 */
export const OBSERVATION_VERSION = 2;

/**
 * La plus petite version qui donne à ce contenu le sens qu'il a ici.
 *
 * Un fichier n'est estampillé v3 que s'il use d'un sens nouveau de la v3 :
 * une étape sans action, ou un `urlEquals` qui n'est pas une adresse absolue
 * littérale (un gabarit sans schéma compte : sa valeur peut être relative à
 * l'exécution).
 * Sinon il reste à la version d'observation, lisible tel quel par un QAI qui
 * lit la v2 — une réparation en CI ne doit pas rendre illisible, pour un
 * coéquipier pas encore mis à jour, un fichier dont rien n'a changé de sens.
 */
export function requiredVersion(resolution: Pick<Resolution, 'steps'>): number {
  for (const step of Object.values(resolution.steps)) {
    if (step.actions.length === 0) return RESOLUTION_VERSION;
    for (const check of Object.values(step.assertions ?? {})) {
      if (check.check === 'urlEquals' && !hasScheme(check.value)) {
        return RESOLUTION_VERSION;
      }
    }
  }
  return OBSERVATION_VERSION;
}

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
