import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * La plateforme se valide avant tout chargement : une valeur inconnue qui
 * retomberait sur le web jouerait la suite web en croyant tester l'application
 * mobile, et un réglage iOS passé au web serait ignoré en silence.
 */
describe('platform flag validation', () => {
  const refuses: [string, string[], RegExp][] = [
    ['an unknown platform', ['run', 'x.qai.yaml', '--platform', 'android'], /--platform requires "web" or "ios"/],
    ['ios run without --app', ['run', 'x.qai.yaml', '--platform', 'ios'], /--platform ios requires --app/],
    ['ios resolve without --app', ['resolve', 'x.qai.yaml', '--platform', 'ios'], /--platform ios requires --app/],
    ['an empty --app', ['run', 'x.qai.yaml', '--platform', 'ios', '--app', ''], /--app requires a non-empty value/],
    ['--app that is a URL', ['run', 'x.qai.yaml', '--platform', 'ios', '--app', 'http://localhost:3000'], /--app requires a bundle id/],
    ['--app on the web', ['run', 'x.qai.yaml', '--app', 'com.example.app'], /--app requires --platform ios/],
    ['--device on the web', ['run', 'x.qai.yaml', '--device', 'iPhone 16'], /--device requires --platform ios/],
    ['--appium-url on the web', ['run', 'x.qai.yaml', '--appium-url', 'http://127.0.0.1:4723'], /--appium-url requires --platform ios/],
    ['--base-url on iOS', ['run', 'x.qai.yaml', '--platform', 'ios', '--app', 'com.example.app', '--base-url', 'http://x'], /--base-url requires --platform web/],
    ['a non-http --appium-url', ['run', 'x.qai.yaml', '--platform', 'ios', '--app', 'com.example.app', '--appium-url', 'localhost:4723'], /--appium-url requires an http\(s\) URL/],
    ['several workers on iOS', ['run', 'x.qai.yaml', '--platform', 'ios', '--app', 'com.example.app', '--workers', '2'], /--workers requires 1 with --platform ios/],
  ];

  for (const [nom, argv, attendu] of refuses) {
    it(`rejects ${nom}`, async () => {
      const { code, err } = await qai(argv);
      assert.equal(code, 1);
      assert.match(err, attendu);
    });
  }

  it('accepts --platform ios with a bundle id or an app path', async () => {
    for (const app of ['com.example.app', 'build/Acme.app', 'Acme.ipa']) {
      // « schema » ne contient aucun scénario : l'échec attendu est « aucun
      // scénario trouvé », pas un refus de validation.
      const { code, err } = await qai(['run', 'schema', '--platform', 'ios', '--app', app]);
      assert.equal(code, 1);
      assert.doesNotMatch(err, /requires/);
      assert.match(err, /no scenarios/);
    }
  });

  it('does not require --app to check consistency', async () => {
    const { err } = await qai(['check', 'schema', '--platform', 'ios']);
    assert.doesNotMatch(err, /requires/);
    assert.match(err, /no scenarios/);
  });

  /** Une résolution par plateforme : la version iOS ne doit jamais écraser la web. */
  it('reads the iOS resolution from <id>.ios.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qai-ios-'));
    try {
      const path = join(dir, 'login.qai.yaml');
      await writeFile(path, 'id: login\ntitle: Sign in\nsteps:\n  - id: s1\n    do: sign in\n');
      const ios = await qai(['check', path, '--platform', 'ios']);
      assert.equal(ios.code, 1);
      assert.match(ios.err, /login: no resolution .*login\.ios\.json/);
      const web = await qai(['check', path]);
      assert.match(web.err, /login\.web\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
