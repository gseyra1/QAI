import type { Platform } from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario, Step } from '../scenario/types.ts';
import { appliesTo, expectationsOf, isEmptyOn, isVerificationOnly } from '../scenario/types.ts';

export type IssueKind =
  | 'missing-step'
  | 'orphan-step'
  | 'missing-assertion'
  | 'missing-capture'
  | 'no-actions'
  | 'unexpected-actions'
  | 'empty-step'
  | 'platform-mismatch'
  | 'relative-navigate';

export interface ConsistencyIssue {
  kind: IssueKind;
  stepId: string;
  detail?: string;
}

/**
 * La forme qu'impose l'étape à ses gestes, sur cette plateforme.
 *
 * Les trois sens comptent. Une intention sans geste n'est jamais accomplie ;
 * une étape devenue simple vérification qui garde ses gestes les rejoue en
 * silence — ceux d'une version antérieure de l'étape, que plus personne ne
 * demande ni ne relit ; une étape qui n'agit ni ne vérifie ici serait un vert
 * vide. Partagé avec le rejeu, qui ne doit pas dépendre d'un appel préalable
 * à ce contrôle pour refuser ces trois cas.
 */
export function actionsIssue(
  step: Step,
  platform: Platform,
  actionCount: number,
): ConsistencyIssue | null {
  if (isEmptyOn(step, platform)) {
    return { kind: 'empty-step', stepId: step.id, detail: platform };
  }
  if (isVerificationOnly(step, platform)) {
    return actionCount > 0
      ? { kind: 'unexpected-actions', stepId: step.id, detail: String(actionCount) }
      : null;
  }
  return actionCount === 0 ? { kind: 'no-actions', stepId: step.id } : null;
}

/**
 * Vérifie qu'un scénario et sa résolution parlent bien du même parcours.
 *
 * C'est le contrôle qui détecte la dérive silencieuse : une étape ajoutée sans
 * régénérer le cache, une assertion reformulée dont la forme machine est restée
 * sur l'ancien texte, une résolution orpheline après suppression d'une étape.
 * Rien de tout cela ne casse à l'exécution — ça produit des faux verts.
 */
export function checkConsistency(
  scenario: Scenario,
  resolution: Resolution,
  platform: Platform,
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const known = new Set<string>();

  /**
   * Une résolution est propre à une plateforme : ses cibles décrivent un
   * arbre précis. Rejouer une résolution web sur iOS ferait réparer, puis
   * réécrire, un fichier qui resterait marqué « web ». Le refus est global :
   * le reste du contrôle n'aurait aucun sens sur l'autre plateforme.
   */
  if (resolution.platform !== platform) {
    return [{ kind: 'platform-mismatch', stepId: '*', detail: `${resolution.platform} ≠ ${platform}` }];
  }

  for (const step of scenario.steps) {
    if (!appliesTo(step, platform)) continue;
    known.add(step.id);

    const cached = resolution.steps[step.id];
    if (cached === undefined) {
      issues.push({ kind: 'missing-step', stepId: step.id });
      continue;
    }

    const shape = actionsIssue(step, platform, cached.actions.length);
    if (shape !== null) issues.push(shape);

    // Hors du web, il n'y a pas d'URL de base : un chemin relatif ne désigne
    // rien. Le dire avant de jouer vaut mieux qu'un échec à mi-parcours,
    // après des gestes déjà faits sur l'appareil.
    if (platform !== 'web') {
      for (const action of cached.actions) {
        if (action.kind !== 'navigate') continue;
        const to = action.to.trim();
        if (to === '.' || to === '/' || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(to)) continue;
        issues.push({ kind: 'relative-navigate', stepId: step.id, detail: action.to });
      }
    }

    for (const assertion of expectationsOf(step)) {
      if (cached.assertions?.[assertion] === undefined) {
        issues.push({ kind: 'missing-assertion', stepId: step.id, detail: assertion });
      }
    }

    for (const name of Object.keys(step.capture ?? {})) {
      if (cached.captures?.[name] === undefined) {
        issues.push({ kind: 'missing-capture', stepId: step.id, detail: name });
      }
    }
  }

  for (const stepId of Object.keys(resolution.steps)) {
    if (!known.has(stepId)) issues.push({ kind: 'orphan-step', stepId });
  }

  return issues;
}

export function formatIssue(issue: ConsistencyIssue): string {
  switch (issue.kind) {
    case 'missing-step':
      return `step "${issue.stepId}": no cached resolution`;
    case 'orphan-step':
      return `orphan resolution "${issue.stepId}": the step no longer exists in the scenario`;
    case 'missing-assertion':
      return `step "${issue.stepId}": assertion without machine form — "${issue.detail}"`;
    case 'missing-capture':
      return `step "${issue.stepId}": capture "${issue.detail}" not resolved`;
    case 'no-actions':
      return `step "${issue.stepId}": no actions, but the step has an intent — regenerate with "qai resolve"`;
    case 'empty-step':
      return `step "${issue.stepId}": no intent and nothing to verify on ${issue.detail} — add expect or capture, or restrict the step with "only"`;
    case 'unexpected-actions':
      return `step "${issue.stepId}": verification-only step, but the cached resolution still has ${issue.detail} action(s) — regenerate with "qai resolve"`;
    case 'platform-mismatch':
      return `the resolution was written for another platform (${issue.detail ?? ''}): regenerate it with "qai resolve"`;
    case 'relative-navigate':
      return `step "${issue.stepId}": navigate "${issue.detail ?? ''}" is a relative path, which has no meaning without a base URL — use a deep link, "." or "/"`;
  }
}
