import { readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { isAppPath, isBundleId } from './driver/ios/entry.ts';
import { IosDriver } from './driver/ios/IosDriver.ts';
import type { Driver, Platform } from './driver/types.ts';
import { PlaywrightWebDriver } from './driver/web/PlaywrightWebDriver.ts';
import { checkConsistency, formatIssue } from './engine/consistency.ts';
import { generateResolution } from './generate/generate.ts';
import type { SuiteItem } from './engine/suite.ts';
import { runSuite } from './engine/suite.ts';
import { ModelHealer } from './heal/ModelHealer.ts';
import { BudgetedProvider } from './model/budget.ts';
import type { ModelProvider, Pricing } from './model/types.ts';
import { CLI_PLATFORMS, loadConfig } from './config.ts';
import type { CliPlatform } from './config.ts';
import { artifactWriter } from './report/artifacts.ts';
import { formatJUnit } from './report/junit.ts';
import { formatMarkdown } from './report/markdown.ts';
import { formatSuite } from './report/text.ts';
import { applyHeals } from './resolution/apply.ts';
import { loadResolution } from './resolution/load.ts';
import { RESOLUTION_VERSION } from './resolution/types.ts';
import { saveResolution } from './resolution/save.ts';
import { loadScenario } from './scenario/load.ts';
import type { Scenario } from './scenario/types.ts';
import { matchesTags, parseTags } from './scenario/types.ts';
import type { StateProvider } from './state/types.ts';

const USAGE = `qai — QA agent

  qai run     <scenarios…> --base-url <url> [--heal --provider <module>]
  qai check   <scenarios…>
  qai resolve <scenarios…> --base-url <url> --provider <module>

  iOS (experimental): --platform ios --app <bundle-id|path.app> instead of --base-url

<scenarios…> accepts files, directories, or a shell pattern.

Options
  --base-url <url>      root of the application under test
  --platform <p>        web (default) or ios (experimental, needs Appium)
  --app <id|path>       iOS app under test: bundle id, or a .app/.ipa path
  --device <udid|name>  iOS device or simulator (default: Appium's choice)
  --appium-url <url>    Appium server (default http://127.0.0.1:4723)
  --states <module>     module default-exporting a StateProvider, used to
                        install the state declared by "given"
  --provider <module>   module default-exporting a ModelProvider, and
                        optionally a "pricing" constant
  --tags <a,b>          run only the journeys carrying one of these tags
  --workers <n>         journeys in parallel (default: 4)
  --heal                repair stale targets and rewrite the resolutions
  --max-cost <n>        model spend cap
  --attempts <n>        attempts per step during generation (default 5)
  --assert-timeout <ms> re-evaluation window for an assertion still false,
                        for rendering that finishes after network idle
                        (default 5000)
  --resolution <path>   force the resolution path (single scenario only)
  --config <path>       default: qai.config.json, searched upward
  --artifacts <dir>     where to store failure captures (default .qai/artifacts)
  --format <f>          text (default), json, markdown or junit
  --out <path>          write the report to a file
  --run-url <url>       link to the CI run, inserted into the markdown
  --json                alias for --format json
  --strict              a repair fails the command
  --headed              show the browser

Exit codes: 0 passed or healed, 1 failed or inconsistent.
`;

/** Une résolution par plateforme : `<id>.web.json`, `<id>.ios.json`. */
function resolutionPathFor(scenarioPath: string, scenario: Scenario, platform: Platform): string {
  return join(dirname(scenarioPath), '.qai', 'resolutions', `${scenario.id}.${platform}.json`);
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
    throw new Error(`${path} must default-export a ${kind}`);
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
      platform: { type: 'string' },
      app: { type: 'string' },
      device: { type: 'string' },
      'appium-url': { type: 'string' },
      resolution: { type: 'string' },
      states: { type: 'string' },
      provider: { type: 'string' },
      tags: { type: 'string' },
      workers: { type: 'string' },
      'max-cost': { type: 'string' },
      attempts: { type: 'string' },
      'assert-timeout': { type: 'string' },
      heal: { type: 'boolean', default: false },
      config: { type: 'string' },
      artifacts: { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      'run-url': { type: 'string' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [command, ...scenarioArgs] = positionals;
  const { config } = await loadConfig(values.config);

  // Les options de la ligne de commande priment toujours sur le fichier.
  const settings = {
    baseUrl: values['base-url'] ?? config.baseUrl,
    states: values.states ?? config.states,
    provider: values.provider ?? config.provider,
    workers: values.workers !== undefined ? Number(values.workers) : config.workers,
    maxCost: values['max-cost'] !== undefined ? Number(values['max-cost']) : config.maxCost,
    attempts: values.attempts !== undefined ? Number(values.attempts) : config.attempts,
    assertTimeout:
      values['assert-timeout'] !== undefined
        ? Number(values['assert-timeout'])
        : config.assertTimeout,
    tags: parseTags(values.tags ?? config.tags),
    artifacts: values.artifacts ?? config.artifacts ?? '.qai/artifacts',
    strict: values.strict === true || config.strict === true,
    platform: values.platform ?? config.platform ?? 'web',
    app: values.app ?? config.app,
    device: values.device ?? config.device,
    appiumUrl: values['appium-url'] ?? config.appiumUrl,
  };

  const requested = scenarioArgs.length > 0 ? scenarioArgs : (config.scenarios ?? []);

  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Un réglage numérique illisible doit arrêter la commande, pas se dissoudre :
  // « --workers abc » produisait une suite verte à zéro parcours, et
  // « --max-cost abc » désactivait le plafond que l'utilisateur croyait poser.
  const invalide = (flag: string, exige: string): number => {
    process.stderr.write(`${flag} requires ${exige}\n`);
    return 1;
  };
  // Number('') vaut 0 : une variable de CI non définie (« --assert-timeout
  // $QAI_TIMEOUT ») passerait la conversion et désactiverait la fenêtre en
  // silence. Le vide se refuse avant de convertir.
  const bruts: [string, string | undefined][] = [
    ['--workers', values.workers],
    ['--max-cost', values['max-cost']],
    ['--attempts', values.attempts],
    ['--assert-timeout', values['assert-timeout']],
    ['--app', values.app],
    ['--device', values.device],
    ['--appium-url', values['appium-url']],
  ];
  for (const [flag, raw] of bruts) {
    if (raw !== undefined && raw.trim() === '') return invalide(flag, 'a non-empty value');
  }
  const { workers, maxCost: plafond, attempts, assertTimeout } = settings;
  if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) {
    return invalide('--workers', 'an integer ≥ 1');
  }
  if (plafond !== undefined && (!Number.isFinite(plafond) || plafond <= 0)) {
    return invalide('--max-cost', 'a number > 0');
  }
  if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1)) {
    return invalide('--attempts', 'an integer ≥ 1');
  }
  if (assertTimeout !== undefined && (!Number.isFinite(assertTimeout) || assertTimeout < 0)) {
    return invalide('--assert-timeout', 'a number of milliseconds ≥ 0');
  }

  /**
   * La plateforme se valide avant tout chargement, comme les réglages
   * numériques : une valeur inconnue retombant sur le web jouerait la suite
   * web en croyant tester l'application mobile.
   */
  if (!CLI_PLATFORMS.has(settings.platform)) return invalide('--platform', '"web" or "ios"');
  const platform = settings.platform as CliPlatform;
  if (platform === 'web') {
    // Un réglage iOS passé à une exécution web serait ignoré en silence :
    // l'utilisateur croirait viser son application et testerait le site.
    const iosOnly: [string, string | undefined][] = [
      ['--app', values.app],
      ['--device', values.device],
      ['--appium-url', values['appium-url']],
    ];
    for (const [flag, given] of iosOnly) {
      if (given !== undefined) return invalide(flag, '--platform ios');
    }
  } else {
    if (values['base-url'] !== undefined) return invalide('--base-url', '--platform web (use --app on iOS)');
    if ((command === 'run' || command === 'resolve') && settings.app === undefined) {
      return invalide('--platform ios', '--app (a bundle id or a .app/.ipa path)');
    }
    const app = settings.app;
    if (app !== undefined && !isAppPath(app) && !isBundleId(app)) {
      return invalide('--app', 'a bundle id (com.example.app) or a .app/.ipa path');
    }
    const server = settings.appiumUrl;
    if (server !== undefined && !/^https?:\/\/[^/]/i.test(server)) {
      return invalide('--appium-url', 'an http(s) URL');
    }
    // Montrer le navigateur n'a pas de sens sur un simulateur : l'accepter
    // laisserait croire qu'il change quelque chose.
    if (values.headed === true) return invalide('--headed', '--platform web');
    // Un appareil ne joue qu'un parcours à la fois : quatre sessions sur le
    // même simulateur se voleraient l'écran et produiraient des verdicts faux.
    // Seul le drapeau est refusé : une valeur du fichier sert aussi au web
    // d'un même projet, elle est ramenée à 1 et on le dit.
    if (values.workers !== undefined && workers !== 1) {
      return invalide('--workers', '1 with --platform ios (one device runs one journey at a time)');
    }
    if (workers !== undefined && workers !== 1) {
      process.stderr.write(
        `"workers": ${workers} from qai.config.json is ignored on iOS: one device runs one journey at a time\n`,
      );
    }
    // Le pilote iOS n'observe ni réseau ni console : un garde-fou actif
    // passerait chaque étape faute d'avoir regardé. Refusé avant de lancer.
    const watchdogs = config.watchdogs;
    const watched = [watchdogs?.requestFailures, watchdogs?.consoleErrors].some(
      (level) => level !== undefined && level !== 'off',
    );
    if (watched && command === 'run') {
      process.stderr.write(
        'watchdogs in qai.config.json require --platform web: iOS does not observe network or console activity (set them to "off")\n',
      );
      return 1;
    }
  }
  if (command === undefined || requested.length === 0) {
    // Une invocation incomplète doit échouer : passer en silence ferait
    // qu'un job de CI mal configuré serait vert sans avoir rien testé.
    process.stdout.write(USAGE);
    return 1;
  }

  const paths = await expand(requested);
  if (paths.length === 0) {
    process.stderr.write('no scenarios found\n');
    return 1;
  }

  /**
   * Les scénarios sont chargés une fois, puis filtrés, pour les trois
   * commandes. Filtrer après chargement est ce qui permet de sélectionner par
   * tag : le tag vit dans le fichier, pas dans son nom.
   */
  const loaded: { path: string; scenario: Scenario }[] = [];
  for (const path of paths) loaded.push({ path, scenario: await loadScenario(path) });

  const selected = loaded.filter((item) => matchesTags(item.scenario, settings.tags));
  if (selected.length === 0) {
    // Sortir en 0 ferait qu'un tag mal orthographié rende un job de CI vert
    // sans avoir rien joué — exactement le mode de panne que l'outil existe
    // pour éviter.
    process.stderr.write(`no scenario carries the requested tags (${settings.tags.join(', ')})
`);
    return 1;
  }
  if (values.resolution !== undefined && selected.length > 1) {
    process.stderr.write('--resolution only applies to a single scenario\n');
    return 1;
  }

  const createDriver = (): Driver =>
    platform === 'ios'
      ? new IosDriver({
          ...(settings.appiumUrl !== undefined ? { serverUrl: settings.appiumUrl } : {}),
          ...(settings.device !== undefined ? { device: settings.device } : {}),
        })
      : new PlaywrightWebDriver(() => chromium.launch({ headless: values.headed !== true }));

  /**
   * Ce que le pilote lance : l'URL de base sur le web, l'application sur iOS.
   * Le même champ sert d'entrée à `launch` et de `baseUrl` au fournisseur
   * d'état, qui sait ainsi pour quelle cible préparer la session.
   */
  const entry = platform === 'ios' ? settings.app : settings.baseUrl;
  const entryFlag = platform === 'ios' ? '--app' : '--base-url';
  const viewport = platform === 'ios' ? undefined : { width: 1280, height: 800 };

  const maxCost = settings.maxCost;

  async function modelProvider(path: string): Promise<ModelProvider> {
    const { value, pricing } = await loadModule<ModelProvider>(path, 'ModelProvider');
    if (typeof value.complete !== 'function') {
      throw new Error(`${path} must default-export a ModelProvider`);
    }
    if (maxCost === undefined) return value;
    if (pricing === undefined) {
      throw new Error('--max-cost requires the provider module to export "pricing"');
    }
    return new BudgetedProvider(value, pricing, { maxCost });
  }

  const states =
    settings.states === undefined
      ? undefined
      : (await loadModule<StateProvider>(settings.states, 'StateProvider')).value;

  if (command === 'resolve') {
    const baseUrl = entry;
    if (baseUrl === undefined || settings.provider === undefined) {
      process.stderr.write(`${entryFlag} and --provider are required\n`);
      return 1;
    }
    const provider = await modelProvider(settings.provider);
    let failed = false;

    for (const { path, scenario } of selected) {
      const driver = createDriver();
      try {
        await driver.launch({ entry: baseUrl, ...(viewport !== undefined ? { viewport } : {}) });

        // Générer sans installer l'état déclaré produirait une résolution
        // pour un écran que le scénario ne verra jamais.
        if (scenario.given !== undefined) {
          if (states === undefined) {
            process.stderr.write(
              `${scenario.id}: the scenario declares "given", --states is required\n`,
            );
            failed = true;
            continue;
          }
          await driver.applyState(
            await states.prepare({ scenarioId: scenario.id, baseUrl, given: scenario.given }),
          );
        }

        const result = await generateResolution({
          scenario,
          driver,
          provider,
          // Même base qu'au rejeu, sans quoi un chemin de fixture écrit ici ne
          // désigne pas le même fichier là-bas.
          baseDir: dirname(path),
          // Ramène une navigation absolue à un chemin : sinon la résolution
          // porte le port de développement et ne rejoue que sur cette machine.
          baseUrl,
          ...(settings.attempts !== undefined ? { attemptsPerStep: settings.attempts } : {}),
        });

        process.stdout.write(`${scenario.id}\n`);
        for (const step of result.steps) {
          const mark = step.status === 'resolved' ? '✓' : step.status === 'skipped' ? '⊘' : '✖';
          // Le nombre de tentatives est affiché dès qu'il en a fallu plus
          // d'une : sans lui, une consigne qui se dégrade — donc un besoin
          // croissant de reprises — serait absorbée en silence par le budget.
          const tries = step.attempts > 1 ? `  (${step.attempts} attempts)` : '';
          process.stdout.write(`  ${mark} ${step.stepId.padEnd(4)} ${step.intent}${tries}\n`);
          for (const rejection of step.rejections) {
            process.stdout.write(`        attempt rejected: ${rejection}\n`);
          }
        }

        if (result.status !== 'complete') {
          process.stderr.write(`  incomplete resolution: nothing was written\n`);
          failed = true;
          continue;
        }

        const out = values.resolution ?? resolutionPathFor(path, scenario, platform);
        await saveResolution(out, result.resolution);
        process.stdout.write(`  written to ${out}\n`);
      } finally {
        await driver.dispose();
      }
    }
    if (provider instanceof BudgetedProvider) {
      const spend = provider.spend;
      process.stdout.write(`model spend: ${spend.cost.toFixed(4)} (${spend.calls} calls)\n`);
    }
    return failed ? 1 : 0;
  }

  // `check` et `run` partagent le chargement et le contrôle de cohérence.
  const items: SuiteItem[] = [];
  let inconsistent = false;

  for (const { path, scenario } of selected) {
    const resolutionPath = values.resolution ?? resolutionPathFor(path, scenario, platform);

    /**
     * Un scénario sans résolution est un cas NORMAL d'une suite en cours
     * d'écriture, pas une panne d'outil.
     *
     * Laisser l'erreur de lecture remonter arrêtait la commande entière sur le
     * premier fichier manquant, en affichant un ENOENT brut : une suite où dix
     * parcours sur cinquante restent à résoudre devenait invérifiable dans son
     * ensemble, alors que c'est précisément là qu'on a besoin de savoir où on
     * en est. On le compte comme une incohérence de plus — la commande échoue
     * toujours, mais après avoir tout dit.
     */
    let resolution;
    try {
      resolution = await loadResolution(resolutionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      inconsistent = true;
      process.stderr.write(
        `${scenario.id}: no resolution — run "qai resolve" on this journey (${resolutionPath})\n`,
      );
      continue;
    }

    // Une résolution écrite sous une observation plus ancienne se recharge,
    // mais ses cibles ont pu être calculées sur des noms accessibles que ce
    // moteur ne produit plus à l'identique : le rejeu peut passer au rouge sans
    // qu'aucune régression n'existe. On le dit clairement plutôt que de laisser
    // deviner — régénérer avec « qai resolve » réaligne le cache.
    const version = resolution.version ?? 1;
    if (version < RESOLUTION_VERSION) {
      process.stderr.write(
        `${scenario.id}: resolution is v${version}, this QAI observes v${RESOLUTION_VERSION} — ` +
          `regenerate with "qai resolve" if assertions fail unexpectedly (${resolutionPath})\n`,
      );
    }

    const issues = checkConsistency(scenario, resolution, platform);

    if (issues.length > 0) {
      inconsistent = true;
      process.stderr.write(`${scenario.id}: ${issues.length} inconsistency(ies)\n`);
      for (const issue of issues) process.stderr.write(`  • ${formatIssue(issue)}\n`);
      continue;
    }
    // Les chemins d'un téléversement sont relatifs au fichier scénario, pas au
    // répertoire d'où la commande est lancée.
    items.push({ scenario, resolution, resolutionPath, baseDir: dirname(path) });
  }

  if (command === 'check') {
    if (!inconsistent) process.stdout.write(`${items.length} journey(s) consistent.\n`);
    return inconsistent ? 1 : 0;
  }

  if (command !== 'run') {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  // Rejouer sur une paire incohérente produit des verts qui ne prouvent rien.
  if (inconsistent) return 1;

  const baseUrl = entry;
  if (baseUrl === undefined) {
    process.stderr.write(`${entryFlag} is required\n`);
    return 1;
  }
  if (values.heal === true && settings.provider === undefined) {
    process.stderr.write('--heal requires --provider\n');
    return 1;
  }

  const provider =
    values.heal === true && settings.provider !== undefined
      ? await modelProvider(settings.provider)
      : undefined;

  const report = await runSuite({
    items,
    baseUrl,
    createDriver,
    ...(viewport !== undefined ? { viewport } : {}),
    ...(states !== undefined ? { states } : {}),
    ...(provider !== undefined
      ? { createHealer: (driver: Driver) => new ModelHealer({ driver, provider }) }
      : {}),
    ...(platform === 'ios'
      ? { workers: 1 }
      : settings.workers !== undefined
        ? { workers: settings.workers }
        : {}),
    ...(settings.assertTimeout !== undefined ? { assertTimeoutMs: settings.assertTimeout } : {}),
    ...(config.watchdogs !== undefined ? { watchdogs: config.watchdogs } : {}),
    captureArtifact: artifactWriter(settings.artifacts),
  });

  const format = values.json === true ? 'json' : (values.format ?? 'text');
  const rendered =
    format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : format === 'markdown'
        ? formatMarkdown(report, {
            ...(values['run-url'] !== undefined ? { runUrl: values['run-url'] } : {}),
            artifactName: 'qai-captures',
          })
        : format === 'junit'
          ? formatJUnit(report, { strict: settings.strict })
          : `${formatSuite(report)}\n`;

  if (values.out === undefined) process.stdout.write(rendered);
  else {
    await writeFile(values.out, rendered, 'utf8');
    process.stdout.write(`${formatSuite(report)}\n\n${format} report written to ${values.out}\n`);
  }
  if (provider instanceof BudgetedProvider) {
    const spend = provider.spend;
    process.stdout.write(`model spend: ${spend.cost.toFixed(4)} (${spend.calls} calls)\n`);
  }

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
  if (report.status === 'healed' && settings.strict) return 1;
  return 0;
}

/**
 * Détecte si ce module est le script lancé, et non importé.
 *
 * `realpath` est indispensable : npm installe le binaire en **lien
 * symbolique** vers `dist/cli.js`, donc `argv[1]` est le lien tandis que
 * `import.meta.url` est la cible. Comparer les deux sans résoudre le lien fait
 * que le CLI ne démarre jamais une fois installé — ce qui ne se voit pas depuis
 * le dépôt, seulement depuis une installation propre.
 */
async function isEntryPoint(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(await realpath(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

const invokedDirectly = await isEntryPoint();
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
