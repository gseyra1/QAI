import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScenarioReport } from '../engine/run.ts';
import type { SuiteReport } from '../engine/suite.ts';
import { COMMENT_MARKER, formatMarkdown } from './markdown.ts';

function scenario(partial: Partial<ScenarioReport>): ScenarioReport {
  return {
    scenarioId: 'parcours',
    title: 'Un parcours',
    platform: 'web',
    status: 'passed',
    steps: [],
    captures: {},
    heals: [],
    healCount: 0,
    startedAt: '2026-08-01T10:00:00Z',
    durationMs: 1200,
    ...partial,
  };
}

function suite(entries: SuiteReport['entries'], status: SuiteReport['status']): SuiteReport {
  return { status, entries, durationMs: 2000 };
}

describe('rapport markdown', () => {
  it('commence par le marqueur qui permet de mettre à jour le commentaire', () => {
    const markdown = formatMarkdown(suite([], 'passed'));
    assert.ok(markdown.startsWith(COMMENT_MARKER), 'sans marqueur, la CI empilerait un commentaire par exécution');
  });

  it('ne déroule pas le détail des parcours verts', () => {
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              steps: [
                { stepId: 's1', intent: 'ouvrir', status: 'passed', failures: [], durationMs: 10 },
              ],
            }),
          },
        ],
        'passed',
      ),
    );

    assert.match(markdown, /✅ QAI/);
    assert.match(markdown, /\| `checkout` \| réussi \|/);
    assert.doesNotMatch(markdown, /### `checkout`/, 'un vert n\'a pas de section de détail');
  });

  it('détaille un échec, avec l\'assertion et la capture', () => {
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              status: 'failed',
              steps: [
                {
                  stepId: 's8',
                  intent: 'payer',
                  status: 'failed',
                  failures: [{ assertion: 'la commande est confirmée', reason: 'aucun élément' }],
                  screenshot: 'checkout-s8.png',
                  durationMs: 40,
                },
              ],
            }),
          },
        ],
        'failed',
      ),
      { runUrl: 'https://ci.example/run/7', artifactName: 'qai-captures' },
    );

    assert.match(markdown, /❌ QAI — régression détectée/);
    assert.match(markdown, /### `checkout`/);
    assert.match(markdown, /`la commande est confirmée` → aucun élément/);
    assert.match(markdown, /\[capture de l'écran[^\]]*\]\(https:\/\/ci\.example\/run\/7\)/);
    assert.match(markdown, /régression de l'application, pas un test périmé/);
  });

  it('signale une réparation et invite à relire le diff', () => {
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              status: 'healed',
              healCount: 1,
              steps: [
                {
                  stepId: 's6',
                  intent: 'commander',
                  status: 'healed',
                  failures: [],
                  healNotes: ['Le libellé du bouton a changé.'],
                  durationMs: 30,
                },
              ],
            }),
          },
        ],
        'healed',
      ),
    );

    assert.match(markdown, /🟠 QAI — réparé/);
    assert.match(markdown, /réparé : Le libellé du bouton a changé\./);
    assert.match(markdown, /relire le diff avant de fusionner/);
  });

  it('rapporte une erreur d\'exécution sans rapport de parcours', () => {
    const markdown = formatMarkdown(
      suite(
        [{ scenarioId: 'checkout', resolutionPath: 'r.json', report: null, error: 'navigateur injoignable' }],
        'failed',
      ),
    );

    assert.match(markdown, /erreur d'exécution/);
    assert.match(markdown, /navigateur injoignable/);
  });
});
