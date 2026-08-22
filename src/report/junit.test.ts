import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScenarioReport, StepReport } from '../engine/run.ts';
import type { SuiteReport } from '../engine/suite.ts';
import { formatJUnit } from './junit.ts';

function step(partial: Partial<StepReport>): StepReport {
  return {
    stepId: 's1',
    intent: 'ouvrir la page',
    status: 'passed',
    failures: [],
    durationMs: 120,
    ...partial,
  };
}

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

function suite(entries: SuiteReport['entries'], status: SuiteReport['status'] = 'passed'): SuiteReport {
  return { status, entries, durationMs: 2000 };
}

function entry(report: ScenarioReport | null, error?: string): SuiteReport['entries'][number] {
  return {
    scenarioId: report?.scenarioId ?? 'parcours',
    resolutionPath: 'r.json',
    report,
    ...(error !== undefined ? { error } : {}),
  };
}

describe('rapport JUnit', () => {
  it('projette un parcours en suite et une étape en cas', () => {
    const xml = formatJUnit(
      suite([entry(scenario({ steps: [step({}), step({ stepId: 's2', intent: 'payer' })] }))]),
    );

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<testsuites name="qai" tests="2" failures="0" skipped="0" time="2\.000">/);
    assert.match(xml, /<testsuite name="parcours" tests="2" failures="0" skipped="0" time="1\.200"/);
    // Le nom du cas porte l'intention : « s2 » seul n'apprend rien à qui lit
    // l'onglet « Tests » de sa CI.
    assert.match(xml, /<testcase name="s2 — payer" classname="parcours" time="0\.120"\/>/);
  });

  it('rend l\'échec avec sa raison et l\'assertion fautive', () => {
    const xml = formatJUnit(
      suite(
        [
          entry(
            scenario({
              status: 'failed',
              steps: [
                step({
                  status: 'failed',
                  failures: [{ assertion: 'le total est 42', reason: 'attendu 42, observé 0' }],
                  screenshot: 'parcours-s1.png',
                }),
              ],
            }),
          ),
        ],
        'failed',
      ),
    );

    assert.match(xml, /failures="1"/);
    assert.match(xml, /<failure message="le total est 42 — attendu 42, observé 0" type="assertion">/);
    assert.match(xml, /parcours-s1\.png/);
  });

  it('marque une étape sautée sans la compter en échec', () => {
    const xml = formatJUnit(
      suite([entry(scenario({ steps: [step({ status: 'skipped', durationMs: 0 })] }))]),
    );

    assert.match(xml, /skipped="1"/);
    assert.match(xml, /<skipped\/>/);
    assert.match(xml, /failures="0"/);
  });

  /**
   * Trois états, pas deux : une réparation reste visible dans l'outil qui
   * ingère le fichier, sans faire échouer la suite tant que --strict est
   * absent.
   */
  it('rend une réparation en note, et en échec sous --strict', () => {
    const reparee = suite([
      entry(
        scenario({
          status: 'healed',
          steps: [step({ status: 'healed', healNotes: ['le libellé du bouton a changé'] })],
        }),
      ),
    ], 'healed');

    const souple = formatJUnit(reparee);
    assert.match(souple, /<system-out>réparé : le libellé du bouton a changé<\/system-out>/);
    assert.match(souple, /failures="0"/);

    const strict = formatJUnit(reparee, { strict: true });
    assert.match(strict, /<failure message="réparé : le libellé du bouton a changé" type="healed"\/>/);
    assert.match(strict, /<testsuites name="qai" tests="1" failures="1"/);
  });

  /**
   * Un fichier mal échappé n'est pas ingéré du tout, et la CI n'affiche alors
   * aucun test — ce qui se lit comme « tout va bien ».
   */
  it('échappe ce que XML réserve', () => {
    const xml = formatJUnit(
      suite(
        [
          entry(
            scenario({
              status: 'failed',
              steps: [
                step({
                  intent: 'cliquer sur <Envoyer> & "confirmer"',
                  status: 'failed',
                  error: "l'élément « a < b » est absent",
                }),
              ],
            }),
          ),
        ],
        'failed',
      ),
    );

    assert.doesNotMatch(xml, /name="cliquer sur <Envoyer>/);
    assert.match(xml, /&lt;Envoyer&gt; &amp; &quot;confirmer&quot;/);
    assert.match(xml, /a &lt; b/);
  });

  it('fabrique un cas pour un parcours qui n\'a pas pu démarrer', () => {
    const xml = formatJUnit(suite([entry(null, 'le navigateur a refusé de démarrer')], 'failed'));

    assert.match(xml, /tests="1" failures="1"/);
    assert.match(xml, /<failure message="le navigateur a refusé de démarrer" type="error"\/>/);
  });

  it('remonte un avertissement sans le transformer en échec', () => {
    const xml = formatJUnit(
      suite([
        entry(
          scenario({
            steps: [step({ warnings: ['atteint par son repli technique'] })],
          }),
        ),
      ]),
    );

    assert.match(xml, /<system-err>atteint par son repli technique<\/system-err>/);
    assert.match(xml, /failures="0"/);
  });
});
