import type { AppliedHeal } from '../engine/run.ts';
import type { Resolution, StepResolution } from './types.ts';
import { withTarget } from './types.ts';

/**
 * Réinjecte les réparations d'un run dans le fichier de résolution.
 *
 * C'est ce qui transforme une réparation en **diff relu en revue** plutôt qu'en
 * ajustement invisible côté serveur : le développeur voit exactement ce que
 * l'agent a changé, avec la raison, et l'accepte en fusionnant.
 */
export function applyHeals(
  resolution: Resolution,
  heals: readonly AppliedHeal[],
  at: string = new Date().toISOString(),
): Resolution {
  if (heals.length === 0) return resolution;

  const steps: Record<string, StepResolution> = { ...resolution.steps };

  for (const heal of heals) {
    const step = steps[heal.stepId];
    if (step === undefined) continue;

    const actions = [...step.actions];
    const action = actions[heal.actionIndex];
    if (action === undefined) continue;
    actions[heal.actionIndex] = withTarget(action, heal.target);

    const previous = step.healNote;
    const note = heal.degraded
      ? `${heal.note} (ciblage sémantique perdu : seul le repli technique fonctionne)`
      : heal.note;

    steps[heal.stepId] = {
      ...step,
      actions,
      healedAt: at,
      healNote: previous === undefined || previous === '' ? note : `${previous} ; ${note}`,
    };
  }

  return { ...resolution, steps };
}
