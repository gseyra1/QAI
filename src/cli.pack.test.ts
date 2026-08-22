import assert from 'node:assert/strict';
import { exec, execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

const run = promisify(execFile);

/**
 * La construction passe par le shell : sur Windows, npm est un script `.cmd`
 * que Node refuse de lancer directement depuis la 20.12. Sans ça, ce fichier
 * échoue dès son `before` sur toute machine de développement Windows — et le
 * seul test qui a déjà attrapé une version publiée inerte n'y tourne jamais.
 * La commande est une constante, pas une entrée : rien à échapper.
 */
const build = promisify(exec);

/**
 * npm installe le binaire d'un paquet en **lien symbolique** vers son fichier.
 * Un CLI qui compare `argv[1]` à `import.meta.url` sans résoudre le lien ne
 * démarre alors jamais — et le défaut est invisible depuis le dépôt, où le
 * script est lancé par son vrai chemin.
 *
 * Ce test rejoue exactement ce scénario. Il a attrapé une version publiée
 * entièrement inerte.
 */
describe('the packaged binary', () => {
  let dir: string;
  let link: string | null = null;

  before(async () => {
    await build('npm run build', { cwd: resolve('.') });
    dir = await mkdtemp(join(tmpdir(), 'qai-bin-'));
    const candidate = join(dir, 'qai');
    try {
      await symlink(resolve('dist/cli.js'), candidate);
      link = candidate;
    } catch (error) {
      // Windows refuse les liens symboliques hors mode développeur. Sauter les
      // deux tests qui en dépendent vaut mieux que faire échouer tout le
      // fichier : les autres gardent leur valeur, et la CI (Linux) exerce de
      // toute façon le chemin du lien.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts when launched through a symlink', async (t) => {
    const bin = link;
    if (bin === null) return t.skip('symlinks unavailable on this machine');
    const { stdout } = await run('node', [bin, '--help']);
    assert.match(stdout, /qai — QA agent/);
    assert.match(stdout, /qai run/);
  });

  it('also starts through its real path', async () => {
    const { stdout } = await run('node', [resolve('dist/cli.js'), '--help']);
    assert.match(stdout, /qai — QA agent/);
  });

  it('returns code 1 without arguments, so a CI job cannot pass silently', async (t) => {
    const bin = link;
    if (bin === null) return t.skip('symlinks unavailable on this machine');
    await assert.rejects(
      () => run('node', [bin]),
      (error: unknown) => (error as { code?: number }).code === 1,
    );
  });

  /**
   * Le paquet construit doit rendre le moteur importable, pas seulement
   * lançable : une équipe qui a déjà vitest ou jest ne changera pas de lanceur
   * pour ajouter QAI. Le test porte sur `dist/index.js` et non sur les sources
   * parce que c'est le bundle qui peut perdre un export — un `export type`
   * écrit à la place d'un `export` disparaît sans que rien ne le signale.
   */
  it('exposes the engine to an existing test harness', async () => {
    const api: Record<string, unknown> = await import(
      pathToFileURL(resolve('dist/index.js')).href
    );

    const expected = [
      'runScenario', 'runSuite', 'generateResolution', 'checkConsistency', 'formatIssue',
      'ModelHealer', 'PlaywrightWebDriver', 'parseScenario', 'loadScenario', 'loadResolution',
      'saveResolution', 'serializeResolution', 'applyHeals', 'artifactWriter', 'formatSuite',
      'formatReport', 'formatMarkdown', 'formatJUnit', 'loadConfig', 'BudgetedProvider', 'costOf',
    ];

    for (const name of expected) {
      assert.equal(typeof api[name], 'function', `${name} is not exported as a value`);
    }
    assert.equal(api['RESOLUTION_VERSION'], 1);
    assert.equal(typeof api['COMMENT_MARKER'], 'string');
  });
});
