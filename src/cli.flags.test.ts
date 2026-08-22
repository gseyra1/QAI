import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/**
 * Un réglage numérique illisible doit arrêter la commande.
 *
 * « --workers abc » produisait une suite verte à zéro parcours — un typo dans
 * un job de CI rendait le pipeline vert sans exécuter aucun test. Et
 * « --max-cost abc » désactivait silencieusement le plafond de dépense.
 */
async function qai(args: string[]): Promise<{ code: number; err: string }> {
  try {
    await run(process.execPath, [CLI, ...args]);
    return { code: 0, err: '' };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? -1, err: failed.stderr ?? '' };
  }
}

describe('validation des réglages numériques', () => {
  const refuses: [string, string[]][] = [
    ['--workers non numérique', ['run', 'x.qai.yaml', '--workers', 'abc']],
    ['--workers zéro', ['run', 'x.qai.yaml', '--workers', '0']],
    ['--workers fractionnaire', ['run', 'x.qai.yaml', '--workers', '2.5']],
    ['--max-cost non numérique', ['run', 'x.qai.yaml', '--max-cost', 'abc']],
    ['--max-cost zéro', ['run', 'x.qai.yaml', '--max-cost', '0']],
    ['--max-cost négatif', ['run', 'x.qai.yaml', '--max-cost=-1']],
    ['--attempts zéro', ['resolve', 'x.qai.yaml', '--attempts', '0']],
    ['--assert-timeout non numérique', ['run', 'x.qai.yaml', '--assert-timeout', 'abc']],
    ['--assert-timeout négatif', ['run', 'x.qai.yaml', '--assert-timeout=-5']],
    // Number('') vaut 0 : une variable de CI non définie désactiverait la
    // fenêtre en silence.
    ['--assert-timeout vide', ['run', 'x.qai.yaml', '--assert-timeout', '']],
    ['--workers blanc', ['run', 'x.qai.yaml', '--workers', '  ']],
  ];

  for (const [nom, argv] of refuses) {
    it(`refuse ${nom}`, async () => {
      const { code, err } = await qai(argv);
      assert.equal(code, 1);
      assert.match(err, /exige/, 'le message doit nommer l’exigence');
    });
  }

  it('accepte --assert-timeout 0 (fenêtre désactivée)', async () => {
    // « schema » ne contient aucun scénario : l'échec attendu est « aucun
    // scénario trouvé », pas un refus de validation.
    const { code, err } = await qai(['run', 'schema', '--assert-timeout', '0']);
    assert.equal(code, 1);
    assert.doesNotMatch(err, /exige/);
    assert.match(err, /aucun scénario/);
  });
});
