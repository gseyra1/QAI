import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeAppium, fixture } from './driver/ios/fake-appium.ts';

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

async function cli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], cwd !== undefined ? { cwd } : {});
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, out: failed.stdout ?? '', err: failed.stderr ?? '' };
  }
}

const LOGIN_SCENARIO = 'id: login\ntitle: Sign in\nsteps:\n  - id: s1\n    do: sign in\n    expect: the form is shown\n';

const SIGN_IN = { primary: { role: 'button', name: 'Sign In' } };

function iosResolution(platform: 'ios' | 'web'): string {
  return JSON.stringify({
    scenario: 'login',
    platform,
    recordedAt: '2026-10-02T00:00:00.000Z',
    steps: {
      s1: {
        actions: [{ kind: 'click', target: SIGN_IN }],
        assertions: { 'the form is shown': { check: 'visible', target: SIGN_IN.primary } },
      },
    },
  });
}

/**
 * Les réglages iOS se valident sur leur valeur effective, et le CLI construit
 * réellement le pilote iOS à partir d'eux : le faux Appium tourne dans ce
 * processus, le CLI dans un autre.
 */
describe('iOS command line', () => {
  let dir: string;
  let fake: FakeAppium;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qai-ios-cli-'));
    await writeFile(join(dir, 'login.qai.yaml'), LOGIN_SCENARIO);
    fake = await FakeAppium.start(fixture('login.xml'));
  });

  after(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake.reset();
    fake.source = fixture('login.xml');
    fake.alert = null;
  });

  it('refuses --headed on iOS', async () => {
    const { code, err } = await cli(['run', 'x.qai.yaml', '--platform', 'ios', '--app', 'com.example.app', '--headed']);
    assert.equal(code, 1);
    assert.match(err, /--headed requires --platform web/);
  });

  it('refuses active watchdogs from the config file on an iOS run', async () => {
    const config = join(dir, 'watchdogs.json');
    await writeFile(config, JSON.stringify({ platform: 'ios', app: 'com.example.app', watchdogs: { requestFailures: 'fail' } }));
    const { code, err } = await cli(['run', 'x.qai.yaml', '--config', config]);
    assert.equal(code, 1);
    assert.match(err, /watchdogs in qai\.config\.json require --platform web/);
  });

  it('brings workers from the config file down to 1 on iOS, and says so', async () => {
    const config = join(dir, 'workers.json');
    await writeFile(config, JSON.stringify({ platform: 'ios', app: 'com.example.app', workers: 4 }));
    const { code, err } = await cli(['run', 'schema', '--config', config]);
    assert.equal(code, 1);
    assert.doesNotMatch(err, /--workers requires/);
    assert.match(err, /"workers": 4 from qai\.config\.json is ignored on iOS/);
    assert.match(err, /no scenarios/);
  });

  it('refuses a resolution written for another platform', async () => {
    const forced = join(dir, 'login.web.json');
    await writeFile(forced, iosResolution('web'));
    const { code, err } = await cli(['check', join(dir, 'login.qai.yaml'), '--platform', 'ios', '--resolution', forced]);
    assert.equal(code, 1);
    assert.match(err, /written for another platform \(web ≠ ios\)/);
  });

  /**
   * La cohérence se juge sur la plateforme jouée, pas sur le web : la même
   * étape, sans intention sur iOS, n'y a aucun geste, et en garder un est une
   * incohérence ; une navigation relative n'y désigne rien.
   */
  it('checks consistency against the iOS shape of each step', async () => {
    const scenario = join(dir, 'verify', 'login.qai.yaml');
    await mkdir(dirname(scenario), { recursive: true });
    await writeFile(
      scenario,
      'id: login\ntitle: Sign in\nsteps:\n  - id: s1\n    per_platform:\n      web: open the login page\n    expect: the form is shown\n',
    );
    const shown = { 'the form is shown': { check: 'visible', target: SIGN_IN.primary } };
    const resolution = async (platform: string, actions: unknown[]): Promise<string> => {
      const path = join(dir, 'verify', `${platform}-${actions.length}.json`);
      await writeFile(
        path,
        JSON.stringify({
          version: 3,
          scenario: 'login',
          platform,
          recordedAt: '2026-10-02T00:00:00.000Z',
          steps: { s1: { actions, assertions: shown } },
        }),
      );
      return path;
    };

    const empty = await cli(['check', scenario, '--platform', 'ios', '--resolution', await resolution('ios', [])]);
    assert.equal(empty.code, 0, empty.err);
    assert.match(empty.out, /1 journey\(s\) consistent/);

    const stale = await cli([
      'check', scenario, '--platform', 'ios', '--resolution', await resolution('ios', [{ kind: 'click', target: SIGN_IN }]),
    ]);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /step "s1": verification-only step, but the cached resolution still has 1 action/);

    // Sur le web, la même étape a une intention : zéro geste y est un manque.
    const web = await cli(['check', scenario, '--resolution', await resolution('web', [])]);
    assert.equal(web.code, 1);
    assert.match(web.err, /step "s1": no actions, but the step has an intent/);
  });

  it('refuses a relative navigate in an iOS resolution at check time', async () => {
    const path = join(dir, 'relative.ios.json');
    await writeFile(
      path,
      JSON.stringify({
        scenario: 'login',
        platform: 'ios',
        recordedAt: '2026-10-02T00:00:00.000Z',
        steps: {
          s1: {
            actions: [{ kind: 'navigate', to: 'orders' }],
            assertions: { 'the form is shown': { check: 'visible', target: SIGN_IN.primary } },
          },
        },
      }),
    );
    const { code, err } = await cli(['check', join(dir, 'login.qai.yaml'), '--platform', 'ios', '--resolution', path]);
    assert.equal(code, 1);
    assert.match(err, /navigate "orders" is a relative path/);
  });

  it('replays a verification-only step on iOS without touching the app', async () => {
    const scenario = join(dir, 'replay', 'login.qai.yaml');
    await mkdir(join(dir, 'replay', '.qai', 'resolutions'), { recursive: true });
    await writeFile(
      scenario,
      'id: login\ntitle: Sign in\nsteps:\n  - id: s1\n    per_platform:\n      web: open the login page\n    expect: on the login screen\n',
    );
    await writeFile(
      join(dir, 'replay', '.qai', 'resolutions', 'login.ios.json'),
      JSON.stringify({
        version: 3,
        scenario: 'login',
        platform: 'ios',
        recordedAt: '2026-10-02T00:00:00.000Z',
        // Comparée brute : sur iOS, l'entrée de lancement n'est pas une base.
        steps: { s1: { actions: [], assertions: { 'on the login screen': { check: 'urlEquals', value: 'com.example.acme/Sign In' } } } },
      }),
    );
    const { code, out } = await cli([
      'run', scenario, '--platform', 'ios', '--app', 'com.example.acme', '--appium-url', fake.url,
      '--artifacts', join(dir, 'artifacts'), '--json',
    ]);
    assert.equal(code, 0, out);
    const report = JSON.parse(out) as { entries: { report: { steps: { stepId: string; status: string }[] } }[] };
    assert.deepEqual(
      report.entries[0]?.report.steps.map((step) => [step.stepId, step.status]),
      [['s1', 'passed']],
    );
    assert.equal(fake.commands().some((command) => /\/click$|\/value$|\/actions$/.test(command)), false);
  });

  it('runs a journey through the Appium server, device and app it was given', async () => {
    await mkdir(join(dir, '.qai', 'resolutions'), { recursive: true });
    await writeFile(join(dir, '.qai', 'resolutions', 'login.ios.json'), iosResolution('ios'));
    const { code, out } = await cli([
      'run', join(dir, 'login.qai.yaml'),
      '--platform', 'ios', '--app', 'com.example.acme', '--device', 'iPhone 16',
      '--appium-url', fake.url, '--artifacts', join(dir, 'artifacts'),
    ]);
    assert.equal(code, 0, out);
    assert.deepEqual((fake.calls[0]?.body as { capabilities: { alwaysMatch: unknown } }).capabilities.alwaysMatch, {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': 'com.example.acme',
      'appium:deviceName': 'iPhone 16',
    });
    assert.ok(fake.commands().includes('POST /element/el-1/click'));
    assert.equal(fake.commands().at(-1), 'DELETE ');
  });

  /**
   * Un parcours web d'une suite mixte, lancée sur iOS, sautait toutes ses
   * étapes et sortait vert. Il est écarté en le disant, et ne compte jamais
   * comme réussi ; une sélection qui n'en garde aucun échoue.
   */
  it('skips a journey with no step on iOS, and never reports it as passed', async () => {
    const suite = join(dir, 'mixed');
    await mkdir(join(suite, '.qai', 'resolutions'), { recursive: true });
    await writeFile(join(suite, 'login.qai.yaml'), LOGIN_SCENARIO);
    await writeFile(join(suite, '.qai', 'resolutions', 'login.ios.json'), iosResolution('ios'));
    await writeFile(
      join(suite, 'hover.qai.yaml'),
      'id: hover\ntitle: Quick view\nplatforms: [web]\nsteps:\n  - id: s1\n    do: hover the card\n',
    );
    await writeFile(
      join(suite, 'tooltip.qai.yaml'),
      'id: tooltip\ntitle: Tooltip\nsteps:\n  - id: s1\n    do: hover the help icon\n    only: [web]\n',
    );
    // Des résolutions présentes : sans le refus, elles seraient « cohérentes ».
    for (const id of ['hover', 'tooltip']) {
      await writeFile(
        join(suite, '.qai', 'resolutions', `${id}.ios.json`),
        JSON.stringify({ scenario: id, platform: 'ios', recordedAt: '2026-10-02T00:00:00.000Z', steps: {} }),
      );
    }
    const ios = ['--platform', 'ios', '--app', 'com.example.acme', '--appium-url', fake.url];

    for (const only of ['hover.qai.yaml', 'tooltip.qai.yaml']) {
      for (const command of ['run', 'check', 'resolve']) {
        fake.reset();
        const { code, out, err } = await cli([
          command, join(suite, only), ...ios, '--provider', join(dir, 'never.mjs'),
        ]);
        assert.equal(code, 1, `${command} ${only}: ${out}`);
        assert.doesNotMatch(out, /PASSED|consistent|written to/);
        assert.match(err, /: skipped, no step runs on ios \("platforms" or "only"\)/);
        assert.match(err, /no selected scenario runs on ios/);
        assert.deepEqual(fake.calls, []);
      }
    }

    fake.reset();
    const mixed = await cli(['run', suite, ...ios, '--artifacts', join(dir, 'artifacts'), '--json']);
    assert.equal(mixed.code, 0, mixed.err);
    const report = JSON.parse(mixed.out) as { entries: { scenarioId: string }[] };
    assert.deepEqual(report.entries.map((entry) => entry.scenarioId), ['login']);
    assert.match(mixed.err, /hover: skipped, no step runs on ios/);
    assert.match(mixed.err, /tooltip: skipped, no step runs on ios/);
  });

  it('writes what resolve produces on iOS to <id>.ios.json', async () => {
    const provider = join(dir, 'provider.mjs');
    await writeFile(
      provider,
      `export default {
  name: 'fixed',
  async complete() {
    return {
      output: { actions: [{ kind: 'click', target: ${JSON.stringify(SIGN_IN)} }], captures: {}, assertions: { 'the form is shown': { check: 'visible', target: ${JSON.stringify(SIGN_IN.primary)} } } },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};
`,
    );
    const scenario = join(dir, 'resolve', 'login.qai.yaml');
    await mkdir(dirname(scenario), { recursive: true });
    await writeFile(scenario, LOGIN_SCENARIO);
    const { code, out, err } = await cli([
      'resolve', scenario, '--platform', 'ios', '--app', 'com.example.acme', '--appium-url', fake.url, '--provider', provider,
    ]);
    assert.equal(code, 0, `${out}\n${err}`);
    const written = JSON.parse(await readFile(join(dir, 'resolve', '.qai', 'resolutions', 'login.ios.json'), 'utf8')) as {
      platform: string;
    };
    assert.equal(written.platform, 'ios');
  });
});
