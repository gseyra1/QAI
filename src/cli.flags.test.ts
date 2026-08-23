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

describe('numeric flag validation', () => {
  const refuses: [string, string[]][] = [
    ['--workers non-numeric', ['run', 'x.qai.yaml', '--workers', 'abc']],
    ['--workers zero', ['run', 'x.qai.yaml', '--workers', '0']],
    ['--workers fractional', ['run', 'x.qai.yaml', '--workers', '2.5']],
    ['--max-cost non-numeric', ['run', 'x.qai.yaml', '--max-cost', 'abc']],
    ['--max-cost zero', ['run', 'x.qai.yaml', '--max-cost', '0']],
    ['--max-cost negative', ['run', 'x.qai.yaml', '--max-cost=-1']],
    ['--attempts zero', ['resolve', 'x.qai.yaml', '--attempts', '0']],
    ['--assert-timeout non-numeric', ['run', 'x.qai.yaml', '--assert-timeout', 'abc']],
    ['--assert-timeout negative', ['run', 'x.qai.yaml', '--assert-timeout=-5']],
    // Number('') vaut 0 : une variable de CI non définie désactiverait la
    // fenêtre en silence.
    ['--assert-timeout empty', ['run', 'x.qai.yaml', '--assert-timeout', '']],
    ['--workers blank', ['run', 'x.qai.yaml', '--workers', '  ']],
  ];

  for (const [nom, argv] of refuses) {
    it(`rejects ${nom}`, async () => {
      const { code, err } = await qai(argv);
      assert.equal(code, 1);
      assert.match(err, /requires/, 'the message must name the requirement');
    });
  }

  it('accepts --assert-timeout 0 (window disabled)', async () => {
    // « schema » ne contient aucun scénario : l'échec attendu est « aucun
    // scénario trouvé », pas un refus de validation.
    const { code, err } = await qai(['run', 'schema', '--assert-timeout', '0']);
    assert.equal(code, 1);
    assert.doesNotMatch(err, /requires/);
    assert.match(err, /no scenarios/);
  });
});
