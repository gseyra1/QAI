import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Resolution, StepResolution } from './types.ts';

const HEADER =
  'Fichier généré par QAI. Ne pas éditer à la main — il est régénérable. Il est versionné pour que la CI rejoue de façon déterministe et pour qu\'une auto-réparation apparaisse en diff de revue.';

/**
 * Sérialise dans un ordre de clés fixe.
 *
 * Ce fichier vit dans git et son diff est ce qu'un développeur relit quand une
 * réparation lui est proposée. Un ordre de clés instable rendrait ce diff
 * illisible et ruinerait l'argument de confiance du produit.
 */
function orderStep(step: StepResolution): Record<string, unknown> {
  const ordered: Record<string, unknown> = { actions: step.actions };
  if (step.captures !== undefined) ordered['captures'] = step.captures;
  if (step.assertions !== undefined) ordered['assertions'] = step.assertions;
  ordered['healedAt'] = step.healedAt ?? null;
  if (step.healNote !== undefined) ordered['healNote'] = step.healNote;
  return ordered;
}

export function serializeResolution(resolution: Resolution): string {
  const document: Record<string, unknown> = {
    $comment: HEADER,
    scenario: resolution.scenario,
    platform: resolution.platform,
    recordedAt: resolution.recordedAt,
  };
  if (resolution.appVersion !== undefined) document['appVersion'] = resolution.appVersion;

  document['steps'] = Object.fromEntries(
    Object.entries(resolution.steps).map(([id, step]) => [id, orderStep(step)]),
  );

  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function saveResolution(path: string, resolution: Resolution): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeResolution(resolution), 'utf8');
}
