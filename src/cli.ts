import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { Driver } from './driver/types.ts';
import { PlaywrightWebDriver } from './driver/web/PlaywrightWebDriver.ts';
import { checkConsistency, formatIssue } from './engine/consistency.ts';
import { generateResolution } from './generate/generate.ts';
import type { SuiteItem } from './engine/suite.ts';
import { runSuite } from './engine/suite.ts';
import { ModelHealer } from './heal/ModelHealer.ts';
import { BudgetedProvider } from './model/budget.ts';
import type { ModelProvider, Pricing } from './model/types.ts';
import { formatSuite } from './report/text.ts';
import { applyHeals } from './resolution/apply.ts';
import { loadResolution } from './resolution/load.ts';
import { saveResolution } from './resolution/save.ts';
import { loadScenario } from './scenario/load.ts';
import type { Scenario } from './scenario/types.ts';
import type { StateProvider } from './state/types.ts';

const USAGE = `qai — agent QA

  qai run     <scenarios…> --base-url <url> [--heal --provider <module>]
  qai check   <scenarios…>
  qai resolve <scenarios…> --base-url <url> --provider <module>

<scenarios…> accepte des fichiers, des dossiers ou un motif du shell.

Options
  --base-url <url>      racine de l'application testée
  --states <module>     module exportant par défaut un StateProvider, pour
                        installer l'état déclaré par « given »
  --provider <module>   module exportant par défaut un ModelProvider, et
                        éventuellement une constante « pricing »
  --workers <n>         parcours en parallèle (défaut : 4)
  --heal                réparer les cibles périmées et réécrire les résolutions
  --max-cost <n>        plafond de dépense du modèle
  --attempts <n>        tentatives par étape à la génération (défaut 3)
  --resolution <path>   forcer le chemin de résolution (un seul scénario)
  --json                sortie machine
  --strict              une réparation fait échouer la commande
  --headed              afficher le navigateur

Codes de sortie : 0 réussi ou réparé, 1 échec ou incohérence.
`;

function resolutionPathFor(scenarioPath: string, scenario: Scenario): string {
  return join(dirname(scenarioPath), '.qai', 'resolutions', `${scenario.id}.web.json`);
}

/** Un dossier vaut pour tous les scénarios qu'il contient. */
async function expand(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isDirectory()) {
      found.push(path);
      continue;
    }
    const entries = await readdir(path);
    for (const entry of entries.filter((name) => name.endsWith('.qai.yaml')).sort()) {
      found.push(join(path, entry));
    }
  }
  return found;
}

async function loadModule<T>(path: string, kind: string): Promise<{ value: T; pricing?: Pricing }> {
  const module: Record<string, unknown> = await import(pathToFileURL(resolvePath(path)).href);
  const exported = module['default'];
  const value = (typeof exported === 'function' ? await exported() : exported) as T;
  if (value === undefined || value === null) {
    throw new Error(`${path} doit exporter par défaut un ${kind}`);
  }
  const pricing = module['pricing'] as Pricing | undefined;
  return pricing === undefined ? { value } : { value, pricing };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      resolution: { type: 'string' },
      states: { type: 'string' },
      provider: { type: 'string' },
      workers: { type: 'string' },
      'max-cost': { type: 'string' },
      attempts: { type: 'string' },
      heal: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [command, ...scenarioArgs] = positionals;

  if (values.help === true || command === undefined || scenarioArgs.length === 0) {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  const paths = await expand(scenarioArgs);
  if (paths.length === 0) {
    process.stderr.write('aucun scénario trouvé\n');
    return 1;
  }
  if (values.resolution !== undefined && paths.length > 1) {
    process.stderr.write('--resolution ne vaut que pour un scénario unique\n');
    return 1;
  }

  const createDriver = (): Driver =>
    new PlaywrightWebDriver(() => chromium.launch({ headless: values.headed !== true }));

  const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);

  async function modelProvider(path: string): Promise<ModelProvider> {
    const { value, pricing } = await loadModule<ModelProvider>(path, 'ModelProvider');
    if (typeof value.complete !== 'function') {
      throw new Error(`${path} doit exporter par défaut un ModelProvider`);
    }
    if (maxCost === undefined) return value;
    if (pricing === undefined) {
      throw new Error('--max-cost exige que le module fournisseur exporte « pricing »');
    }
    return new BudgetedProvider(value, pricing, { maxCost });
  }

  if (command === 'resolve') {
    const baseUrl = values['base-url'];
    if (baseUrl === undefined || values.provider === undefined) {
      process.stderr.write('--base-url et --provider sont obligatoires\n');
      return 1;
    }
    const provider = await modelProvider(values.provider);
    let failed = false;

    for (const path of paths) {
      const scenario = await loadScenario(path);
      const driver = createDriver();
      try {
        await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
        const result = await generateResolution({
          scenario,
          driver,
          provider,
          ...(values.attempts !== undefined ? { attemptsPerStep: Number(values.attempts) } : {}),
        });

        process.stdout.write(`${scenario.id}\n`);
        for (const step of result.steps) {
          const mark = step.status === 'resolved' ? '✓' : step.status === 'skipped' ? '⊘' : '✖';
          process.stdout.write(`  ${mark} ${step.stepId.padEnd(4)} ${step.intent}\n`);
          for (const rejection of step.rejections) {
            process.stdout.write(`        essai rejeté : ${rejection}\n`);
          }
        }

        if (result.status !== 'complete') {
          process.stderr.write(`  résolution incomplète : rien n'a été écrit\n`);
          failed = true;
          continue;
        }

        const out = values.resolution ?? resolutionPathFor(path, scenario);
        await saveResolution(out, result.resolution);
        process.stdout.write(`  écrit dans ${out}\n`);
      } finally {
        await driver.dispose();
      }
    }
    return failed ? 1 : 0;
  }

  // `check` et `run` partagent le chargement et le contrôle de cohérence.
  const items: SuiteItem[] = [];
  let inconsistent = false;

  for (const path of paths) {
    const scenario = await loadScenario(path);
    const resolutionPath = values.resolution ?? resolutionPathFor(path, scenario);
    const resolution = await loadResolution(resolutionPath);
    const issues = checkConsistency(scenario, resolution, 'web');

    if (issues.length > 0) {
      inconsistent = true;
      process.stderr.write(`${scenario.id} : ${issues.length} incohérence(s)\n`);
      for (const issue of issues) process.stderr.write(`  • ${formatIssue(issue)}\n`);
      continue;
    }
    items.push({ scenario, resolution, resolutionPath });
  }

  if (command === 'check') {
    if (!inconsistent) process.stdout.write(`${items.length} parcours cohérents.\n`);
    return inconsistent ? 1 : 0;
  }

  if (command !== 'run') {
    process.stderr.write(`commande inconnue « ${command} »\n\n${USAGE}`);
    return 1;
  }

  // Rejouer sur une paire incohérente produit des verts qui ne prouvent rien.
  if (inconsistent) return 1;

  const baseUrl = values['base-url'];
  if (baseUrl === undefined) {
    process.stderr.write('--base-url est obligatoire\n');
    return 1;
  }
  if (values.heal === true && values.provider === undefined) {
    process.stderr.write('--heal exige --provider\n');
    return 1;
  }

  const states =
    values.states === undefined
      ? undefined
      : (await loadModule<StateProvider>(values.states, 'StateProvider')).value;

  const provider =
    values.heal === true && values.provider !== undefined
      ? await modelProvider(values.provider)
      : undefined;

  const report = await runSuite({
    items,
    baseUrl,
    createDriver,
    viewport: { width: 1280, height: 800 },
    ...(states !== undefined ? { states } : {}),
    ...(provider !== undefined
      ? { createHealer: (driver: Driver) => new ModelHealer({ driver, provider }) }
      : {}),
    ...(values.workers !== undefined ? { workers: Number(values.workers) } : {}),
  });

  process.stdout.write(
    values.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${formatSuite(report)}\n`,
  );

  for (const entry of report.entries) {
    const heals = entry.report?.heals ?? [];
    if (heals.length === 0) continue;
    const item = items.find((candidate) => candidate.scenario.id === entry.scenarioId);
    if (item === undefined) continue;
    // Écrire la résolution réparée est ce qui transforme la réparation en diff
    // relu en revue plutôt qu'en ajustement invisible.
    await saveResolution(entry.resolutionPath, applyHeals(item.resolution, heals));
  }

  if (report.status === 'failed') return 1;
  if (report.status === 'healed' && values.strict === true) return 1;
  return 0;
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
