import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScenarioReport, StepReport } from '../engine/run.ts';
import type { SuiteReport } from '../engine/suite.ts';
import { formatReport, formatSuite } from './text.ts';

function step(partial: Partial<StepReport> & Pick<StepReport, 'stepId'>): StepReport {
  return {
    intent: 'open the cart',
    status: 'passed',
    failures: [],
    durationMs: 12,
    ...partial,
  };
}

function scenario(partial: Partial<ScenarioReport>): ScenarioReport {
  return {
    scenarioId: 'checkout',
    title: 'A journey',
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

function suite(report: ScenarioReport, status: SuiteReport['status'] = 'passed'): SuiteReport {
  return {
    status,
    entries: [{ scenarioId: report.scenarioId, resolutionPath: 'r.json', report }],
    durationMs: 2000,
  };
}

describe('formatSuite', () => {
  /**
   * Le rapport n'a jamais déroulé les étapes vertes, et c'est délibéré : cent
   * lignes de succès ne se lisent pas. Mais un avertissement de sentinelle ne
   * change pas le statut — c'est ce qui sépare `warn` de `fail` — donc il
   * n'existait que sur des étapes vertes, c'est-à-dire nulle part.
   */
  it('affiche un avertissement porté par une étape verte', () => {
    const output = formatSuite(
      suite(
        scenario({
          steps: [
            step({
              stepId: 's4',
              warnings: ['2 failed request(s), including GET /api/reco → 500'],
            }),
          ],
        }),
      ),
    );

    assert.match(output, /⚠ 2 failed request\(s\), including GET \/api\/reco → 500/);
    assert.match(output, /1 warning\(s\)/);
  });

  /**
   * Sur iOS, les garde-fous sont refusés avant de lancer : un avertissement y
   * vient d'ailleurs (repli technique, secret trop court). L'attribuer à un
   * garde-fou « warn » enverrait chercher un réglage qui n'existe pas.
   */
  it('n\'attribue pas les avertissements à un garde-fou hors du web', () => {
    const warned = [step({ stepId: 's3', warnings: ['"Track parcel" was only reached through its technical fallback'] })];
    const ios = formatSuite(suite(scenario({ platform: 'ios', steps: warned })));
    assert.match(ios, /1 warning\(s\): reported without failing the run\./);
    assert.doesNotMatch(ios, /watchdog/);

    const web = formatSuite(suite(scenario({ steps: warned })));
    assert.match(web, /1 warning\(s\): a watchdog set to "warn" reports without failing\./);
  });

  it('cesse d\'annoncer « All green » quand l\'exécution porte un avertissement', () => {
    // Le palier `warn` sert à jauger avant de passer à `fail`. Un verdict qui
    // proclame le vert complet au-dessus d'avertissements rend cette mesure
    // impossible : personne ne va lire plus loin qu'une ligne qui dit que tout
    // va bien.
    const output = formatSuite(
      suite(scenario({ steps: [step({ stepId: 's4', warnings: ['1 console error(s)'] })] })),
    );

    assert.doesNotMatch(output, /All green\./);
  });

  it('reste muet et compact sur une suite réellement verte', () => {
    // La contrepartie : sans avertissement, rien ne change. Le rapport ne doit
    // pas se mettre à dérouler les étapes vertes sous prétexte du correctif.
    const output = formatSuite(suite(scenario({ steps: [step({ stepId: 's1' })] })));

    assert.match(output, /All green\./);
    assert.doesNotMatch(output, /open the cart/, 'une étape verte silencieuse n\'a rien à montrer');
    assert.doesNotMatch(output, /warning\(s\)/);
  });

  // Une étape qui ne fait que vérifier n'a pas d'intention : une ligne vide
  // après son identifiant laisserait croire à un scénario tronqué.
  it('nomme une étape qui ne fait que vérifier', () => {
    const output = formatSuite(
      suite(
        scenario({
          status: 'failed',
          steps: [
            step({
              stepId: 's2',
              intent: '',
              status: 'failed',
              failures: [{ assertion: 'the order is listed', reason: 'no element matches the target' }],
            }),
          ],
        }),
        'failed',
      ),
    );

    assert.match(output, /✖ s2 {3}\(verification only\)/);
    assert.match(output, /the order is listed → no element matches the target/);
  });

  it('ne nomme pas « vérification » une étape sautée sans intention', () => {
    // Le rapport d'un scénario montre aussi les étapes sautées.
    const output = formatReport(
      scenario({
        status: 'failed',
        steps: [
          step({ stepId: 's1', status: 'failed', error: 'boom' }),
          step({ stepId: 's2', intent: '', status: 'skipped' }),
        ],
      }),
    );

    assert.match(output, /⊘ s2/);
    assert.doesNotMatch(output, /verification only/);
  });
});
