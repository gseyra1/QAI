import type { Platform } from '../driver/types.ts';

/** Cibles déclarables dans un scénario. `mobile` couvre iOS et Android. */
export type TargetPlatform = Platform | 'mobile';

export interface Step {
  id: string;
  /**
   * L'intention par défaut, valable sur toutes les plateformes. Quand ni elle
   * ni `per_platform` ne donnent d'intention pour une plateforme, l'étape n'y
   * fait que vérifier : voir `isVerificationOnly`.
   */
  do?: string;
  /** Reformulation quand le geste diffère réellement. Jamais `on` : YAML 1.1 en ferait un booléen. */
  per_platform?: Partial<Record<TargetPlatform, string>>;
  only?: TargetPlatform[];
  expect?: string | string[];
  capture?: Record<string, string>;
}

export interface Given {
  fixtures?: string[];
  state?: string;
}

export interface Scenario {
  id: string;
  title: string;
  tags?: string[];
  platforms?: TargetPlatform[];
  given?: Given;
  steps: Step[];
}

/** `ios` et `android` sont aussi couverts par une déclaration `mobile`. */
export function platformMatches(declared: TargetPlatform, actual: Platform): boolean {
  if (declared === actual) return true;
  return declared === 'mobile' && (actual === 'ios' || actual === 'android');
}

export function appliesTo(step: Step, platform: Platform): boolean {
  if (step.only === undefined) return true;
  return step.only.some((declared) => platformMatches(declared, platform));
}

/**
 * L'intention retenue pour une plateforme : la reformulation la plus spécifique
 * l'emporte, puis `mobile`, puis l'intention générique.
 */
export function intentFor(step: Step, platform: Platform): string {
  const specific = step.per_platform?.[platform];
  if (specific !== undefined) return specific;
  if (platform === 'ios' || platform === 'android') {
    const mobile = step.per_platform?.mobile;
    if (mobile !== undefined) return mobile;
  }
  return step.do ?? '';
}

/**
 * Une étape sans intention sur cette plateforme ne fait que vérifier.
 *
 * Défini par plateforme, pas par étape : `per_platform: { web: … }` sans `do`
 * agit sur le web et ne fait que vérifier sur mobile. Sa résolution n'a alors
 * aucune action, et c'est garanti à la génération, pas demandé au modèle.
 */
export function isVerificationOnly(step: Step, platform: Platform): boolean {
  return intentFor(step, platform) === '';
}

export function expectationsOf(step: Step): string[] {
  if (step.expect === undefined) return [];
  return Array.isArray(step.expect) ? step.expect : [step.expect];
}

/** L'étape affirme ou lit quelque chose de l'écran. */
export function verifies(step: Step): boolean {
  return expectationsOf(step).length > 0 || Object.keys(step.capture ?? {}).length > 0;
}

/**
 * Ni geste ni vérification sur cette plateforme : l'étape n'y prouve rien.
 *
 * Le chargeur ne peut pas l'exclure seul — il ignore la plateforme jouée, et
 * `per_platform: { mobile: … }` sans `expect` est légitime sur mobile. C'est
 * donc à la génération, au contrôle de cohérence et au rejeu de la refuser :
 * résolue avec zéro action et zéro assertion, elle compterait comme un vert.
 */
export function isEmptyOn(step: Step, platform: Platform): boolean {
  return isVerificationOnly(step, platform) && !verifies(step);
}

/**
 * Un scénario est retenu s'il porte **au moins un** des tags demandés.
 *
 * L'union, pas l'intersection : « --tags critical-path,paiement » veut dire
 * « le lot bloquant plus le paiement », lecture qui correspond à l'usage réel —
 * un lot de fumée en pull request, la suite entière la nuit. Une liste de tags
 * vide ne filtre rien.
 */
export function matchesTags(scenario: Scenario, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  return scenario.tags?.some((tag) => tags.includes(tag)) === true;
}

/** « a, b ,, c » → ['a', 'b', 'c'] — la virgule est le séparateur du shell. */
export function parseTags(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = typeof value === 'string' ? value.split(',') : value.flatMap((item) => item.split(','));
  return raw.map((tag) => tag.trim()).filter((tag) => tag !== '');
}
