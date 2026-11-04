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
    assert.equal(reg.redact(`saw ${SECRET} in the url`), 'saw [secret] in the url');
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
    assert.equal(reg.redact('x abc y'), 'x [secret] y');
  });

  it("masque aussi les formes qu'une adresse donne à la valeur", () => {
    // L'adresse courante et les URL du réseau portent la valeur encodée : la
    // sous-chaîne en clair n'y est jamais, et le secret passait.
    const reg = new SecretRegistry();
    reg.add('p@ss w/rd');
    assert.equal(reg.redact(`/q?a=${encodeURIComponent('p@ss w/rd')}&b=1`), '/q?a=[secret]&b=1');
    assert.equal(reg.redact(`/q?a=${encodeURI('p@ss w/rd')}`), '/q?a=[secret]');
    assert.equal(reg.redact('/q?a=p%40ss+w%2Frd'), '/q?a=[secret]');
  });

  it("ne laisse pas la fin d'un secret qui en contient un autre", () => {
    const reg = new SecretRegistry();
    reg.add('abc');
    reg.add('abcdefgh');
    assert.equal(reg.redact('x abcdefgh y'), 'x [secret] y');
  });

  it('masque une valeur encodée en partie', () => {
    // Une application encode ce qu'elle veut : aucune liste de formes n'y suffit.
    const reg = new SecretRegistry();
    reg.add('a[b@c d');
    assert.equal(reg.redact('?a=a%5Bb@c+d'), '?a=[secret]');
    assert.equal(reg.redact('?a=a%5bb%40c%20d'), '?a=[secret]');
  });

  it("garde la casse d'un secret : seul l'hexadécimal est libre", () => {
    const reg = new SecretRegistry();
    reg.add('TokenABC');
    assert.equal(reg.redact('tokenabc'), 'tokenabc');
  });

  it("ne compte pas les bords d'une valeur dans sa longueur utile", () => {
    const reg = new SecretRegistry();
    assert.equal(reg.add('  a  '), false);
    assert.equal(reg.redact('banane'), 'banane');
  });

  it('reconnaît une valeur à plusieurs lignes dans un formulaire encodé', () => {
    for (const value of ['ligne un\nligne deux', 'a b\tc d', '-----BEGIN KEY-----\nMIIabc\n-----END KEY-----']) {
      const reg = new SecretRegistry();
      reg.add(value);
      const form = new URLSearchParams({ t: value }).toString().slice(2);
      assert.equal(reg.redact(`/compte?t=${form}`), '/compte?t=[secret]', JSON.stringify(value));
    }
  });

  it('tient un secret de plusieurs kilo-octets, sans le recopier dans une erreur', () => {
    const pem = 'abcdefghij'.repeat(2_000);
    const reg = new SecretRegistry();
    assert.equal(reg.add(pem), true);
    assert.equal(reg.redact(`clé ${pem} fin`), 'clé [secret] fin');
  });

  it('reconnaît un double encodage, comme dans une redirection next=', () => {
    const reg = new SecretRegistry();
    reg.add('p@ss w/rd-Tok3n');
    const inner = `/compte?jeton=${encodeURIComponent('p@ss w/rd-Tok3n')}`;
    assert.equal(reg.redact(`/login?next=${encodeURIComponent(inner)}`).includes('Tok3n'), false);
  });

  it('reconnaît un JSON dans une adresse, et un contrôle échappé', () => {
    const reg = new SecretRegistry();
    reg.add('ab"cd\\ef');
    reg.add('gh\u0001ij');
    const state = encodeURIComponent(JSON.stringify({ t: 'ab"cd\\ef' }));
    assert.equal(reg.redact(`/cb?state=${state}`).includes('cd'), false);
    assert.equal(reg.redact(JSON.stringify('gh\u0001ij')), '"[secret]"');
  });

  it("reconnaît tout espace encodé, pas seulement l'espace ordinaire", () => {
    for (const space of [' ', '　', ' ', '\f', '\v', '﻿']) {
      const value = `pass${space}word`;
      const reg = new SecretRegistry();
      reg.add(value);
      assert.equal(reg.redact(`?j=${encodeURIComponent(value)}`), '?j=[secret]', JSON.stringify(space));
    }
  });

  it("reconnaît une adresse encodée hors d'UTF-8", () => {
    const reg = new SecretRegistry();
    reg.add('motdepassé-résumé');
    assert.equal(reg.redact('/f?q=motdepass%E9-r%E9sum%E9'), '/f?q=[secret]');
  });

  it('mesure la longueur sans les espaces : « a b » ne vaut pas mieux que « ab »', () => {
    const reg = new SecretRegistry();
    assert.equal(reg.add('a b'), false);
    assert.equal(reg.redact('Tableau de bord'), 'Tableau de bord');
  });

  it('partage ce que les parcours précédents ont appris', () => {
    const known = new Set<string>();
    new SecretRegistry([], known).add('alice@acme.test');
    assert.equal(new SecretRegistry([], known).redact('Compte alice@acme.test'), 'Compte [secret]');
  });

  it('trouve une valeur en clair juste après un % ou un antislash', () => {
    for (const [value, text, expected] of [
      ['4242 4242', 'Remise 20% 4242 4242', 'Remise 20% [secret]'],
      ['david@example.com', 'Profil 100% david@example.com', 'Profil 100% [secret]'],
      ['738291', 'Taux 5%738291', 'Taux 5%[secret]'],
      ['robert', 'CORP\\robert', 'CORP\\[secret]'],
      ['nadia', 'user=CORP\\nadia', 'user=CORP\\[secret]'],
    ] as const) {
      const reg = new SecretRegistry();
      reg.add(value);
      assert.equal(reg.redact(text), expected);
    }
  });

  it('trouve une valeur qui porte elle-même un % ou un antislash', () => {
    for (const [value, text] of [
      ['Pass\\', JSON.stringify({ p: 'Pass\\' })],
      ['abc%', `${encodeURIComponent('abc%')}12`],
      ['pa\\ntoken', '/pa/ntoken'],
      ['x\\"y', '?a=x\\%22y'],
      ['Pa%cfé1', '?a=Pa%cf%C3%A91'],
    ] as const) {
      const reg = new SecretRegistry();
      reg.add(value);
      assert.notEqual(reg.redact(text), text, `${value} dans ${text}`);
    }
  });

  it('ne colle pas deux mots voisins pour y lire un secret', () => {
    const reg = new SecretRegistry();
    reg.add('test');
    assert.equal(reg.redact('and propagates the exit code'), 'and propagates the exit code');
    assert.equal(reg.redact('un test ici'), 'un [secret] ici');
  });

  it("n'efface pas le mot voisin dans une séquence encodée", () => {
    const reg = new SecretRegistry();
    reg.add('пароль');
    const masked = reg.redact(`?q=${encodeURIComponent('тест пароль')}`);
    assert.ok(masked.startsWith('?q=%D1%82') && masked.endsWith('[secret]'), masked);
  });

  it("reconnaît une séquence valide à côté d'un octet invalide", () => {
    const reg = new SecretRegistry();
    reg.add('€€€');
    assert.equal(reg.redact(`?q=${encodeURIComponent('€€€')}%FF`), '?q=[secret]%FF');
  });

  it('couvre les + aux bords de la valeur', () => {
    const reg = new SecretRegistry();
    reg.add('+abc+');
    assert.equal(reg.redact('x +abc+ y'), 'x [secret] y');
  });

  it('reste linéaire sur une chaîne qui se nourrit elle-même', () => {
    const reg = new SecretRegistry();
    reg.add('valeur');
    const started = performance.now();
    reg.redact(`%25${'25'.repeat(50_000)}`);
    reg.redact(`\\u005C${'u005C'.repeat(20_000)}`);
    assert.ok(performance.now() - started < 3_000);
  });

  it('résiste au brassage : la valeur disparaît, le texte voisin reste', () => {
    const alphabet = 'abcXYZ0129-_.~!*()@/:;=?&+,$ %\\"\'<>|[]{}^`é€😀';
    let seed = 42;
    const next = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let round = 0; round < 3_000; round += 1) {
      const chars = [...alphabet];
      const value = `k${Array.from({ length: 6 + next(14) }, () => chars[next(chars.length)]).join('')}Z`;
      const reg = new SecretRegistry();
      reg.add(value);
      const once = encodeURIComponent(value);
      const forms = [
        value,
        once,
        encodeURIComponent(once),
        encodeURI(value),
        JSON.stringify(value).slice(1, -1),
        new URLSearchParams({ v: value }).toString().slice(2),
      ];
      for (const form of forms) {
        const text = `avant ${form} après`;
        const masked = reg.redact(text);
        assert.ok(masked.includes('[secret]'), `${JSON.stringify(value)} dans ${JSON.stringify(text)}`);
        assert.ok(masked.startsWith('avant') && masked.endsWith('après'), masked);
      }
    }
  });

  it('reste stable quand la valeur fait partie du masque', () => {
    const reg = new SecretRegistry();
    reg.add('secret');
    const once = reg.redact('mot de passe secret');
    assert.equal(once, 'mot de passe [secret]');
    assert.equal(reg.redact(once), once);
  });

  it('masque en entier deux secrets qui se chevauchent', () => {
    const reg = new SecretRegistry();
    reg.add('abcdefgh');
    reg.add('efghijkl');
    assert.equal(reg.redact('x abcdefghijkl y'), 'x [secret] y');
  });

  it("masque une valeur telle que l'observation la réécrit", () => {
    const reg = new SecretRegistry();
    reg.add('  tok   en\n');
    assert.equal(reg.redact('text "tok en"'), 'text "[secret]"');
  });

  it('masque une valeur sérialisée en JSON', () => {
    const reg = new SecretRegistry();
    reg.add('pa"ss-word');
    assert.equal(reg.redact(JSON.stringify({ name: 'pa"ss-word' })), '{"name":"[secret]"}');
  });

  it("rend tel quel ce que l'auteur a écrit, et masque le reste", () => {
    const reg = new SecretRegistry(['the header shows admin@acme.test']);
    reg.add('admin@acme.test');
    assert.equal(
      reg.redact('- the header shows admin@acme.test\ntext "admin@acme.test"'),
      '- the header shows admin@acme.test\ntext "[secret]"',
    );
  });

  it('ne casse pas sur une valeur que les fonctions d\'encodage refusent', () => {
    const reg = new SecretRegistry();
    assert.equal(reg.add('abc\ud800'), true);
    assert.equal(reg.redact('x abc\ud800 y'), 'x [secret] y');
  });

  it('enregistre la variable seule, pas seulement la valeur composée', () => {
    process.env['QAI_TEST_PW'] = SECRET;
    try {
      const reg = new SecretRegistry();
      evaluateCheck(
        { check: 'textEquals', target: { role: 'text' }, value: 'Bearer {{env.QAI_TEST_PW}}' },
        { root: node('group', 'page', [node('text', 'autre')]), location: '/', bag: {}, secrets: reg },
      );
      assert.equal(reg.redact(`jeton ${SECRET}`), 'jeton [secret]');
    } finally {
      delete process.env['QAI_TEST_PW'];
    }
  });

  it('ne recopie pas un nombre lu sur un secret dans le message de numberEquals', () => {
    const reg = new SecretRegistry();
    reg.add('00738291');
    const result = evaluateCheck(
      { check: 'numberEquals', target: { role: 'text' }, value: '1' },
      { root: node('group', 'page', [node('text', '00738291')]), location: '/', bag: {}, secrets: reg },
    );
    assert.ok(!result.ok && result.reason.includes('observed [secret]'), JSON.stringify(result));
  });

  it('ne recopie pas la valeur attendue quand la capture comparée vient du secret', () => {
    const reg = new SecretRegistry();
    reg.add('00738291');
    const result = evaluateCheck(
      { check: 'numberEquals', target: { role: 'text', name: '5' }, value: '{{code}}' },
      { root: node('group', 'page', [node('text', '5')]), location: '/', bag: { code: '00738291' }, secrets: reg },
    );
    assert.ok(!result.ok && result.reason === 'expected [secret], observed 5', JSON.stringify(result));
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
      assert.equal(reg.redact(`captured ${SECRET}`), 'captured [secret]');
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
  const VALUES = [
    'k9<Tz|Qw',
    "it's@ok",
    'p@ss w/rd',
    'a"b>c',
    'é€-tok',
    'x+y=z&k',
    'a`b{c}d',
    'tab\\sl',
    'p|ss@wd',
    'k9<Tz|Qw ',
    'line1\nline2',
    'a[b]c^d',
    '100%sûr',
  ];
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
        assert.match(reg.redact(url), /\[secret\](%20)?$/, url);
      }
      await page.evaluate((typed) => history.pushState({}, '', `/search?q=${encodeURIComponent(typed)}`), value);
      assert.match(reg.redact(page.url()), /\[secret\](%20)?$/, page.url());
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
      assert.match(report.captures['shown'] ?? '', /\[secret\]/);
    } finally {
      delete process.env['QAI_LOGIN_PW'];
    }
  });
});
