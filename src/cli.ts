import { parseArgs } from 'node:util';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from './driver/web/PlaywrightWebDriver.ts';
import { checkConsistency } from './engine/consistency.ts';
import { runScenario } from './engine/run.ts';
import { generateResolution } from './generate/generate.ts';
import { ModelHealer } from './heal/ModelHealer.ts';
import { BudgetedProvider } from './model/budget.ts';
import type { ModelProvider, Pricing } from './model/types.ts';
import { formatIssues, formatReport } from './report/text.ts';
import { applyHeals } from './resolution/apply.ts';
import { loadResolution } from './resolution/load.ts';
import { saveResolution } from './resolution/save.ts';
import { loadScenario } from './scenario/load.ts';
import type { Scenario } from './scenario/types.ts';

const USAGE = `qai — agent QA

  qai run     <scenario.qai.yaml> --base-url <url> [--heal --provider <module>]
  qai check   <scenario.qai.yaml> [options]
  qai resolve <scenario.qai.yaml> --base-url <url> --provider <module> [options]

Options
  --base-url <url>      racine de l'application testée
  --resolution <path>   défaut : <dossier>/.qai/resolutions/<id>.<platform>.json
  --platform <nom>      web (défaut). ios et android à venir.
  --provider <module>   module exportant par défaut un ModelProvider, et
                        éventuellement une constante « pricing »
  --heal                réparer les cibles périmées et réécrire la résolution
  --max-cost <n>        plafond de dépense pour la génération ou la réparation
  --attempts <n>        tentatives par étape (défaut 3)
  --json                sortie machine
  --strict              une réparation fait échouer la commande
  --headed              afficher le navigateur

Codes de sortie : 0 réussi ou réparé, 1 échec ou incohérence.
`;

function defaultResolutionPath(scenarioPath: string, scenario: Scenario, platform: string): string {
  return join(dirname(scenarioPath), '.qai', 'resolutions', `${scenario.id}.${platform}.json`);
}

/**
 * Charge le fournisseur de modèle de l'utilisateur.
 *
 * QAI n'embarque aucun SDK : le module est fourni au lancement et doit exporter
 * par défaut un `ModelProvider` — ou une fabrique qui en rend un.
 */
async function loadProvider(
  path: string,
): Promise<{ provider: ModelProvider; pricing?: Pricing }> {
  const module: Record<string, unknown> = await import(
    pathToFileURL(resolvePath(path)).href
  );
  const exported = module['default'];
  const provider = (typeof exported === 'function' ? await exported() : exported) as ModelProvider;

  if (provider === undefined || typeof provider.complete !== 'function') {
    throw new Error(`${path} doit exporter par défaut un ModelProvider`);
  }

  const pricing = module['pricing'] as Pricing | undefined;
  return pricing === undefined ? { provider } : { provider, pricing };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      resolution: { type: 'string' },
      platform: { type: 'string', default: 'web' },
      provider: { type: 'string' },
      'max-cost': { type: 'string' },
      heal: { type: 'boolean', default: false },
      attempts: { type: 'string' },
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

  const newDriver = (): PlaywrightWebDriver =>
    new PlaywrightWebDriver(() => chromium.launch({ headless: values.headed !== true }));

  if (command === 'resolve') {
    const baseUrl = values['base-url'];
    if (baseUrl === undefined || values.provider === undefined) {
      process.stderr.write('--base-url et --provider sont obligatoires\n');
      return 1;
    }

    const { provider, pricing } = await loadProvider(values.provider);
    const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);

    if (maxCost !== undefined && pricing === undefined) {
      process.stderr.write('--max-cost exige que le module fournisseur exporte « pricing »\n');
      return 1;
    }

    const budgeted =
      maxCost !== undefined && pricing !== undefined
        ? new BudgetedProvider(provider, pricing, { maxCost })
        : provider;

    const driver = newDriver();
    try {
      await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
      const result = await generateResolution({
        scenario,
        driver,
        provider: budgeted,
        ...(values.attempts !== undefined ? { attemptsPerStep: Number(values.attempts) } : {}),
      });

      if (values.json === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        for (const step of result.steps) {
          const mark = step.status === 'resolved' ? '✓' : step.status === 'skipped' ? '⊘' : '✖';
          process.stdout.write(`  ${mark} ${step.stepId.padEnd(4)} ${step.intent}\n`);
          for (const rejection of step.rejections) {
            process.stdout.write(`        essai rejeté : ${rejection}\n`);
          }
        }
      }

      if (result.status !== 'complete') {
        process.stderr.write('\nrésolution incomplète : rien n\'a été écrit\n');
        return 1;
      }

      await saveResolution(resolutionPath, result.resolution);
      process.stdout.write(`\nécrit dans ${resolutionPath}\n`);
      return 0;
    } finally {
      await driver.dispose();
    }
  }

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

  if (values.heal === true && values.provider === undefined) {
    process.stderr.write('--heal exige --provider\n');
    return 1;
  }

  const driver = newDriver();
  try {
    await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });

    let healer;
    if (values.heal === true && values.provider !== undefined) {
      const { provider, pricing } = await loadProvider(values.provider);
      const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);
      const bounded =
        maxCost !== undefined && pricing !== undefined
          ? new BudgetedProvider(provider, pricing, { maxCost })
          : provider;
      healer = new ModelHealer({ driver, provider: bounded });
    }

    const report = await runScenario(
      healer === undefined
        ? { scenario, resolution, driver }
        : { scenario, resolution, driver, healer },
    );

    process.stdout.write(
      values.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`,
    );

    if (report.heals.length > 0) {
      // Écrire la résolution réparée est ce qui transforme la réparation en
      // diff relu en revue plutôt qu'en ajustement invisible.
      await saveResolution(resolutionPath, applyHeals(resolution, report.heals));
      process.stdout.write(`\n${resolutionPath} mis à jour : relire le diff avant de fusionner.\n`);
    }

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
