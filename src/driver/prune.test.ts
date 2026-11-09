import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';
import states from '../../examples/states-example.ts';
import { runScenario } from '../engine/run.ts';
import { node } from '../engine/fixtures.ts';
import { renderTree } from '../generate/render.ts';
import { loadResolution } from '../resolution/load.ts';
import { loadScenario } from '../scenario/load.ts';
import { FakeAppium, FIXTURES, fixture } from './ios/fake-appium.ts';
import { IosDriver } from './ios/IosDriver.ts';
import { readScreen } from './ios/source.ts';
import { derivesPruned, pruneInteractive } from './prune.ts';
import type {
  Action,
  Driver,
  LaunchTarget,
  ObserveOptions,
  PreparedState,
  ResolvedTarget,
  UINode,
  UISnapshot,
} from './types.ts';
import { PlaywrightWebDriver } from './web/PlaywrightWebDriver.ts';

function everyNode(root: UINode): UINode[] {
  return [root, ...root.children.flatMap(everyNode)];
}

/** Un écran lu des deux façons : l'arbre tiré du complet, et celui que le pilote élague. */
interface Pair {
  derived: UINode;
  pruned: UINode;
}

function assertSame(pairs: readonly Pair[], where: string): void {
  for (const [index, { derived, pruned }] of pairs.entries()) {
    assert.deepStrictEqual(derived, pruned, `${where}, screen ${index}`);
    // Ce qui part au modèle, à l'octet près.
    assert.equal(renderTree(derived), renderTree(pruned), `${where}, screen ${index}`);
  }
}

/**
 * Trois lectures, complet, élagué, complet : la comparaison ne vaut que si les
 * deux complets sont identiques, c'est-à-dire si rien n'a bougé entre elles.
 */
async function readBoth(driver: Driver): Promise<Pair> {
  for (let tries = 0; tries < 5; tries += 1) {
    const full = (await driver.observe()).root;
    const pruned = (await driver.observe({ interactiveOnly: true })).root;
    const again = (await driver.observe()).root;
    if (isDeepStrictEqual(full, again)) return { derived: pruneInteractive(full), pruned };
  }
  return assert.fail('the screen never held still for three readings');
}

/** Le pilote du rejeu, qui lit aussi chaque écran observé des deux façons. */
class Comparing implements Driver {
  readonly pairs: Pair[] = [];
  readonly #inner: PlaywrightWebDriver;

  constructor(inner: PlaywrightWebDriver) {
    this.#inner = inner;
  }

  get platform() {
    return this.#inner.platform;
  }
  get capabilities() {
    return this.#inner.capabilities;
  }
  launch(target: LaunchTarget): Promise<void> {
    return this.#inner.launch(target);
  }
  applyState(state: PreparedState): Promise<void> {
    return this.#inner.applyState(state);
  }
  async observe(options?: ObserveOptions): Promise<UISnapshot> {
    const snapshot = await this.#inner.observe(options);
    this.pairs.push(await readBoth(this.#inner));
    return snapshot;
  }
  resolve(target: ResolvedTarget) {
    return this.#inner.resolve(target);
  }
  act(action: Action): Promise<void> {
    return this.#inner.act(action);
  }
  settle(timeoutMs?: number): Promise<void> {
    return this.#inner.settle(timeoutMs);
  }
  takePendingDialogs(): number {
    return this.#inner.takePendingDialogs();
  }
  drainObservations() {
    return this.#inner.drainObservations();
  }
  dispose(): Promise<void> {
    return this.#inner.dispose();
  }
}

/** Ce que sert `fixtures/serve.mjs`, endpoint de la boutique compris. */
async function serve(app: string, bug?: string): Promise<{ server: Server; url: string }> {
  const source = await readFile(`fixtures/${app}/index.html`, 'utf8');
  const page =
    bug === undefined ? source : source.replace('<head>', `<head><script>window.__QAI_BUG=${JSON.stringify(bug)}</script>`);
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/recommandations')) {
      const broken = bug === 'reco-500';
      response.writeHead(broken ? 500 : 200, { 'content-type': 'application/json' });
      response.end(broken ? '{"erreur":"service indisponible"}' : '["Tapis de souris","Repose-poignets"]');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

/** Les dossiers d'exemples et leur application, comme dans examples.test.ts. */
const FOLDERS: Record<string, string> = { examples: 'shop', 'examples/library': 'library' };

describe('pruneInteractive', () => {
  it('ne modifie pas l\'arbre reçu, et descend l\'identifiant de test d\'un emballage aplati', () => {
    const leaf = node('button', 'Valider');
    const inner = node('group', '', [leaf], { testId: 'inner' });
    const outer = node('group', '', [inner], { testId: 'outer' });
    const root = node('group', 'page', [outer, node('group', '', [], { state: { visible: false } })]);
    const copy = structuredClone(root);

    const pruned = pruneInteractive(root);

    assert.deepStrictEqual(root, copy);
    assert.deepStrictEqual(pruned.children, [{ ...leaf, testId: 'inner' }]);
  });

  it('ne dérive que pour les `observe` des pilotes intégrés', () => {
    const web = new PlaywrightWebDriver(() => chromium.launch());
    const ios = new IosDriver({ serverUrl: 'http://127.0.0.1:1' });
    class Rewritten extends PlaywrightWebDriver {
      override async observe(options?: ObserveOptions): Promise<UISnapshot> {
        return super.observe(options);
      }
    }
    const wrapped = new Comparing(web);

    assert.equal(derivesPruned(web), true);
    assert.equal(derivesPruned(ios), true);
    assert.equal(derivesPruned(new Rewritten(() => chromium.launch())), false);
    assert.equal(derivesPruned(wrapped), false);
  });
});

describe('l\'arbre élagué tiré du complet, sur un vrai navigateur', () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function launched(url: string): Promise<Comparing> {
    const driver = new Comparing(new PlaywrightWebDriver(() => chromium.launch()));
    await driver.launch({ entry: url, viewport: { width: 1280, height: 800 } });
    return driver;
  }

  for (const [folder, app] of Object.entries(FOLDERS)) {
    it(`rend exactement ce qu'élague le pilote, à chaque écran des parcours de ${folder}/`, { timeout: 120_000 }, async () => {
      const { server, url } = await serve(app);
      servers.push(server);
      const files = (await readdir(folder)).filter((file) => file.endsWith('.qai.yaml')).sort();
      assert.ok(files.length > 0);

      for (const file of files) {
        const scenario = await loadScenario(join(folder, file));
        const resolution = await loadResolution(join(folder, '.qai/resolutions', `${scenario.id}.web.json`));
        const driver = await launched(url);
        try {
          if (scenario.given !== undefined) {
            await driver.applyState(await states.prepare({ scenarioId: scenario.id, baseUrl: url, given: scenario.given }));
          }
          const report = await runScenario({ scenario, resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
          assert.equal(report.status, 'passed', `${file}: ${JSON.stringify(report.steps)}`);
          assert.ok(driver.pairs.length >= scenario.steps.length, file);
          assertSame(driver.pairs, file);
        } finally {
          await driver.dispose();
        }
      }
    });
  }

  // Les variantes de la démo changent des libellés et des listes : d'autres arbres.
  for (const bug of ['rename-add', 'rename-guest', 'guest-confirm', 'reco-500']) {
    it(`et sur la boutique altérée « ${bug} »`, { timeout: 60_000 }, async () => {
      const { server, url } = await serve('shop', bug);
      servers.push(server);
      const scenario = await loadScenario('examples/checkout-guest.qai.yaml');
      const resolution = await loadResolution('examples/.qai/resolutions/checkout-guest.web.json');
      const driver = await launched(url);
      try {
        await runScenario({ scenario, resolution, driver, baseUrl: url, assertTimeoutMs: 0 });
        assert.ok(driver.pairs.length > 0);
        assertSame(driver.pairs, bug);
      } finally {
        await driver.dispose();
      }
    });
  }

  /** Chaque règle de l'élagage, et ce qui la contourne. */
  const EDGES = `<!doctype html><html lang="en"><body>
    <h2>Account</h2>
    <div style="display:contents"><h1>Welcome back</h1><p>Your orders</p></div>
    <div style="display:contents"><p>Alone in a box-less wrapper</p></div>
    <div style="opacity:0"><p>Transparent A</p><p>Transparent B</p></div>
    <div style="height:0;overflow:hidden"><p>Collapsed A</p><p>Collapsed B</p></div>
    <div style="float:none"><div style="float:left">Float A</div><div style="float:left">Float B</div></div>
    <div data-testid="outer"><div data-testid="inner"><div><button>Deep</button></div></div></div>
    <div data-testid="kept"><span data-testid="own">Own id</span></div>
    <div aria-label="Named leaf" style="width:10px;height:10px"></div>
    <div title="Titled leaf"></div>
    <span role="img" aria-label="icon"></span>
    <span style="display:inline-block;width:8px;height:8px;background:red"></span>
    <p aria-hidden="true">Hidden from accessibility</p>
    <p style="visibility:hidden">Invisible text</p>
    <p style="display:none">Not displayed</p>
    <img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="4" height="4">
    <ul><li>Only item</li></ul>
    <ul><li>First</li><li>Second</li></ul>
    <table><tr><td>Cell A</td><td></td></tr></table>
    <label>Email <input value="a@b.c"></label>
    <input type="password" aria-label="Secret" value="hunter2">
    <input type="checkbox" aria-label="Agree" checked>
    <select aria-label="Size"><option>S</option><option selected>M</option></select>
    <textarea aria-label="Notes">Some notes</textarea>
    <div role="progressbar" aria-valuenow="40" aria-label="Upload"></div>
    <button disabled>Disabled</button>
    <a>Anchor without href</a>
    <a href="#x"><span><span>Nested link text</span></span></a>
    <div><div><div></div></div></div>
    <div style="width:0;height:0"><span style="display:block;width:20px;height:20px">Escaping a zero box</span></div>
    <button style="opacity:0"><span style="display:inline-block;width:8px;height:8px"></span></button>
    <h3 aria-label="Ghost heading" style="opacity:0"><span style="display:inline-block;width:8px;height:8px"></span></h3>
    <script>document.querySelector('textarea').focus();</script>
  </body></html>`;

  /**
   * Chaque rôle que le collecteur peut déclarer, en feuille sans nom, en feuille
   * nommée et en emballage à enfant unique : une règle de rôle changée d'un côté
   * seulement (l'ensemble interactif, l'exception du groupe nommé, la condition
   * d'aplatissement) change au moins l'un d'eux.
   */
  const ROLES = [
    'button', 'link', 'text', 'heading', 'image', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'switch', 'slider', 'list', 'listitem', 'table', 'row',
    'cell', 'tab', 'tablist', 'dialog', 'menu', 'menuitem', 'progressbar', 'alert',
    'group',
  ] as const;
  const BOX = 'style="display:inline-block;width:8px;height:8px"';
  const MATRIX = `<!doctype html><html lang="en"><body>${ROLES.map(
    (role) =>
      `<div role="${role}" data-testid="leaf-${role}" ${BOX}></div>` +
      `<div role="${role}" data-testid="named-${role}" aria-label="Named ${role}" ${BOX}></div>` +
      `<div role="${role}" data-testid="wrap-${role}"><span role="img" aria-label="Inside ${role}" ${BOX}></span></div>`,
  ).join('')}</body></html>`;

  it('rend exactement ce qu\'élague le pilote, pour chaque rôle', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(MATRIX);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    try {
      await driver.launch({ entry: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
      const pair = await readBoth(driver);
      const full = (await driver.observe()).root;
      // Chaque cas est bien là, avec son rôle : sinon la comparaison ne prouverait rien.
      const byTestId = new Map(everyNode(full).flatMap((each) => (each.testId === undefined ? [] : [[each.testId, each] as const])));
      for (const role of ROLES) {
        for (const kind of ['leaf', 'named', 'wrap']) {
          const found = byTestId.get(`${kind}-${role}`);
          assert.equal(found?.role, role, `${kind}-${role}`);
          assert.equal(found?.state.visible, true, `${kind}-${role}`);
        }
        assert.equal(byTestId.get(`leaf-${role}`)?.name, '', role);
      }
      assertSame([pair], 'roles');
    } finally {
      await driver.dispose();
    }
  });

  it('rend exactement ce qu\'élague le pilote, sur chaque règle de l\'élagage', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(EDGES);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const driver = new PlaywrightWebDriver(() => chromium.launch());
    try {
      await driver.launch({ entry: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
      const pair = await readBoth(driver);
      // Les cas visés sont bien là : sinon la comparaison ne prouverait rien.
      const shown = renderTree(pair.pruned);
      assert.match(shown, /#inner/);
      assert.match(shown, /text "Alone in a box-less wrapper"/);
      assert.doesNotMatch(shown, /Named leaf/);
      assertSame([pair], 'edge cases');
    } finally {
      await driver.dispose();
    }
  });
});

/**
 * Chaque type que `readScreen` projette, en feuille sans nom, en feuille nommée
 * et en emballage sans nom à enfant unique, plus un emballage qui porte un
 * identifiant de test sans nom affiché : même rôle de garde-fou que la page des
 * rôles sur le web.
 */
const IOS_TYPES = [
  'Button', 'Link', 'StaticText', 'Image', 'Icon', 'TextField', 'SecureTextField', 'TextView',
  'SearchField', 'PickerWheel', 'ComboBox', 'CheckBox', 'RadioButton', 'Switch', 'Toggle', 'Slider',
  'Table', 'CollectionView', 'Cell', 'TabBar', 'Alert', 'Sheet', 'Menu', 'MenuItem',
  'ProgressIndicator', 'ActivityIndicator', 'Other',
];
const IOS_BOX = 'enabled="true" visible="true" x="0" y="0" width="20" height="20"';
const iosElement = (type: string, attributes: string, children = ''): string =>
  `<XCUIElementType${type} type="XCUIElementType${type}" ${attributes} ${IOS_BOX}>${children}</XCUIElementType${type}>`;
const IOS_MATRIX = `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT>${iosElement(
  'Application',
  'name="Matrix" label="Matrix" bundleId="com.example.matrix"',
  iosElement(
    'Window',
    '',
    [
      ...IOS_TYPES.map(
        (type) =>
          iosElement(type, 'label=""') +
          iosElement(type, `label="Named ${type}"`) +
          iosElement(type, 'label=""', iosElement('StaticText', `label="Inside ${type}"`)),
      ),
      // `Button` dans une barre d'onglets, et un texte d'en-tête : deux rôles de plus.
      iosElement('TabBar', 'label="Tabs"', iosElement('Button', 'label=""') + iosElement('Button', 'label="Named tab"')),
      iosElement('StaticText', 'label="" traits="Header"'),
      iosElement('StaticText', 'label="Named header" traits="Header"'),
      // Un identifiant sans nom lisible : l'emballage s'efface et le lègue à son enfant.
      iosElement('Other', 'name=" " label=""', iosElement('StaticText', 'label="Inherits an id"')),
    ].join(''),
  ),
)}</AppiumAUT>`;

describe('l\'arbre élagué tiré du complet, sur les sources iOS', () => {
  it('rend exactement ce qu\'élague readScreen, pour chaque type projeté', () => {
    const full = readScreen(IOS_MATRIX, { mode: 'observe' }).root;
    const pruned = readScreen(IOS_MATRIX, { mode: 'observe', interactiveOnly: true }).root;
    // Chaque rôle a sa feuille sans nom, sa feuille nommée et son emballage.
    const nodes = everyNode(full).slice(1);
    const roles = new Set(nodes.map((each) => each.role));
    for (const role of roles) {
      const own = nodes.filter((each) => each.role === role);
      assert.ok(own.some((each) => each.name === '' && each.children.length === 0), `${role}: unnamed leaf`);
      assert.ok(own.some((each) => each.name !== '' && each.children.length === 0), `${role}: named leaf`);
    }
    assert.ok(['button', 'tab', 'heading', 'textbox', 'switch', 'list', 'listitem', 'group'].every((role) => roles.has(role as UINode['role'])));
    assert.ok(nodes.some((each) => each.testId === ' ' && each.name === '' && each.children.length === 1));
    assert.ok(everyNode(pruned).some((each) => each.name === 'Inherits an id' && each.testId === ' '));
    assertSame([{ derived: pruneInteractive(full), pruned }], 'matrix');
  });

  it('rend exactement ce qu\'élague readScreen, sur chaque source d\'exemple', async () => {
    const files = (await readdir(FIXTURES)).filter((file) => file.endsWith('.xml')).sort();
    assert.ok(files.length > 0);
    for (const file of files) {
      const xml = fixture(file);
      const full = readScreen(xml, { mode: 'observe' }).root;
      const pruned = readScreen(xml, { mode: 'observe', interactiveOnly: true }).root;
      assertSame([{ derived: pruneInteractive(full), pruned }], file);
    }
  });

  describe('par IosDriver.observe', () => {
    let fake: FakeAppium;
    let driver: IosDriver;

    before(async () => {
      fake = await FakeAppium.start();
      driver = new IosDriver({ serverUrl: fake.url });
      await driver.launch({ entry: 'com.example.acme' });
    });

    after(async () => {
      await driver.dispose();
      await fake.close();
    });

    it('rend exactement ce qu\'il élague lui-même, sur chaque source d\'exemple', async () => {
      const sources = (await readdir(FIXTURES)).filter((name) => name.endsWith('.xml')).sort().map((file) => [file, fixture(file)]);
      for (const [file, source] of [...sources, ['matrix', IOS_MATRIX]] as const) {
        fake.source = source;
        const full = (await driver.observe()).root;
        const pruned = (await driver.observe({ interactiveOnly: true })).root;
        assertSame([{ derived: pruneInteractive(full), pruned }], file);
      }
    });
  });
});
