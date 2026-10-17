import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Step {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  run?: string;
}

async function yamlOf<T>(path: string): Promise<T> {
  return parse(await readFile(join(ROOT, path), 'utf8')) as T;
}

/**
 * L'action GitHub n'est exercée en vrai que par son auto-test, sur un seul
 * jeu d'entrées : une entrée ajoutée ici mais jamais transmise au CLI
 * passerait inaperçue. On rejoue donc le script de l'étape tel qu'il est
 * écrit, avec un `npx` factice qui consigne ses arguments.
 */
describe('GitHub Action', () => {
  let dir: string;
  let replay: Step;
  let inputs: Record<string, { default?: string }>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qai-action-'));
    const action = await yamlOf<{ inputs: typeof inputs; runs: { steps: Step[] } }>('action.yml');
    inputs = action.inputs;
    const step = action.runs.steps.find((candidate) => candidate.id === 'qai');
    assert.ok(step?.run !== undefined, 'the replay step (id: qai) must exist');
    replay = step;
    await writeFile(join(dir, 'npx'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$ARGS_FILE"\n');
    await chmod(join(dir, 'npx'), 0o755);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Les arguments que le script passe à `qai`, un par élément. */
  async function argsFor(values: Record<string, string>): Promise<string[]> {
    const env: Record<string, string> = {
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      ARGS_FILE: join(dir, 'args'),
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: join(dir, 'output'),
      RUN_URL: 'https://example.test/run/1',
      SCENARIOS: '',
      BASE_URL: 'http://127.0.0.1:8899/',
      CONFIG: '',
      STATES: '',
      PROVIDER: '',
      HEAL: 'false',
      STRICT: 'false',
      ...values,
    };
    await run('bash', ['-e', '-c', replay.run ?? ''], { env });
    return (await readFile(join(dir, 'args'), 'utf8')).split('\n').slice(0, -1);
  }

  it('declares a provider input and maps it through the environment, never inline', () => {
    assert.equal(inputs['provider']?.default, '');
    assert.equal(replay.env?.['PROVIDER'], '${{ inputs.provider }}');
    assert.doesNotMatch(replay.run ?? '', /\$\{\{/, 'no input is interpolated into the script');
  });

  it('passes --provider to qai, so heal works without a provider in qai.config.json', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const args = await argsFor({ PROVIDER: './qa/provider.mjs', HEAL: 'true' });
    const at = args.indexOf('--provider');
    assert.notEqual(at, -1, `--provider missing from ${JSON.stringify(args)}`);
    assert.equal(args[at + 1], './qa/provider.mjs');
    assert.ok(args.includes('--heal'));
  });

  it('keeps a hostile provider value a single word', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const hostile = './p.mjs $(touch pwned) ; echo x';
    const args = await argsFor({ PROVIDER: hostile });
    assert.equal(args[args.indexOf('--provider') + 1], hostile);
  });

  it('passes no --provider when the input is empty', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    assert.equal((await argsFor({})).includes('--provider'), false);
  });

  /**
   * En CI, npx installe sans demander ce qui manque : un `qai` absent serait
   * le paquet publié sous ce nom par n'importe qui, lancé avec les secrets
   * du job. `--no` l'interdit ; `--` empêche npx de garder pour lui un
   * `--help` ou un `--version` placé après.
   */
  it('runs only the installed qai, never one npx would fetch', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    assert.deepEqual((await argsFor({})).slice(0, 4), ['--no', '--', 'qai', 'run']);
  });
});

/**
 * L'installation et le navigateur, rejoués avec un `npm` factice : ce sont
 * les deux étapes qui décident QUEL QAI tourne — celui de la branche dans
 * l'auto-test, celui du registre pour un utilisateur — et avec quel Chromium.
 */
describe('GitHub Action install', () => {
  let bin: string;
  let workspace: string;
  const workspaces: string[] = [];
  let steps: Step[];
  let inputs: Record<string, { default?: string }>;

  before(async () => {
    bin = await mkdtemp(join(tmpdir(), 'qai-action-bin-'));
    const action = await yamlOf<{ inputs: typeof inputs; runs: { steps: Step[] } }>('action.yml');
    inputs = action.inputs;
    steps = action.runs.steps;
    // Le faux npm consigne ses arguments et pose le paquet là où un vrai
    // `npm i` le mettrait : rien avec INSTALLS=no, le paquet sans son binaire
    // construit avec INSTALLS=unbuilt — ce que donne une URL git.
    await writeFile(
      join(bin, 'npm'),
      [
        '#!/bin/bash',
        'printf "%s\\n" "$@" > "$NPM_ARGS"',
        '[ "$INSTALLS" = no ] && exit 0',
        'mkdir -p node_modules/tilmiqai/dist node_modules/.bin',
        `echo '{"name":"tilmiqai","version":"9.9.9"}' > node_modules/tilmiqai/package.json`,
        '[ "$INSTALLS" = unbuilt ] || echo > node_modules/tilmiqai/dist/cli.js',
        'ln -s ../tilmiqai/dist/cli.js node_modules/.bin/qai',
        '',
      ].join('\n'),
    );
    await chmod(join(bin, 'npm'), 0o755);
  });

  after(async () => {
    for (const path of [bin, ...workspaces]) await rm(path, { recursive: true, force: true });
  });

  async function fresh(): Promise<void> {
    workspace = await mkdtemp(join(tmpdir(), 'qai-action-ws-'));
    workspaces.push(workspace);
  }

  function step(name: string): Step {
    const found = steps.find((candidate) => candidate.name === name);
    assert.ok(found?.run !== undefined, `the ${name} step must exist`);
    return found;
  }

  /** Le shell exact des étapes composites : un échec n'est pas masqué. */
  async function replay(name: string, env: Record<string, string>): Promise<{ stdout: string; npm: string[] }> {
    const { stdout } = await run('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step(name).run ?? ''], {
      cwd: workspace,
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, NPM_ARGS: join(workspace, 'npm-args'), ...env },
    });
    const npm = await readFile(join(workspace, 'npm-args'), 'utf8').then(
      (text) => text.split('\n').slice(0, -1),
      () => [],
    );
    return { stdout, npm };
  }

  async function install(values: Record<string, string>): Promise<{ stdout: string; npm: string[] }> {
    await fresh();
    return replay('Install', { VERSION: 'latest', PACKAGE: '', ...values });
  }

  it('declares a package input and maps it through the environment, never inline', () => {
    assert.equal(inputs['package']?.default, '', 'users keep the registry install by default');
    assert.equal(inputs['version']?.default, 'latest');
    const env = step('Install').env;
    assert.equal(env?.['PACKAGE'], '${{ inputs.package }}');
    assert.equal(env?.['VERSION'], '${{ inputs.version }}');
    for (const candidate of steps) {
      assert.doesNotMatch(candidate.run ?? '', /\$\{\{/, `no input is interpolated into ${candidate.name ?? candidate.id}`);
    }
  });

  it('installs tilmiqai@latest from the registry by default, and the version asked for', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    assert.deepEqual((await install({})).npm.slice(-2), ['--', 'tilmiqai@latest']);
    assert.deepEqual((await install({ VERSION: '0.3.0' })).npm.slice(-2), ['--', 'tilmiqai@0.3.0']);
  });

  it('installs the package spec instead, a local tarball included, and names what ran', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const { npm, stdout } = await install({ PACKAGE: '/tmp/build/tilmiqai-0.4.1.tgz' });
    assert.deepEqual(npm.slice(-2), ['--', '/tmp/build/tilmiqai-0.4.1.tgz']);
    assert.ok(npm.includes('--no-save') && npm.includes('--ignore-scripts'));
    assert.match(stdout, /QAI 9\.9\.9 from \/tmp\/build\/tilmiqai-0\.4\.1\.tgz/);
    assert.doesNotMatch(stdout, /::warning::/);
  });

  it('warns that an explicit version loses to package', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const { npm, stdout } = await install({ PACKAGE: './qai.tgz', VERSION: '0.3.0' });
    assert.deepEqual(npm.slice(-2), ['--', './qai.tgz']);
    assert.match(stdout, /::warning::version \(0\.3\.0\) is ignored: package is set/);
  });

  it('keeps a hostile package value a single spec, never a flag or code', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const hostile = '--registry=http://evil.test/ $(touch pwned) ; touch pwned2';
    const { npm } = await install({ PACKAGE: hostile });
    assert.deepEqual(npm.slice(-2), ['--', hostile]);
    await assert.rejects(access(join(workspace, 'pwned')));
    await assert.rejects(access(join(workspace, 'pwned2')));
  });

  it('fails at install when the spec did not bring a runnable tilmiqai', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const refused = (spec: string) => (error: { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      const stdout = error.stdout ?? '';
      assert.ok(stdout.includes(`::error::${spec} did not install a runnable tilmiqai`), stdout);
      return true;
    };
    await assert.rejects(install({ PACKAGE: 'left-pad', INSTALLS: 'no' }), refused('left-pad'));
    const git = 'git+https://github.com/gseyra1/QAI.git';
    await assert.rejects(install({ PACKAGE: git, INSTALLS: 'unbuilt' }), refused(git));
  });

  /** Un faux Playwright dont le CLI dit qui il est et ce qu'on lui demande. */
  async function playwright(at: string, label: string): Promise<void> {
    await mkdir(at, { recursive: true });
    await writeFile(
      join(at, 'package.json'),
      JSON.stringify({ name: 'playwright', version: label, exports: { '.': './index.js', './package.json': './package.json' } }),
    );
    await writeFile(
      join(at, 'cli.js'),
      `require('fs').writeFileSync(process.env.BROWSER_LOG, ${JSON.stringify(label)} + ' ' + process.argv.slice(2).join(' '));\n`,
    );
  }

  async function browser(): Promise<string> {
    const log = join(workspace, 'browser-log');
    // Un npx qui répondrait trahirait l'ancienne étape : il ne doit pas servir.
    await writeFile(join(bin, 'npx'), '#!/bin/bash\necho "npx $*" > "$BROWSER_LOG"\n');
    await chmod(join(bin, 'npx'), 0o755);
    await replay('Browser', { BROWSER_LOG: log });
    return readFile(log, 'utf8');
  }

  /**
   * Le projet de l'utilisateur épingle son propre Playwright : npm le garde en
   * tête de node_modules et range celui de QAI sous tilmiqai. Le Chromium
   * installé doit être celui du Playwright que QAI importera.
   */
  it("installs the browser of QAI's own Playwright, even when the project pins another", async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    await install({});
    await playwright(join(workspace, 'node_modules', 'playwright'), 'project-1.40.0');
    await playwright(join(workspace, 'node_modules', 'tilmiqai', 'node_modules', 'playwright'), 'qai-1.63.0');
    assert.equal(await browser(), 'qai-1.63.0 install --with-deps chromium');
  });

  it('uses the hoisted Playwright when it is the one QAI resolves', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    await install({});
    await playwright(join(workspace, 'node_modules', 'playwright'), 'hoisted-1.63.0');
    assert.equal(await browser(), 'hoisted-1.63.0 install --with-deps chromium');
  });
});

/**
 * L'auto-test ne vaut que s'il joue le code de la branche : installer
 * « latest » ferait valider une pull request par une autre version — et,
 * tant que la version de la branche n'est pas publiée, par la précédente.
 */
describe('Action self-test', () => {
  interface WorkflowStep extends Step {
    uses?: string;
    with?: Record<string, string>;
  }
  interface Job {
    name?: string;
    steps?: WorkflowStep[];
  }

  async function jobs(): Promise<Record<string, Job>> {
    return (await yamlOf<{ jobs: Record<string, Job> }>('.github/workflows/action-selftest.yml')).jobs;
  }

  it('packs the checked-out repository and feeds that tarball to the action', async () => {
    const steps = (await jobs())['selftest']?.steps ?? [];
    const pack = steps.findIndex((step) => step.id === 'pack');
    const action = steps.findIndex((step) => step.uses === './');
    assert.ok(pack !== -1 && action > pack, 'the tarball is built before the action runs');
    const script = steps[pack]?.run ?? '';
    for (const command of ['npm ci', 'npm run build', 'npm pack']) assert.ok(script.includes(command), command);
    assert.match(script, /tarball=/);
    assert.equal(steps[action]?.with?.['package'], '${{ steps.pack.outputs.tarball }}');
  });

  /**
   * Le garde qui prouve que la branche a tourné est rejoué pour de vrai : un
   * garde qui ne rougit jamais serait un vert de plus qui ne prouve rien.
   */
  it('proves, after the action, that the installed CLI is the packed one', async (t) => {
    if (process.platform === 'win32') return t.skip('the action runs bash on Linux runners');
    const steps = (await jobs())['selftest']?.steps ?? [];
    const action = steps.findIndex((step) => step.uses === './');
    const guard = steps.slice(action + 1).find((step) => step.env?.['TARBALL'] === '${{ steps.pack.outputs.tarball }}');
    assert.ok(guard?.run !== undefined, 'a step after the action checks the installed build');

    const dir = await mkdtemp(join(tmpdir(), 'qai-selftest-'));
    try {
      await mkdir(join(dir, 'package', 'dist'), { recursive: true });
      await writeFile(join(dir, 'package', 'dist', 'cli.js'), 'branch build\n');
      await run('tar', ['-czf', join(dir, 'qai.tgz'), '-C', dir, 'package']);
      const installed = join(dir, 'ws', 'node_modules', 'tilmiqai', 'dist');
      await mkdir(installed, { recursive: true });
      const check = () =>
        run('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard.run ?? ''], {
          cwd: join(dir, 'ws'),
          env: { PATH: process.env['PATH'] ?? '', TARBALL: join(dir, 'qai.tgz') },
        });

      await writeFile(join(installed, 'cli.js'), 'branch build\n');
      await check();
      await writeFile(join(installed, 'cli.js'), 'registry build\n');
      await assert.rejects(check(), 'a CLI that is not the packed one fails the job');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps users\' path covered, the published version, without a second comment', async () => {
    const published = await yamlOf<{ jobs: Record<string, Job> }>('.github/workflows/action-published.yml');
    const steps = published.jobs['published']?.steps ?? [];
    const action = steps.find((step) => step.uses === './');
    assert.ok(action !== undefined);
    assert.equal(action.with?.['package'], undefined, 'installs from the registry, as users do');
    assert.equal(action.with?.['version'], undefined, 'the default, latest');
    assert.equal(action.with?.['comment'], 'false');
  });

  /**
   * L'action publie ses captures sous un nom fixe, et une exécution de
   * workflow refuse deux artefacts du même nom : deux jobs rouges ensemble,
   * et l'un perdait ses captures.
   */
  it('runs the action from one job per workflow, its captures artifact having a fixed name', async () => {
    const action = await readFile(join(ROOT, 'action.yml'), 'utf8');
    assert.match(action, /name: qai-captures\n/, 'the premise: the artifact name is fixed');
    const dir = join(ROOT, '.github', 'workflows');
    for (const file of await readdir(dir)) {
      const workflow = await yamlOf<{ jobs: Record<string, Job & { strategy?: unknown }> }>(`.github/workflows/${file}`);
      const callers = Object.entries(workflow.jobs).filter(([, job]) => job.steps?.some((step) => step.uses === './'));
      assert.ok(callers.length <= 1, `${file}: ${callers.map(([id]) => id).join(', ')} would upload the same artifact`);
      for (const [id, job] of callers) assert.equal(job.strategy, undefined, `${file}: ${id} must not be a matrix`);
    }
  });
});

/**
 * La protection de `main` exige deux contrôles nommés « test » et
 * « selftest ». Une matrice renomme ses jobs (« test (node 22) ») : sans job
 * portant exactement le nom requis, la fusion resterait bloquée — ou, si le
 * job agrégé était sauté, passerait sans que la matrice ait réussi.
 */
describe('CI workflow', () => {
  interface Job {
    name?: string;
    needs?: string | string[];
    if?: string;
    strategy?: { matrix?: { node?: string[] } };
    steps?: (Step & { with?: Record<string, string> })[];
  }

  it('tests the engines floor, Node 22, and the current LTS', async () => {
    const ci = await yamlOf<{ jobs: Record<string, Job> }>('.github/workflows/ci.yml');
    const matrix = Object.values(ci.jobs).find((job) => job.strategy?.matrix?.node !== undefined);
    assert.deepEqual(matrix?.strategy?.matrix?.node, ['22', '24']);
    const setup = matrix?.steps?.find((step) => (step as { uses?: string }).uses?.startsWith('actions/setup-node'));
    assert.equal(setup?.with?.['node-version'], '${{ matrix.node }}');

    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { engines: { node: string } };
    assert.equal(pkg.engines.node, '>=22', 'the matrix floor must follow engines');
  });

  it('keeps a job reporting exactly "test", run even when the matrix fails, and failing with it', async () => {
    const ci = await yamlOf<{ jobs: Record<string, Job> }>('.github/workflows/ci.yml');
    const [id, matrix] = Object.entries(ci.jobs).find(([, job]) => job.strategy?.matrix !== undefined) ?? [];
    assert.ok(id !== undefined && matrix !== undefined);
    assert.notEqual(matrix.name ?? id, 'test', 'a matrix leg must not claim the required name');

    const named = Object.entries(ci.jobs).filter(([key, job]) => (job.name ?? key) === 'test');
    assert.equal(named.length, 1);
    const [, gate] = named[0] ?? [];
    assert.deepEqual([gate?.needs].flat(), [id]);
    assert.equal(gate?.if, 'always()');
    const script = gate?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    assert.match(script, /\[ "\$RESULT" = success \]/);
    assert.equal(gate?.steps?.[0]?.env?.['RESULT'], `\${{ needs.${id}.result }}`);

    const selftest = await yamlOf<{ jobs: Record<string, Job> }>('.github/workflows/action-selftest.yml');
    assert.ok('selftest' in selftest.jobs && selftest.jobs['selftest']?.name === undefined);
  });
});
