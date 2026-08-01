import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

const run = promisify(execFile);

/**
 * npm installe le binaire d'un paquet en **lien symbolique** vers son fichier.
 * Un CLI qui compare `argv[1]` à `import.meta.url` sans résoudre le lien ne
 * démarre alors jamais — et le défaut est invisible depuis le dépôt, où le
 * script est lancé par son vrai chemin.
 *
 * Ce test rejoue exactement ce scénario. Il a attrapé une version publiée
 * entièrement inerte.
 */
describe('le binaire empaqueté', () => {
  let dir: string;
  let link: string;

  before(async () => {
    await run('npm', ['run', 'build'], { cwd: resolve('.') });
    dir = await mkdtemp(join(tmpdir(), 'qai-bin-'));
    link = join(dir, 'qai');
    await symlink(resolve('dist/cli.js'), link);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('démarre lorsqu\'il est lancé par un lien symbolique', async () => {
    const { stdout } = await run('node', [link, '--help']);
    assert.match(stdout, /qai — agent QA/);
    assert.match(stdout, /qai run/);
  });

  it('démarre aussi par son vrai chemin', async () => {
    const { stdout } = await run('node', [resolve('dist/cli.js'), '--help']);
    assert.match(stdout, /qai — agent QA/);
  });

  it('rend le code 1 sans argument, pour ne pas passer un job de CI en silence', async () => {
    await assert.rejects(
      () => run('node', [link]),
      (error: unknown) => (error as { code?: number }).code === 1,
    );
  });
});
