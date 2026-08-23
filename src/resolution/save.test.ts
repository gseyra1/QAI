import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppliedHeal } from '../engine/run.ts';
import { applyHeals } from './apply.ts';
import { loadResolution, parseResolution } from './load.ts';
import { serializeResolution } from './save.ts';

const EXAMPLE = 'examples/.qai/resolutions/checkout-guest.web.json';

/**
 * Nombre de lignes ajoutées et supprimées, comme le compterait un vrai diff.
 *
 * Comparer ligne à ligne par index mesurerait le décalage provoqué par une
 * insertion, pas la taille du changement.
 */
function diffSize(before: string[], after: string[]): number {
  const remaining = new Map<string, number>();
  for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1);

  let added = 0;
  for (const line of after) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added += 1;
  }

  const removed = [...remaining.values()].reduce((total, count) => total + count, 0);
  return added + removed;
}

describe('sérialisation d\'une résolution', () => {
  it('garde les petits objets sur une ligne', () => {
    const source = parseResolution(
      JSON.stringify({
        scenario: 't',
        platform: 'web',
        recordedAt: '2026-01-01T00:00:00Z',
        steps: { s1: { actions: [{ kind: 'navigate', to: '/' }], healedAt: null } },
      }),
    );

    assert.match(
      serializeResolution(source),
      /"s1": \{ "actions": \[\{ "kind": "navigate", "to": "\/" \}\], "healedAt": null \}/,
    );
  });

  it('est idempotente : le fichier du dépôt est déjà canonique', async () => {
    const resolution = await loadResolution(EXAMPLE);
    const once = serializeResolution(resolution);
    const twice = serializeResolution(parseResolution(once));
    assert.equal(once, twice);
  });

  /**
   * C'est le test qui protège l'argument de confiance du produit : si une
   * réparation d'un mot produit des centaines de lignes de diff, personne ne
   * relit, et « la réparation est auditable » devient un slogan creux.
   */
  it('une réparation d\'un libellé ne bouge que quelques lignes', async () => {
    const before = await loadResolution(EXAMPLE);
    const heal: AppliedHeal = {
      stepId: 's6',
      actionIndex: 0,
      target: { primary: { role: 'button', name: 'Continuer sans compte' } },
      note: 'Le libellé du bouton a changé.',
      degraded: false,
    };

    const after = applyHeals(before, [heal], '2026-07-29T10:00:00Z');
    const changed = diffSize(
      serializeResolution(before).split('\n'),
      serializeResolution(after).split('\n'),
    );

    assert.ok(changed <= 6, `${changed} lignes de diff, attendu au plus 6`);
  });

  it('signale une dégradation du ciblage dans la note', async () => {
    const before = await loadResolution(EXAMPLE);
    const after = applyHeals(
      before,
      [
        {
          stepId: 's6',
          actionIndex: 0,
          target: { primary: { role: 'button' }, fallback: { testId: 'guest' } },
          note: 'Bouton relocalisé.',
          degraded: true,
        },
      ],
      '2026-07-29T10:00:00Z',
    );

    assert.match(after.steps['s6']?.healNote ?? '', /technical fallback/);
  });
});
