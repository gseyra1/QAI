import type { StepReport } from '../engine/run.ts';
import type { SuiteReport } from '../engine/suite.ts';
import { warningCount } from '../engine/suite.ts';

/**
 * Marqueur invisible qui permet à la CI de retrouver son propre commentaire et
 * de le mettre à jour, au lieu d'en empiler un par exécution.
 */
export const COMMENT_MARKER = '<!-- qai-report -->';

export interface MarkdownOptions {
  /** Lien vers l'exécution CI, où les captures sont publiées en artefact. */
  runUrl?: string;
  artifactName?: string;
}

const HEADLINE = {
  passed: '✅ QAI — all green',
  healed: '🟠 QAI — healed, needs review',
  failed: '❌ QAI — regression detected',
} as const;

const MARK = { passed: '✅', healed: '🟠', failed: '❌', skipped: '⊘' } as const;

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function stepDetail(step: StepReport, options: MarkdownOptions): string[] {
  const lines = [`- ${MARK[step.status]} **${step.stepId}** — ${step.intent}`];

  if (step.error !== undefined) lines.push(`  - ${step.error}`);
  for (const failure of step.failures) {
    lines.push(`  - \`${failure.assertion}\` → ${failure.reason}`);
  }
  for (const note of step.healNotes ?? []) lines.push(`  - healed: ${note}`);
  for (const warning of step.warnings ?? []) lines.push(`  - ⚠️ ${warning}`);

  if (step.screenshot !== undefined) {
    lines.push(
      options.runUrl === undefined
        ? `  - screenshot: \`${step.screenshot}\``
        : `  - [screenshot at the moment of failure](${options.runUrl}) (\`${step.screenshot}\`)`,
    );
  }

  /**
   * Le réseau et la console à côté de la capture : c'est ce qui distingue « la
   * liste est vide » de « l'appel qui la remplit a rendu 500 ». Les trois
   * dernières entrées suffisent — au-delà, le commentaire de pull request
   * cesse d'être lu.
   */
  for (const entry of (step.network ?? []).slice(-3)) {
    lines.push(`  - ↯ \`${entry.method} ${entry.url}\` → ${entry.status ?? 'échec réseau'}`);
  }
  for (const error of (step.consoleErrors ?? []).slice(-3)) {
    lines.push(`  - ⚡ console : \`${error}\``);
  }
  return lines;
}

/**
 * Le rapport tel qu'il apparaît dans une pull request.
 *
 * Il ne déroule que ce qui demande une action : un commentaire qui liste
 * cinquante parcours verts ne se lit pas, donc ne se lit pas du tout. Le détail
 * n'apparaît que sous les parcours en échec ou réparés.
 */
export function formatMarkdown(report: SuiteReport, options: MarkdownOptions = {}): string {
  const warnings = warningCount(report);

  /**
   * Le statut reste `passed` — un palier `warn` ne fait pas échouer, c'est sa
   * raison d'être — mais « all green » au-dessus d'une exécution qui porte des
   * avertissements est un titre faux. Et le titre est ce que la plupart des
   * relecteurs lisent, souvent la seule chose.
   */
  const headline =
    report.status === 'passed' && warnings > 0
      ? '⚠️ QAI — green, with warnings'
      : HEADLINE[report.status];

  const lines: string[] = [
    COMMENT_MARKER,
    `## ${headline}`,
    '',
    `${report.entries.length} journey(s) in ${seconds(report.durationMs)}.`,
    '',
    '| | Journey | Result | Duration |',
    '|:-:|---|---|---:|',
  ];

  for (const entry of report.entries) {
    if (entry.report === null) {
      lines.push(`| ❌ | \`${entry.scenarioId}\` | execution error | — |`);
      continue;
    }
    const { status, durationMs } = entry.report;
    const label = status === 'passed' ? 'passed' : status === 'healed' ? 'healed' : 'failed';
    lines.push(`| ${MARK[status]} | \`${entry.scenarioId}\` | ${label} | ${seconds(durationMs)} |`);
  }

  for (const entry of report.entries) {
    if (entry.report === null) {
      lines.push('', `### \`${entry.scenarioId}\``, '', entry.error ?? 'unknown failure');
      continue;
    }
    // Un parcours vert qui a déclenché une sentinelle a quelque chose à
    // montrer : sans cette section, l'avertissement n'existe nulle part dans
    // le commentaire, et le palier `warn` ne sert à rien.
    const averti = entry.report.steps.some((step) => (step.warnings ?? []).length > 0);
    if (entry.report.status === 'passed' && !averti) continue;

    lines.push('', `### \`${entry.scenarioId}\``, '');
    for (const step of entry.report.steps) {
      const silencieuse = (step.warnings ?? []).length === 0;
      if (silencieuse && (step.status === 'passed' || step.status === 'skipped')) continue;
      lines.push(...stepDetail(step, options));
    }
  }

  const heals = report.entries.reduce((total, e) => total + (e.report?.healCount ?? 0), 0);
  lines.push('');

  if (report.status === 'failed') {
    lines.push(
      '> No repair was applied on an assertion failure: it is an application regression, not a stale test.',
    );
  }
  if (heals > 0) {
    lines.push(
      `> ${heals} repair(s) written to \`.qai/resolutions/\` — **review the diff before merging**.`,
    );
  }
  if (warnings > 0) {
    lines.push(
      `> ${warnings} warning(s) from watchdogs set to \`warn\`: reported, not failing. Raise them to \`fail\` once the list is empty.`,
    );
  }
  if (options.runUrl !== undefined && options.artifactName !== undefined) {
    lines.push('', `Screenshots: artifact \`${options.artifactName}\` from [the run](${options.runUrl}).`);
  }

  return `${lines.join('\n')}\n`;
}
