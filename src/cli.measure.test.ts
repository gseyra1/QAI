import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/measure-tree.ts', import.meta.url));

/**
 * `npm run measure` est cité par la documentation comme le moyen de chiffrer
 * son propre arbre : sa sortie est lue par l'utilisateur, donc en anglais,
 * comme tout message d'exécution. Elle était en français.
 */
describe('npm run measure', () => {
  it('prints its usage in English without --url', async () => {
    await assert.rejects(
      () => run(process.execPath, [SCRIPT]),
      (error: unknown) => {
        const failed = error as { code?: number; stderr?: string };
        assert.equal(failed.code, 1);
        assert.match(failed.stderr ?? '', /^usage: npm run measure -- --url <url>/);
        return true;
      },
    );
  });

  it('reports the tree weight in English', async () => {
    const { stdout } = await run(process.execPath, [SCRIPT, '--url', 'data:text/html,<h1>Hi</h1><button>Go</button>'], {
      timeout: 60_000,
    });
    assert.match(stdout, /full tree\s+\d+ nodes\s+\d+ chars/);
    assert.match(stdout, /interactive tree only\s+\d+ nodes/);
    assert.match(stdout, /screenshot\s+\d+ KiB/);
    assert.match(stdout, /Characters are not tokens/);
    assert.doesNotMatch(stdout, /arbre|nœuds|car\.|Kio|capture d'écran|jetons/);
  });
});
