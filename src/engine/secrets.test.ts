import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { Action, Driver, Observations, ResolveOutcome, UINode } from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { evaluateCheck, SecretRegistry } from './assert.ts';
import { node } from './fixtures.ts';
import { runScenario } from './run.ts';

const SECRET = 's3cr3t-TOKEN-abc123';

function scenario(steps: Scenario['steps']): Scenario {
  return { id: 'test', title: 'Secret test', steps };
}
function resolution(steps: Resolution['steps']): Resolution {
  return { scenario: 'test', platform: 'web', recordedAt: '2026-07-28T00:00:00Z', steps };
}

describe('SecretRegistry', () => {
  it('masque une valeur enregistrée, où qu\'elle apparaisse', () => {
    const reg = new SecretRegistry();
    reg.add(SECRET);
    assert.equal(reg.redact(`saw ${SECRET} in the url`), 'saw *** in the url');
  });

  it('refuse une valeur trop courte, et le DIT au lieu de le taire', () => {
    // Deux angles morts symétriques : trop transformée pour être reconnue,
    // trop courte pour être distinguée du texte ordinaire. Le second est
    // refusé, et le refus remonte — un silence laisserait croire à une
    // protection inexistante.
    const reg = new SecretRegistry();
    assert.equal(reg.add('ab'), false);
    assert.equal(reg.redact('label ab here'), 'label ab here');
    assert.equal(reg.add('abc'), true);
    assert.equal(reg.redact('x abc y'), 'x *** y');
  });

  it("masque aussi les formes qu'une adresse donne à la valeur", () => {
    // L'adresse courante et les URL du réseau portent la valeur encodée : la
    // sous-chaîne en clair n'y est jamais, et le secret passait.
    const reg = new SecretRegistry();
    reg.add('p@ss w/rd');
    assert.equal(reg.redact(`/q?a=${encodeURIComponent('p@ss w/rd')}&b=1`), '/q?a=***&b=1');
    assert.equal(reg.redact(`/q?a=${encodeURI('p@ss w/rd')}`), '/q?a=***');
    assert.equal(reg.redact('/q?a=p%40ss+w%2Frd'), '/q?a=***');
  });

  it("ne laisse pas la fin d'un secret qui en contient un autre", () => {
    const reg = new SecretRegistry();
    reg.add('abc');
    reg.add('abcdefgh');
    assert.equal(reg.redact('x abcdefgh y'), 'x *** y');
  });

  it('masque en entier deux secrets qui se chevauchent', () => {
    const reg = new SecretRegistry();
    reg.add('abcdefgh');
    reg.add('efghijkl');
    assert.equal(reg.redact('x abcdefghijkl y'), 'x *** y');
  });

  it("masque une valeur telle que l'observation la réécrit", () => {
    const reg = new SecretRegistry();
    reg.add('  tok   en\n');
    assert.equal(reg.redact('text "tok en"'), 'text "***"');
  });

  it('masque une valeur sérialisée en JSON', () => {
    const reg = new SecretRegistry();
    reg.add('pa"ss-word');
    assert.equal(reg.redact(JSON.stringify({ name: 'pa"ss-word' })), '{"name":"***"}');
  });

  it("rend tel quel ce que l'auteur a écrit, et masque le reste", () => {
    const reg = new SecretRegistry(['the header shows admin@acme.test']);
    reg.add('admin@acme.test');
    assert.equal(
      reg.redact('- the header shows admin@acme.test\ntext "admin@acme.test"'),
      '- the header shows admin@acme.test\ntext "***"',
    );
  });

  it('ne casse pas sur une valeur que les fonctions d\'encodage refusent', () => {
    const reg = new SecretRegistry();
    assert.equal(reg.add('abc\ud800'), true);
    assert.equal(reg.redact('x abc\ud800 y'), 'x *** y');
  });

  it('enregistre la variable seule, pas seulement la valeur composée', () => {
    process.env['QAI_TEST_PW'] = SECRET;
    try {
      const reg = new SecretRegistry();
      evaluateCheck(
        { check: 'textEquals', target: { role: 'text' }, value: 'Bearer {{env.QAI_TEST_PW}}' },
        { root: node('group', 'page', [node('text', 'autre')]), location: '/', bag: {}, secrets: reg },
      );
      assert.equal(reg.redact(`jeton ${SECRET}`), 'jeton ***');
    } finally {
      delete process.env['QAI_TEST_PW'];
    }
  });

  it('enregistre le secret qu\'une assertion sur {{env.X}} révèle', () => {
    process.env['QAI_TEST_PW'] = SECRET;
    try {
      const reg = new SecretRegistry();
      const tree = node('group', 'page', [node('text', 'wrong')]);
      // Une assertion sur {{env.X}} enseigne le secret au registre…
      evaluateCheck(
        { check: 'textEquals', target: { role: 'text' }, value: '{{env.QAI_TEST_PW}}' },
        { root: tree, location: '/', bag: {}, secrets: reg },
      );
      // …qui masque désormais ce même secret arrivé autrement (ici une capture).
      assert.equal(reg.redact(`captured ${SECRET}`), 'captured ***');
    } finally {
      delete process.env['QAI_TEST_PW'];
    }
  });
});

/**
 * Le pilote factice qui rejoue le scénario de fuite : un champ rempli, puis
 * l'application le RÉ-AFFICHE (le secret devient du texte à l'écran), qu'une
 * capture lit, qu'une assertion compare — le chemin exact que l'audit a cassé.
 */
class ReflectingDriver implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities = {
    hover: true,
    swipe: false,
    navigateByUrl: true,
    deepLink: false,
  };
  #typed = '';

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async dispose(): Promise<void> {}
  async settle(): Promise<void> {}

  async observe(): Promise<{ platform: 'web'; at: string; location: string; viewport: UINode['rect']; root: UINode }> {
    // L'application affiche ce qui a été saisi — un bandeau « Signed in as … ».
    const root = node('group', 'page', [node('text', `Signed in as ${this.#typed}`)]);
    return { platform: 'web', at: '', location: '/', viewport: { x: 0, y: 0, width: 800, height: 600 }, root };
  }

  async act(action: Action): Promise<void> {
    if (action.kind === 'fill') this.#typed = action.value;
  }

  async resolve(): Promise<ResolveOutcome> {
    return { found: true, node: node('textbox', 'field'), usedFallback: false };
  }

  drainObservations(): Observations {
    return { network: [], console: [] };
  }
}

/**
 * Contre Chromium, pas contre une table : c'est lui qui décide de l'encodage,
 * et `encodeURI` n'encode ni `'` ni `<`... de la même façon.
 */
describe("les formes d'une valeur dans une adresse réelle", () => {
  const VALUES = ['k9<Tz|Qw', "it's@ok", 'p@ss w/rd', 'a"b>c', 'é€-tok', 'x+y=z&k', 'a`b{c}d', 'tab\\sl'];
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.route('http://app.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>t</title>' }));
    await page.goto('http://app.test/');
  });
  after(async () => {
    await browser.close();
  });

  for (const value of VALUES) {
    it(`masque ${JSON.stringify(value)} dans le chemin, la requête et le fragment`, async () => {
      const reg = new SecretRegistry();
      reg.add(value);
      for (const write of ['/p/', '/search?q=', '/page#']) {
        await page.evaluate(([prefix, typed]) => history.pushState({}, '', `${prefix}${typed}`), [write, value]);
        const url = page.url();
        assert.ok(reg.redact(url).endsWith('***'), `${url} -> ${reg.redact(url)}`);
      }
      await page.evaluate((typed) => history.pushState({}, '', `/search?q=${encodeURIComponent(typed)}`), value);
      assert.ok(reg.redact(page.url()).endsWith('***'), page.url());
    });
  }
});

describe('fuite de secret de bout en bout', () => {
  it('ne publie jamais un secret capturé, ni en raison ni en capture', async () => {
    process.env['QAI_LOGIN_PW'] = SECRET;
    try {
      const report = await runScenario({
        driver: new ReflectingDriver(),
        scenario: scenario([
          { id: 's1', do: 'sign in', expect: 'the banner shows the wrong name' },
        ]),
        resolution: resolution({
          s1: {
            actions: [{ kind: 'fill', target: { primary: { role: 'textbox' } }, value: '{{env.QAI_LOGIN_PW}}' }],
            captures: { shown: { from: { role: 'text' }, extract: 'text' } },
            assertions: {
              'the banner shows the wrong name': {
                check: 'textEquals',
                target: { role: 'text' },
                value: 'Signed in as nobody',
              },
            },
          },
        }),
        assertTimeoutMs: 0,
      });

      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes(SECRET), 'the secret must not appear anywhere in the report');
      // La capture a bien eu lieu (elle contient le secret) mais est masquée.
      assert.match(report.captures['shown'] ?? '', /\*\*\*/);
    } finally {
      delete process.env['QAI_LOGIN_PW'];
    }
  });
});
