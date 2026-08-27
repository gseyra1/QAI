import type { SuiteReport } from '../engine/suite.ts';
import { warningCount } from '../engine/suite.ts';
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
  passed: 'PASSED',
  healed: 'HEALED',
  failed: 'FAILED',
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
    lines.push(`        healed: ${note}`);
  }
  for (const warning of step.warnings ?? []) {
    lines.push(`        ⚠ ${warning}`);
  }

  /**
   * Les trois dernières, pas toutes : c'est ce qui vient de se passer qui
   * explique l'échec, et une liste de vingt lignes ne serait plus lue.
   */
  for (const entry of (step.network ?? []).slice(-3)) {
    lines.push(`        ↯ ${entry.method} ${entry.url} → ${entry.status ?? 'échec réseau'}`);
  }
  for (const error of (step.consoleErrors ?? []).slice(-3)) {
    lines.push(`        ⚡ console : ${error}`);
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
      `${report.healCount} repair(s): review the resolution diff before merging.`,
    );
  }
  if (report.status === 'failed') {
    lines.push('No repair applied: a false assertion is a regression.');
  }
  return lines.join('\n');
}

export function formatIssues(issues: ConsistencyIssue[]): string {
  if (issues.length === 0) return 'Scenario and resolution consistent.';
  return [`${issues.length} inconsistency(ies):`, ...issues.map((issue) => `  • ${formatIssue(issue)}`)].join(
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
    `${report.entries.length} journey(s) — ${HEADLINE[report.status]}   ${seconds(report.durationMs)}`,
    '',
  ];

  for (const entry of report.entries) {
    if (entry.report === null) {
      lines.push(`  ✖ ${entry.scenarioId.padEnd(22)} ERROR`);
      lines.push(`        ${entry.error ?? 'unknown failure'}`);
      continue;
    }

    const { status, steps, durationMs } = entry.report;
    lines.push(
      `  ${SCENARIO_MARK[status]} ${entry.scenarioId.padEnd(22)} ${HEADLINE[status].padEnd(7)} ${seconds(durationMs)}`,
    );

    for (const step of steps) {
      /**
       * Une étape verte qui porte un avertissement n'entre pas dans « rien à
       * faire » : c'est tout ce que le niveau `warn` des sentinelles produit,
       * puisqu'il ne change pas le statut. La taire rendait la montée
       * `warn` → `fail` impraticable — on ne jauge pas ce qu'on ne voit pas —
       * et forçait à passer en `--format json` pour lire sa propre CI.
       */
      const silencieuse = (step.warnings ?? []).length === 0;
      if (silencieuse && (step.status === 'passed' || step.status === 'skipped')) continue;
      // Décalées d'un cran : une étape ne doit pas se lire comme un parcours.
      lines.push(...formatStep(step).map((line) => `  ${line}`));
    }
  }

  const failures = report.entries.filter(
    (entry) => entry.error !== undefined || entry.report?.status === 'failed',
  ).length;
  const heals = report.entries.reduce((total, entry) => total + (entry.report?.healCount ?? 0), 0);
  const warnings = warningCount(report);

  lines.push('');
  if (failures > 0) lines.push(`${failures} journey(s) failed.`);
  if (heals > 0) lines.push(`${heals} repair(s): review the resolution diffs before merging.`);
  if (warnings > 0) {
    lines.push(`${warnings} warning(s): a watchdog set to "warn" reports without failing.`);
  }
  // « All green » ne doit pas couvrir un avertissement : annoncer le vert
  // complet sur une exécution qui en porte est précisément ce qui rend le
  // palier `warn` inutile.
  if (failures === 0 && heals === 0 && warnings === 0) lines.push('All green.');

  return lines.join('\n');
}
