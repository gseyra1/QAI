import type { StepReport } from '../engine/run.ts';
import type { SuiteEntry, SuiteReport } from '../engine/suite.ts';

export interface JUnitOptions {
  /**
   * Une réparation devient un échec.
   *
   * Le rapport doit dire la même chose que le code de sortie : avec `--strict`,
   * une suite réparée fait échouer la commande, donc laisser JUnit la déclarer
   * verte donnerait deux verdicts contradictoires pour la même exécution.
   */
  strict?: boolean;
}

/**
 * Les cinq caractères que XML réserve.
 *
 * Les noms d'étape et les messages d'assertion viennent de l'utilisateur et
 * contiennent des guillemets français, des chevrons, des esperluettes. Un
 * fichier mal échappé n'est pas ingéré du tout : la CI n'affiche alors aucun
 * test, ce qui se lit comme « tout va bien ».
 */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Les caractères de contrôle sont interdits en XML 1.0, même échappés.
 *
 * Une trace de driver peut en contenir (retour chariot, échappement ANSI d'une
 * sortie colorée). Les laisser passer casserait le document entier.
 */
function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

function attribute(text: string): string {
  return escape(clean(text));
}

/** JUnit compte en secondes ; le moteur mesure en millisecondes. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function stepBody(step: StepReport, strict: boolean): string[] {
  const lines: string[] = [];

  if (step.status === 'skipped') {
    lines.push('      <skipped/>');
    return lines;
  }

  if (step.status === 'failed') {
    const reasons = [
      ...(step.error !== undefined ? [step.error] : []),
      ...step.failures.map((failure) => `${failure.assertion} — ${failure.reason}`),
    ];
    const message = reasons[0] ?? 'échec';
    lines.push(`      <failure message="${attribute(message)}" type="assertion">`);
    for (const reason of reasons) lines.push(`        ${escape(clean(reason))}`);
    if (step.screenshot !== undefined) {
      lines.push(`        capture : ${escape(clean(step.screenshot))}`);
    }
    lines.push('      </failure>');
    return lines;
  }

  if (step.status === 'healed') {
    const notes = step.healNotes ?? [];
    const message = `réparé : ${notes.join(' ; ')}`;
    if (strict) {
      lines.push(`      <failure message="${attribute(message)}" type="healed"/>`);
    } else {
      // Un vert avec une note, pas un vert silencieux : la réparation doit
      // rester visible dans l'outil qui ingère le fichier.
      lines.push(`      <system-out>${escape(clean(message))}</system-out>`);
    }
  }

  for (const warning of step.warnings ?? []) {
    lines.push(`      <system-err>${escape(clean(warning))}</system-err>`);
  }

  return lines;
}

function testsuite(entry: SuiteEntry, strict: boolean): string[] {
  const report = entry.report;
  const name = attribute(entry.scenarioId);

  /**
   * Un parcours qui n'a pas pu démarrer n'a aucune étape à rapporter. Le
   * rendre en suite vide le ferait disparaître du tableau de bord ; on lui
   * fabrique donc un cas unique qui porte l'erreur.
   */
  if (report === null) {
    return [
      `  <testsuite name="${name}" tests="1" failures="1" skipped="0" time="0.000">`,
      `    <testcase name="${name}" classname="${name}" time="0.000">`,
      `      <failure message="${attribute(entry.error ?? 'le parcours n\'a pas pu être exécuté')}" type="error"/>`,
      '    </testcase>',
      '  </testsuite>',
    ];
  }

  const failures = report.steps.filter(
    (step) => step.status === 'failed' || (strict && step.status === 'healed'),
  ).length;
  const skipped = report.steps.filter((step) => step.status === 'skipped').length;

  const lines = [
    `  <testsuite name="${name}" tests="${report.steps.length}" failures="${failures}" skipped="${skipped}" time="${seconds(report.durationMs)}" timestamp="${attribute(report.startedAt)}">`,
  ];

  for (const step of report.steps) {
    // Le nom du cas porte l'intention, pas seulement l'identifiant : c'est ce
    // qu'un développeur lit dans l'onglet « Tests » de sa CI, et « s4 » ne lui
    // apprend rien.
    const label = step.intent === '' ? step.stepId : `${step.stepId} — ${step.intent}`;
    const body = stepBody(step, strict);
    const head = `    <testcase name="${attribute(label)}" classname="${name}" time="${seconds(step.durationMs)}"`;

    if (body.length === 0) {
      lines.push(`${head}/>`);
      continue;
    }
    lines.push(`${head}>`, ...body, '    </testcase>');
  }

  lines.push('  </testsuite>');
  return lines;
}

/**
 * Le format d'ingestion universel des CI (GitLab, Jenkins, Azure).
 *
 * Une suite JUnit vaut un parcours, un cas vaut une étape : c'est la
 * projection qui conserve l'information utile — quelle étape a lâché, et sur
 * quelle assertion — là où un cas par parcours réduirait tout à un booléen.
 */
export function formatJUnit(report: SuiteReport, options: JUnitOptions = {}): string {
  const strict = options.strict === true;

  const counted = report.entries.map((entry) => {
    const steps = entry.report?.steps ?? [];
    return {
      tests: entry.report === null ? 1 : steps.length,
      failures:
        entry.report === null
          ? 1
          : steps.filter((step) => step.status === 'failed' || (strict && step.status === 'healed'))
              .length,
      skipped: steps.filter((step) => step.status === 'skipped').length,
    };
  });

  const total = counted.reduce(
    (sum, one) => ({
      tests: sum.tests + one.tests,
      failures: sum.failures + one.failures,
      skipped: sum.skipped + one.skipped,
    }),
    { tests: 0, failures: 0, skipped: 0 },
  );

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="qai" tests="${total.tests}" failures="${total.failures}" skipped="${total.skipped}" time="${seconds(report.durationMs)}">`,
    ...report.entries.flatMap((entry) => testsuite(entry, strict)),
    '</testsuites>',
  ];

  return `${lines.join('\n')}\n`;
}
