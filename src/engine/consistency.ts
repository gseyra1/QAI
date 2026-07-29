import type { Platform } from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { appliesTo, expectationsOf } from '../scenario/types.ts';

export type IssueKind =
  | 'missing-step'
  | 'orphan-step'
  | 'missing-assertion'
  | 'missing-capture'
  | 'no-actions';

export interface ConsistencyIssue {
  kind: IssueKind;
  stepId: string;
  detail?: string;
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

  for (const step of scenario.steps) {
    if (!appliesTo(step, platform)) continue;
    known.add(step.id);

    const cached = resolution.steps[step.id];
    if (cached === undefined) {
      issues.push({ kind: 'missing-step', stepId: step.id });
      continue;
    }

    if (cached.actions.length === 0) {
      issues.push({ kind: 'no-actions', stepId: step.id });
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
      return `étape « ${issue.stepId} » : aucune résolution en cache`;
    case 'orphan-step':
      return `résolution orpheline « ${issue.stepId} » : l'étape n'existe plus dans le scénario`;
    case 'missing-assertion':
      return `étape « ${issue.stepId} » : assertion sans forme machine — « ${issue.detail} »`;
    case 'missing-capture':
      return `étape « ${issue.stepId} » : capture « ${issue.detail} » non résolue`;
    case 'no-actions':
      return `étape « ${issue.stepId} » : aucune action`;
  }
}
