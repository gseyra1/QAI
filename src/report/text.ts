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
