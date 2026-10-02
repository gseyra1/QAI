import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 * L'action GitHub n'est exercée que par son auto-test, qui installe la
 * version publiée : une entrée ajoutée ici mais jamais transmise au CLI
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
