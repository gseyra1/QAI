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
    assert.match(souple, /<system-out>healed: le libellé du bouton a changé<\/system-out>/);
    assert.match(souple, /failures="0"/);

    const strict = formatJUnit(reparee, { strict: true });
    assert.match(strict, /<failure message="healed: le libellé du bouton a changé" type="healed"\/>/);
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

  /**
   * Les caractères de contrôle sont interdits en XML 1.0 **même échappés** :
   * les encoder ne suffit pas, il faut les retirer. Une trace de driver en
   * contient facilement — échappement ANSI d'une sortie colorée, cloche,
   * octet nul d'une lecture binaire. Et l'échec est silencieux du pire côté :
   * un document invalide n'est pas ingéré du tout, donc la CI affiche zéro
   * test, ce qui se lit exactement comme « rien n'a échoué ».
   */
  it('retire les caractères de contrôle, qu\'échapper ne suffirait pas à valider', () => {
    const xml = formatJUnit(
      suite(
        [
          entry(
            scenario({
              status: 'failed',
              steps: [
                step({
                  intent: 'lire une sortie colorée',
                  status: 'failed',
                  error: '\u001B[31mrouge\u001B[0m\u0007cloche\u0000nul',
                }),
              ],
            }),
          ),
        ],
        'failed',
      ),
    );

    assert.doesNotMatch(
      xml,
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/,
      'aucun caractère interdit ne doit survivre, échappé ou non',
    );
    assert.match(xml, /\[31mrouge \[0m cloche nul/);

    /**
     * La contrepartie : tabulation, saut de ligne et retour chariot sont les
     * trois seuls caractères de contrôle **légaux** en XML 1.0. Les retirer
     * aussi écraserait une trace multi-lignes en une bouillie d'une ligne,
     * alors que c'est précisément la forme dans laquelle elle se lit.
     */
    const trace = formatJUnit(
      suite(
        [
          entry(
            scenario({
              status: 'failed',
              steps: [step({ status: 'failed', error: 'ligne 1\n\tligne 2 indentée' })],
            }),
          ),
        ],
        'failed',
      ),
    );
    assert.match(trace, /ligne 1\n\tligne 2 indentée/);
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
