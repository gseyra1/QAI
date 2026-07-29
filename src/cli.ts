import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from './driver/web/PlaywrightWebDriver.ts';
import { checkConsistency } from './engine/consistency.ts';
import { runScenario } from './engine/run.ts';
import { formatIssues, formatReport } from './report/text.ts';
import { loadResolution } from './resolution/load.ts';
import { loadScenario } from './scenario/load.ts';
import type { Scenario } from './scenario/types.ts';

const USAGE = `qai — agent QA

  qai run   <scenario.qai.yaml> --base-url <url> [options]
  qai check <scenario.qai.yaml> [options]

Options
  --base-url <url>      racine de l'application testée (obligatoire pour run)
  --resolution <path>   défaut : <dossier>/.qai/resolutions/<id>.<platform>.json
  --platform <nom>      web (défaut). ios et android à venir.
  --json                sortie machine
  --strict              une réparation fait échouer la commande
  --headed              afficher le navigateur

Codes de sortie : 0 réussi ou réparé, 1 échec ou incohérence.
`;

function defaultResolutionPath(scenarioPath: string, scenario: Scenario, platform: string): string {
  return join(dirname(scenarioPath), '.qai', 'resolutions', `${scenario.id}.${platform}.json`);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      resolution: { type: 'string' },
      platform: { type: 'string', default: 'web' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [command, scenarioPath] = positionals;

  if (values.help === true || command === undefined || scenarioPath === undefined) {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (values.platform !== 'web') {
    process.stderr.write(`plateforme « ${values.platform} » non implémentée\n`);
    return 1;
  }

  const scenario = await loadScenario(scenarioPath);
  const resolutionPath =
    values.resolution ?? defaultResolutionPath(scenarioPath, scenario, values.platform);
  const resolution = await loadResolution(resolutionPath);

  const issues = checkConsistency(scenario, resolution, 'web');

  if (command === 'check') {
    process.stdout.write(
      values.json === true ? `${JSON.stringify(issues, null, 2)}\n` : `${formatIssues(issues)}\n`,
    );
    return issues.length === 0 ? 0 : 1;
  }

  if (command !== 'run') {
    process.stderr.write(`commande inconnue « ${command} »\n\n${USAGE}`);
    return 1;
  }

  if (issues.length > 0) {
    // Rejouer sur une paire incohérente produit des verts qui ne prouvent rien.
    process.stderr.write(`${formatIssues(issues)}\n`);
    return 1;
  }

  const baseUrl = values['base-url'];
  if (baseUrl === undefined) {
    process.stderr.write('--base-url est obligatoire\n');
    return 1;
  }

  const driver = new PlaywrightWebDriver(() => chromium.launch({ headless: values.headed !== true }));
  try {
    await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
    const report = await runScenario({ scenario, resolution, driver });

    process.stdout.write(
      values.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`,
    );

    if (report.status === 'failed') return 1;
    if (report.status === 'healed' && values.strict === true) return 1;
    return 0;
  } finally {
    await driver.dispose();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('cli.ts') === true;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
