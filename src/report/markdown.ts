import type { StepReport } from '../engine/run.ts';
import type { SuiteReport } from '../engine/suite.ts';

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
  passed: '✅ QAI — tout est vert',
  healed: '🟠 QAI — réparé, à relire',
  failed: '❌ QAI — régression détectée',
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
  for (const note of step.healNotes ?? []) lines.push(`  - réparé : ${note}`);
  for (const warning of step.warnings ?? []) lines.push(`  - ⚠️ ${warning}`);

  if (step.screenshot !== undefined) {
    lines.push(
      options.runUrl === undefined
        ? `  - capture : \`${step.screenshot}\``
        : `  - [capture de l'écran au moment de l'échec](${options.runUrl}) (\`${step.screenshot}\`)`,
    );
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
  const lines: string[] = [
    COMMENT_MARKER,
    `## ${HEADLINE[report.status]}`,
    '',
    `${report.entries.length} parcours en ${seconds(report.durationMs)}.`,
    '',
    '| | Parcours | Résultat | Durée |',
    '|:-:|---|---|---:|',
  ];

  for (const entry of report.entries) {
    if (entry.report === null) {
      lines.push(`| ❌ | \`${entry.scenarioId}\` | erreur d'exécution | — |`);
      continue;
    }
    const { status, durationMs } = entry.report;
    const label = status === 'passed' ? 'réussi' : status === 'healed' ? 'réparé' : 'échec';
    lines.push(`| ${MARK[status]} | \`${entry.scenarioId}\` | ${label} | ${seconds(durationMs)} |`);
  }

  for (const entry of report.entries) {
    if (entry.report === null) {
      lines.push('', `### \`${entry.scenarioId}\``, '', entry.error ?? 'échec inconnu');
      continue;
    }
    if (entry.report.status === 'passed') continue;

    lines.push('', `### \`${entry.scenarioId}\``, '');
    for (const step of entry.report.steps) {
      if (step.status === 'passed' || step.status === 'skipped') continue;
      lines.push(...stepDetail(step, options));
    }
  }

  const heals = report.entries.reduce((total, e) => total + (e.report?.healCount ?? 0), 0);
  lines.push('');

  if (report.status === 'failed') {
    lines.push(
      '> Aucune réparation n\'a été appliquée sur un échec d\'assertion : c\'est une régression de l\'application, pas un test périmé.',
    );
  }
  if (heals > 0) {
    lines.push(
      `> ${heals} réparation(s) écrite(s) dans \`.qai/resolutions/\` — **relire le diff avant de fusionner**.`,
    );
  }
  if (options.runUrl !== undefined && options.artifactName !== undefined) {
    lines.push('', `Captures d'écran : artefact \`${options.artifactName}\` de [l'exécution](${options.runUrl}).`);
  }

  return `${lines.join('\n')}\n`;
}
