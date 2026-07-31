import type { SuiteReport } from '../engine/suite.ts';
import type { ScenarioReport, StepReport, StepStatus } from '../engine/run.ts';
import type { ConsistencyIssue } from '../engine/consistency.ts';
import { formatIssue } from '../engine/consistency.ts';

const MARK: Record<StepStatus, string> = {
  passed: '✓',
  healed: '~',
  failed: '✖',
  skipped: '⊘',
};

const HEADLINE = {
  passed: 'RÉUSSI',
  healed: 'RÉPARÉ',
  failed: 'ÉCHEC',
} as const;

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatStep(step: StepReport): string[] {
  const lines = [`  ${MARK[step.status]} ${step.stepId.padEnd(4)} ${step.intent}`];

  if (step.error !== undefined) lines.push(`        ${step.error}`);
  for (const failure of step.failures) {
    lines.push(`        ${failure.assertion} → ${failure.reason}`);
  }
  for (const note of step.healNotes ?? []) {
    lines.push(`        réparé : ${note}`);
  }
  for (const warning of step.warnings ?? []) {
    lines.push(`        ⚠ ${warning}`);
  }
  return lines;
}

export function formatReport(report: ScenarioReport): string {
  const lines: string[] = [
    `${report.scenarioId} — ${HEADLINE[report.status]}   ${seconds(report.durationMs)}`,
    `${report.title}`,
    '',
  ];

  for (const step of report.steps) lines.push(...formatStep(step));

  lines.push('');
  if (report.healCount > 0) {
    lines.push(
      `${report.healCount} réparation(s) : relire le diff de résolution avant de fusionner.`,
    );
  }
  if (report.status === 'failed') {
    lines.push('Aucune réparation appliquée : une assertion fausse est une régression.');
  }
  return lines.join('\n');
}

export function formatIssues(issues: ConsistencyIssue[]): string {
  if (issues.length === 0) return 'Scénario et résolution cohérents.';
  return [`${issues.length} incohérence(s) :`, ...issues.map((issue) => `  • ${formatIssue(issue)}`)].join(
    '\n',
  );
}

const SCENARIO_MARK = { passed: '✓', healed: '~', failed: '✖' } as const;

/**
 * Rapport de suite : une ligne par parcours, et le détail seulement là où il y
 * a quelque chose à faire. Un rapport qui déroule cinquante parcours verts ne
 * se lit pas — donc ne se lit pas du tout.
 */
export function formatSuite(report: SuiteReport): string {
  const lines: string[] = [
    `${report.entries.length} parcours — ${HEADLINE[report.status]}   ${seconds(report.durationMs)}`,
    '',
  ];

  for (const entry of report.entries) {
    if (entry.report === null) {
      lines.push(`  ✖ ${entry.scenarioId.padEnd(22)} ERREUR`);
      lines.push(`        ${entry.error ?? 'échec inconnu'}`);
      continue;
    }

    const { status, steps, durationMs } = entry.report;
    lines.push(
      `  ${SCENARIO_MARK[status]} ${entry.scenarioId.padEnd(22)} ${HEADLINE[status].padEnd(7)} ${seconds(durationMs)}`,
    );

    for (const step of steps) {
      if (step.status === 'passed' || step.status === 'skipped') continue;
      // Décalées d'un cran : une étape ne doit pas se lire comme un parcours.
      lines.push(...formatStep(step).map((line) => `  ${line}`));
    }
  }

  const failures = report.entries.filter(
    (entry) => entry.error !== undefined || entry.report?.status === 'failed',
  ).length;
  const heals = report.entries.reduce((total, entry) => total + (entry.report?.healCount ?? 0), 0);

  lines.push('');
  if (failures > 0) lines.push(`${failures} parcours en échec.`);
  if (heals > 0) lines.push(`${heals} réparation(s) : relire les diffs de résolution avant de fusionner.`);
  if (failures === 0 && heals === 0) lines.push('Tout est vert.');

  return lines.join('\n');
}
