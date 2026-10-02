import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { runScenario } from '../../engine/run.ts';
import { generateResolution } from '../../generate/generate.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../model/types.ts';
import type { Check, Resolution } from '../../resolution/types.ts';
import type { Scenario } from '../../scenario/types.ts';
import type { Action, ResolvedTarget, UINode } from '../types.ts';
import { FakeAppium, fixture } from './fake-appium.ts';
import { IosDriver } from './IosDriver.ts';

const LOGIN = fixture('login.xml');
const ORDERS = fixture('orders.xml');
const SCROLLED = fixture('orders-scrolled.xml');
const PAST = fixture('orders-past.xml');
const ALERT = fixture('alert.xml');
const SHEET = fixture('sheet.xml');

const SIGN_IN: ResolvedTarget = { primary: { role: 'button', name: 'Sign In' } };

const LOGIN_FORM =
  '//XCUIElementTypeApplication[1]/XCUIElementTypeWindow[1]/XCUIElementTypeOther[1]' +
  '/XCUIElementTypeOther[1]/XCUIElementTypeOther[1]';

const NO_ALERT = 'GET /alert/text';

function flatten(node: UINode): UINode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function scriptOf(body: unknown): string | undefined {
  return (body as { script?: string } | undefined)?.script;
}

/**
 * Le pilote iOS contre un faux Appium.
 *
 * Chaque test affirme la séquence EXACTE d'appels HTTP : sans simulateur, la
 * conformité au protocole documenté est la seule chose vérifiable, et un appel
 * en trop ou de travers est précisément ce qu'on veut voir casser.
 */
describe('IosDriver', () => {
  let fake: FakeAppium;
  let driver: IosDriver;

  before(async () => {
    fake = await FakeAppium.start();
  });

  after(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    fake.reset();
    fake.source = LOGIN;
    fake.alert = null;
    fake.activeBundleId = 'com.example.acme';
    driver = new IosDriver({ serverUrl: fake.url });
    await driver.launch({ entry: 'com.example.acme' });
    fake.calls.length = 0;
  });

  afterEach(async () => {
    await driver.dispose();
  });

  describe('session', () => {
    it('creates an XCUITest session for a bundle id', async () => {
      const own = new IosDriver({ serverUrl: `${fake.url}/`, device: 'iPhone 16', platformVersion: '18.2' });
      await own.launch({ entry: 'com.example.acme' });
      await own.dispose();

      assert.deepEqual(fake.calls[0], {
        method: 'POST',
        path: '/session',
        body: {
          capabilities: {
            alwaysMatch: {
              platformName: 'iOS',
              'appium:automationName': 'XCUITest',
              'appium:bundleId': 'com.example.acme',
              'appium:deviceName': 'iPhone 16',
              'appium:platformVersion': '18.2',
            },
            firstMatch: [{}],
          },
        },
      });
      // Le bundle est connu : aucune question à poser au serveur.
      assert.deepEqual(fake.commands(), ['POST /session', 'DELETE ']);
    });

    it('installs a .app by path, targets a UDID, then learns the bundle id', async () => {
      const udid = '6A0E4B1C-2D3F-4A5B-8C7D-9E0F1A2B3C4D';
      const own = new IosDriver({ serverUrl: fake.url, device: udid });
      fake.activeBundleId = 'com.example.built';
      await own.launch({ entry: 'build/Acme.app' });
      await own.act({ kind: 'navigate', to: '.' });
      await own.dispose();

      const created = fake.calls[0]?.body as { capabilities: { alwaysMatch: Record<string, string> } };
      assert.deepEqual(created.capabilities.alwaysMatch, {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:app': resolve('build/Acme.app'),
        'appium:udid': udid,
      });
      assert.deepEqual(fake.commands(), [
        'POST /session',
        'POST /execute/sync mobile: activeAppInfo',
        NO_ALERT,
        'POST /execute/sync mobile: terminateApp',
        'POST /execute/sync mobile: launchApp',
        NO_ALERT,
        'DELETE ',
      ]);
      // La relance vise le bundle appris, pas le chemin.
      assert.deepEqual(fake.calls[3]?.body, { script: 'mobile: terminateApp', args: [{ bundleId: 'com.example.built' }] });
      assert.deepEqual(fake.calls[4]?.body, { script: 'mobile: launchApp', args: [{ bundleId: 'com.example.built' }] });
    });

    it('refuses an installed app that never reached the foreground', async () => {
      const own = new IosDriver({ serverUrl: fake.url });
      fake.activeBundleId = 'com.apple.springboard';
      await assert.rejects(() => own.launch({ entry: '/builds/Acme.app' }), /not in the foreground \(SpringBoard is\)/);
      await own.dispose();
      assert.deepEqual(fake.commands(), ['POST /session', 'POST /execute/sync mobile: activeAppInfo', 'DELETE ']);
    });

    it('refuses a relative app path when the Appium server is on another host', async () => {
      const own = new IosDriver({ serverUrl: 'http://mac-mini.lan:4723' });
      await assert.rejects(
        () => own.launch({ entry: 'build/Acme.app' }),
        /relative path, but the Appium server .* is not on this machine/,
      );
      // Absolu : transmis tel quel, c'est un chemin de l'hôte du serveur.
      const local = new IosDriver({ serverUrl: fake.url.replace('127.0.0.1', 'localhost') });
      await local.launch({ entry: '/Users/ci/Acme.app' });
      await local.dispose();
      const created = fake.calls[0]?.body as { capabilities: { alwaysMatch: Record<string, string> } };
      assert.equal(created.capabilities.alwaysMatch['appium:app'], '/Users/ci/Acme.app');
    });

    it('refuses an entry that is neither a bundle id nor an app path, before any request', async () => {
      const own = new IosDriver({ serverUrl: fake.url });
      for (const entry of ['http://localhost:3000', 'Acme', 'com.example/app']) {
        await assert.rejects(() => own.launch({ entry }), /neither a bundle id/);
      }
      assert.deepEqual(fake.calls, []);
    });

    it('refuses every operation before launch', async () => {
      const own = new IosDriver({ serverUrl: fake.url });
      await assert.rejects(() => own.observe(), /launch\(\) must be called/);
      await assert.rejects(() => own.act({ kind: 'swipe', direction: 'up' }), /launch\(\) must be called/);
    });

    it('disposes idempotently, and never throws on a session already gone', async () => {
      await driver.dispose();
      await driver.dispose();
      assert.deepEqual(fake.commands(), ['DELETE ']);

      const own = new IosDriver({ serverUrl: fake.url });
      await own.launch({ entry: 'com.example.acme' });
      fake.calls.length = 0;
      fake.on('DELETE', /^\/session\//, () => ({
        status: 404,
        value: { error: 'invalid session id', message: 'A session is either terminated or not started' },
      }));
      await own.dispose();
      await own.dispose();
      assert.deepEqual(fake.commands(), ['DELETE '], 'one attempt, the error swallowed, nothing more');
    });

    it('names the unreachable server instead of failing with a bare fetch error', async () => {
      const closed = await FakeAppium.start();
      const url = closed.url;
      await closed.close();
      const own = new IosDriver({ serverUrl: url });
      await assert.rejects(
        () => own.launch({ entry: 'com.example.acme' }),
        new RegExp(`new session failed: cannot reach the Appium server at ${url.replace(/[.]/g, '\\.')}`),
      );
    });
  });

  describe('observe', () => {
    it('returns an ios snapshot located by bundle id and navigation title', async () => {
      const snapshot = await driver.observe();
      assert.equal(snapshot.platform, 'ios');
      assert.equal(snapshot.location, 'com.example.acme/Sign In');
      assert.deepEqual(snapshot.viewport, { x: 0, y: 0, width: 390, height: 844 });
      assert.equal(snapshot.screenshot, undefined);
      assert.deepEqual(fake.commands(), ['GET /source']);
    });

    it('takes a screenshot only on demand', async () => {
      const snapshot = await driver.observe({ screenshot: true });
      assert.deepEqual([...(snapshot.screenshot ?? [])], [0x89, 0x50, 0x4e, 0x47]);
      assert.deepEqual(fake.commands(), ['GET /source', 'GET /screenshot']);
    });

    it('keeps an off-screen row: present below the fold, as on the web', async () => {
      fake.source = ORDERS;
      const rows = flatten((await driver.observe()).root).filter((node) => node.name === 'Order #1042');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.state.visible, true);
    });
  });

  describe('resolve', () => {
    it('finds a unique, visible target', async () => {
      const outcome = await driver.resolve(SIGN_IN);
      assert.equal(outcome.found, true);
      assert.equal(outcome.found && outcome.node.testId, 'login_button');
      assert.equal(outcome.found && outcome.usedFallback, false);
      assert.deepEqual(fake.commands(), ['GET /source']);
    });

    it('refuses to choose between several matches', async () => {
      fake.source = ORDERS;
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Reorder' } });
      assert.deepEqual(outcome, { found: false, reason: 'ambiguous', matches: 2 });
    });

    it('disambiguates with nth and within', async () => {
      fake.source = ORDERS;
      const second = await driver.resolve({ primary: { role: 'button', name: 'Reorder', nth: 1 } });
      assert.equal(second.found && second.node.rect.y, 208);
      const within = await driver.resolve({
        primary: { role: 'button', name: 'Reorder', within: { role: 'listitem', nth: 0 } },
      });
      assert.equal(within.found && within.node.rect.y, 120);
    });

    /**
     * Le modèle écrit `nth` en lisant l'arbre observé : `resolve` doit compter
     * sur la même population, sinon l'index désigne une autre ligne.
     */
    it('counts and indexes the very population the snapshot shows', async () => {
      fake.source = PAST;
      const shown = flatten((await driver.observe({ interactiveOnly: true })).root).filter(
        (node) => node.role === 'button' && node.name === 'Reorder',
      );
      assert.equal(shown.length, 3);
      const unindexed = await driver.resolve({ primary: { role: 'button', name: 'Reorder' } });
      assert.deepEqual(unindexed, { found: false, reason: 'ambiguous', matches: shown.length });
      for (const [nth, node] of shown.entries()) {
        const outcome = await driver.resolve({ primary: { role: 'button', name: 'Reorder', nth } });
        assert.deepEqual(outcome.found && outcome.node.rect, node.rect, `nth ${nth}`);
      }
    });

    it('does not count a node without a box, which the snapshot does not show', async () => {
      fake.source = ORDERS.replace(
        'name="Track parcel" label="Track parcel" enabled="true" visible="false" accessible="true" x="250" y="929" width="124" height="34"',
        'name="Reorder" label="Reorder" enabled="true" visible="false" accessible="true" x="250" y="929" width="0" height="0"',
      );
      const shown = flatten((await driver.observe()).root).filter((node) => node.name === 'Reorder');
      assert.equal(shown.length, 2);
      assert.deepEqual(await driver.resolve({ primary: { role: 'button', name: 'Reorder' } }), {
        found: false,
        reason: 'ambiguous',
        matches: 2,
      });
    });

    it("finds a target below the fold: it is rendered, scrolling is the gesture's business", async () => {
      fake.source = ORDERS;
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Track parcel' } });
      assert.equal(outcome.found, true);
    });

    it('says not-visible for a target present without a box', async () => {
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Collapsed' } });
      assert.deepEqual(outcome, { found: false, reason: 'not-visible', matches: 1 });
    });

    it('says no-match when nothing matches', async () => {
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Pay now' } });
      assert.deepEqual(outcome, { found: false, reason: 'no-match', matches: 0 });
    });

    it('falls back to the accessibility identifier, through accessibilityId or testId, and says so', async () => {
      for (const fallback of [{ accessibilityId: 'login_button' }, { testId: 'login_button' }]) {
        const outcome = await driver.resolve({ primary: { role: 'button', name: 'Log in' }, fallback });
        assert.equal(outcome.found, true, JSON.stringify(fallback));
        assert.equal(outcome.found && outcome.usedFallback, true);
        assert.equal(outcome.found && outcome.node.name, 'Sign In');
      }
    });

    it('never falls back on a label that WebDriverAgent copied into name', async () => {
      fake.source = ORDERS;
      const outcome = await driver.resolve({
        primary: { role: 'button', name: 'Reorder now' },
        fallback: { accessibilityId: 'Order #1040' },
      });
      assert.deepEqual(outcome, { found: false, reason: 'no-match', matches: 0 });
    });

    it('refuses an identifier carried by several elements', async () => {
      fake.source = ORDERS.replaceAll('name="Reorder" label="Reorder"', 'name="reorder_button" label="Reorder"');
      const outcome = await driver.resolve({
        primary: { role: 'button', name: 'Reorder now' },
        fallback: { accessibilityId: 'reorder_button' },
      });
      assert.deepEqual(outcome, { found: false, reason: 'ambiguous', matches: 2 });
    });

    it('ignores the CSS selector fallback', async () => {
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Log in' }, fallback: { selector: '#login' } });
      assert.deepEqual(outcome, { found: false, reason: 'no-match', matches: 0 });
    });
  });

  describe('act', () => {
    it('click finds the exact element by path and identity, then clicks it — no coordinate tap', async () => {
      await driver.act({ kind: 'click', target: SIGN_IN });
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source', 'POST /elements', 'POST /element/el-1/click', NO_ALERT]);
      assert.deepEqual(fake.calls[2]?.body, {
        using: 'xpath',
        value: `${LOGIN_FORM}/XCUIElementTypeButton[1][@name="login_button"]`,
      });
      assert.deepEqual(fake.calls[3]?.body, {});
    });

    /**
     * L'onglet « Settings » est sous le clavier, retiré de l'arbre. Un tap par
     * coordonnées y taperait une touche ; le clic d'élément laisse XCTest
     * calculer un point atteignable, ou échouer.
     */
    it('click on a target under the keyboard goes through the element, never through coordinates', async () => {
      await driver.act({ kind: 'click', target: { primary: { role: 'tab', name: 'Settings' } } });
      assert.equal(fake.commands().some((command) => command.includes('mobile: tap')), false);
      assert.match(
        String((fake.calls[2]?.body as { value: string }).value),
        /XCUIElementTypeTabBar\[1\]\/XCUIElementTypeButton\[2\]\[@name="Settings"\]$/,
      );
      assert.deepEqual(fake.commands().slice(-2), ['POST /element/el-1/click', NO_ALERT]);
    });

    it('click refuses an ambiguous or hidden target without touching the screen', async () => {
      fake.source = ORDERS;
      await assert.rejects(
        () => driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Reorder' } } }),
        /ambiguous target: 2 elements/,
      );
      fake.source = LOGIN;
      await assert.rejects(
        () => driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Collapsed' } } }),
        /not visible/,
      );
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source', NO_ALERT, 'GET /source']);
    });

    it('refuses to act on a row that another row replaced since resolution', async () => {
      fake.source = ORDERS;
      // La liste se recharge entre la lecture et la recherche : même structure,
      // autres lignes. Le rang seul désignerait la nouvelle première ligne.
      fake.on('POST', /\/elements$/, (_call, server) => {
        server.source = ORDERS.replace('name="Order #1040" label="Order #1040"', 'name="Order #2001" label="Order #2001"');
        return undefined;
      });
      await assert.rejects(
        () => driver.act({ kind: 'click', target: { primary: { role: 'text', name: 'Order #1040' } } }),
        /the screen changed between resolution and action/,
      );
      assert.equal(fake.commands().some((command) => command.endsWith('/click')), false);
    });

    it('fill finds the exact element, focuses, clears, then types', async () => {
      await driver.act({ kind: 'fill', target: { primary: { role: 'textbox', name: 'Password' } }, value: 'hunter2-secret' });
      assert.deepEqual(fake.commands(), [
        NO_ALERT,
        'GET /source',
        'POST /elements',
        'POST /element/el-1/click',
        'POST /element/el-1/clear',
        'POST /element/el-1/value',
        NO_ALERT,
      ]);
      assert.deepEqual(fake.calls[2]?.body, {
        using: 'xpath',
        value: `${LOGIN_FORM}/XCUIElementTypeSecureTextField[1][@name="password_field"]`,
      });
      assert.deepEqual(fake.calls[5]?.body, { text: 'hunter2-secret' });
    });

    it('fill never echoes the typed value in an error', async () => {
      fake.on('POST', /\/element\/el-1\/value$/, () => ({
        status: 500,
        value: { error: 'invalid element state', message: 'Cannot type hunter2-secret into the field\n    at stack' },
      }));
      await assert.rejects(
        () => driver.act({ kind: 'fill', target: { primary: { role: 'textbox', name: 'Password' } }, value: 'hunter2-secret' }),
        (error: Error) =>
          error.message === 'element send keys failed: invalid element state — Cannot type *** into the field',
      );
    });

    it('fill refuses when the element is gone between resolution and action', async () => {
      fake.on('POST', /\/elements$/, () => ({ value: [] }));
      await assert.rejects(
        () => driver.act({ kind: 'fill', target: { primary: { role: 'textbox', name: 'Email' } }, value: 'a@b.c' }),
        /the screen changed between resolution and action/,
      );
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source', 'POST /elements']);
    });

    it('select sends the displayed label to the picker wheel', async () => {
      await driver.act({ kind: 'select', target: { primary: { role: 'combobox', name: 'Delivery' } }, option: 'Express delivery' });
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source', 'POST /elements', 'POST /element/el-1/value', NO_ALERT]);
      assert.deepEqual(fake.calls[3]?.body, { text: 'Express delivery' });
      assert.match(
        String((fake.calls[2]?.body as { value: string }).value),
        /XCUIElementTypePickerWheel\[1\]\[@name="delivery_picker"\]$/,
      );
    });

    it('select refuses anything but a picker wheel', async () => {
      await assert.rejects(
        () => driver.act({ kind: 'select', target: SIGN_IN, option: 'x' }),
        /select needs a picker wheel on iOS, the target is a button/,
      );
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source']);
    });

    it('press types the key into the focused element', async () => {
      await driver.act({ kind: 'press', key: 'Enter' });
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /element/active', 'POST /element/el-active/value', NO_ALERT]);
      assert.deepEqual(fake.calls[2]?.body, { text: '\n' });
    });

    it('press refuses a key it cannot produce, before any request', async () => {
      await assert.rejects(() => driver.act({ kind: 'press', key: 'F5' }), /press "F5" is not supported on iOS/);
      assert.deepEqual(fake.calls, []);
    });

    it('swipe goes through mobile: swipe', async () => {
      await driver.act({ kind: 'swipe', direction: 'left' });
      assert.deepEqual(fake.commands(), [NO_ALERT, 'POST /execute/sync mobile: swipe', NO_ALERT]);
      assert.deepEqual(fake.calls[1]?.body, { script: 'mobile: swipe', args: [{ direction: 'left' }] });
    });

    it('navigate opens an absolute URL as a deep link into the app under test', async () => {
      await driver.act({ kind: 'navigate', to: 'acme://orders/1042' });
      assert.deepEqual(fake.commands(), [NO_ALERT, 'POST /execute/sync mobile: deepLink', NO_ALERT]);
      assert.deepEqual(fake.calls[1]?.body, {
        script: 'mobile: deepLink',
        args: [{ url: 'acme://orders/1042', bundleId: 'com.example.acme' }],
      });
    });

    it('navigate "." and "/" relaunch the app with terminateApp then launchApp', async () => {
      for (const to of ['.', '/']) {
        fake.calls.length = 0;
        await driver.act({ kind: 'navigate', to });
        assert.deepEqual(fake.commands(), [
          NO_ALERT,
          'POST /execute/sync mobile: terminateApp',
          'POST /execute/sync mobile: launchApp',
          NO_ALERT,
        ]);
        assert.deepEqual(fake.calls[2]?.body, { script: 'mobile: launchApp', args: [{ bundleId: 'com.example.acme' }] });
      }
    });

    it('navigate refuses a relative path, an empty one, or a host:port copied without scheme', async () => {
      for (const to of ['/cart', '', 'localhost:3000/cart']) {
        await assert.rejects(() => driver.act({ kind: 'navigate', to }), /absolute deep link URL/, to);
      }
      assert.deepEqual(fake.calls, []);
    });

    it('scrollTo brings an off-screen target on screen with mobile: scrollToElement, then checks it', async () => {
      fake.source = ORDERS;
      fake.on('POST', /\/execute\/sync$/, (call, server) => {
        if (scriptOf(call.body) === 'mobile: scrollToElement') server.source = SCROLLED;
        return undefined;
      });
      await driver.act({ kind: 'scrollTo', target: { primary: { role: 'button', name: 'Track parcel' } } });
      assert.deepEqual(fake.commands(), [
        NO_ALERT,
        'GET /source',
        'POST /elements',
        'POST /execute/sync mobile: scrollToElement',
        'GET /source',
        NO_ALERT,
      ]);
      assert.deepEqual(fake.calls[3]?.body, { script: 'mobile: scrollToElement', args: [{ elementId: 'el-1' }] });
    });

    it('scrollTo does nothing for a target already on screen', async () => {
      await driver.act({ kind: 'scrollTo', target: SIGN_IN });
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source', NO_ALERT]);
    });

    it('scrollTo fails explicitly when the target is still off screen afterwards', async () => {
      fake.source = ORDERS;
      await assert.rejects(
        () => driver.act({ kind: 'scrollTo', target: { primary: { role: 'button', name: 'Track parcel' } } }),
        /target still off screen after scrolling to it/,
      );
    });

    it('hover, upload and expectDialog are refused explicitly, before any request', async () => {
      assert.equal(driver.capabilities.hover, false);
      assert.equal(driver.capabilities.dialogs, false);
      await assert.rejects(() => driver.act({ kind: 'hover', target: SIGN_IN }), /hover does not exist on iOS/);
      await assert.rejects(
        () => driver.act({ kind: 'upload', target: SIGN_IN, files: ['a.csv'] }),
        /upload is not supported on iOS/,
      );
      await assert.rejects(
        () => driver.act({ kind: 'expectDialog', response: 'accept' }),
        /expectDialog is not supported on iOS: an app alert is part of the screen/,
      );
      assert.deepEqual(fake.calls, []);
    });
  });

  /**
   * Aucune alerte n'est jamais répondue par `/alert/accept` ou
   * `/alert/dismiss` : WebDriverAgent y choisit un bouton par sa position.
   */
  describe('alerts', () => {
    const answered = (): string[] =>
      fake.commands().filter((command) => /\/alert\/(accept|dismiss)|mobile: alert/.test(command));

    it('leaves an app alert on screen, where it is observed and its button clicked by label', async () => {
      fake.source = ALERT;
      fake.alert = 'Delete account?\nThis cannot be undone.';
      const dialog = flatten((await driver.observe()).root).find((node) => node.role === 'dialog');
      assert.equal(dialog?.name, 'Delete account?');

      await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Delete', within: { role: 'dialog' } } } });
      // L'alerte est vue avant et après le geste, puis reconnue dans la source :
      // c'est celle de l'application, on la laisse.
      assert.deepEqual(fake.commands(), [
        'GET /source',
        NO_ALERT,
        'GET /source',
        'GET /source',
        'POST /elements',
        'POST /element/el-1/click',
        NO_ALERT,
        'GET /source',
      ]);
      assert.deepEqual(answered(), []);
    });

    it('refuses a gesture behind an open app alert, naming it', async () => {
      fake.source = ALERT;
      fake.alert = 'Delete account?';
      await assert.rejects(
        () => driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Delete account' } } }),
        /an alert is open \("Delete account\?"\): answer it first by clicking one of its buttons/,
      );
      assert.equal(fake.commands().some((command) => command.endsWith('/click')), false);
    });

    /**
     * Sur iPhone, WebDriverAgent signale une feuille d'actions comme une
     * alerte : y répondre derrière le geste qui l'ouvre rendrait ses options
     * inatteignables.
     */
    it('leaves an action sheet open after the tap that opened it, and lets the scenario pick an option', async () => {
      fake.source = SHEET.replace(/<XCUIElementTypeSheet[\s\S]*<\/XCUIElementTypeSheet>/, '');
      fake.on('POST', /\/element\/[^/]+\/click$/, (_call, server) => {
        server.source = SHEET;
        server.alert = 'Order actions';
        return undefined;
      });
      await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'More' } } });
      await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Delete', within: { role: 'dialog' } } } });
      assert.deepEqual(answered(), []);
      assert.equal(fake.commands().filter((command) => command.endsWith('/click')).length, 2);
    });

    it('fails the gesture that raised an alert outside the app, naming it', async () => {
      fake.on('POST', /\/element\/[^/]+\/click$/, (_call, server) => {
        server.alert = '“Acme” Would Like to Use Your Location';
        return undefined;
      });
      await assert.rejects(
        () => driver.act({ kind: 'click', target: SIGN_IN }),
        /an alert outside the app is open \("“Acme” Would Like to Use Your Location"\): QAI never answers system alerts/,
      );
      assert.deepEqual(answered(), []);
    });

    it('refuses to touch the screen while an alert outside the app is open', async () => {
      fake.alert = 'Allow notifications?';
      await assert.rejects(() => driver.act({ kind: 'click', target: SIGN_IN }), /an alert outside the app is open/);
      assert.deepEqual(fake.commands(), [NO_ALERT, 'GET /source']);
    });
  });

  describe('settle', () => {
    it('returns once two consecutive trees are identical', async () => {
      await driver.settle(2000);
      assert.deepEqual(fake.commands(), ['GET /source', 'GET /source']);
    });

    it('ignores the status bar clock, which the tree leaves out', async () => {
      let minute = 0;
      fake.on('GET', /\/source$/, () => {
        minute += 1;
        return {
          value: LOGIN.replace(
            '<XCUIElementTypeKeyboard ',
            `<XCUIElementTypeStatusBar type="XCUIElementTypeStatusBar" enabled="true" visible="true" x="0" y="0" width="390" height="47"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="9:4${minute}" label="9:4${minute}" x="40" y="14" width="40" height="20"/></XCUIElementTypeStatusBar><XCUIElementTypeKeyboard `,
          ),
        };
      });
      await driver.settle(2000);
      assert.deepEqual(fake.commands(), ['GET /source', 'GET /source']);
    });

    it('stops at the timeout when the screen never rests', async () => {
      let tick = 0;
      fake.on('GET', /\/source$/, () => ({ value: LOGIN.replace('Welcome back', `Welcome back ${(tick += 1)}`) }));
      const started = Date.now();
      await driver.settle(600);
      assert.ok(Date.now() - started < 1500, 'bounded by the timeout');
      assert.ok(tick >= 2);
    });
  });

  describe('state', () => {
    it('refuses cookies and storage rather than starting anonymous', async () => {
      await assert.rejects(
        () => driver.applyState({ cookies: [{ name: 'sid', value: 'x' }] }),
        /cookies and storage cannot be installed on iOS/,
      );
      await assert.rejects(() => driver.applyState({ storage: { k: 'v' } }), /cannot be installed on iOS/);
      assert.deepEqual(fake.calls, []);
    });

    it('opens the entry as a deep link', async () => {
      await driver.applyState({ cookies: [], entry: 'acme://session/restore' });
      assert.deepEqual(fake.commands(), ['POST /execute/sync mobile: deepLink', NO_ALERT]);
      assert.deepEqual(fake.calls[0]?.body, {
        script: 'mobile: deepLink',
        args: [{ url: 'acme://session/restore', bundleId: 'com.example.acme' }],
      });
    });
  });

  describe('W3C errors', () => {
    it('become errors naming the command, first line only', async () => {
      fake.on('GET', /\/source$/, () => ({
        status: 500,
        value: { error: 'unknown error', message: 'WebDriverAgent crashed\n    at FBRoute', stacktrace: 'long' },
      }));
      await assert.rejects(() => driver.observe(), (error: Error) => {
        assert.equal(error.message, 'get page source failed: unknown error — WebDriverAgent crashed');
        return true;
      });
    });

    it('propagate from mobile: commands', async () => {
      fake.on('POST', /\/execute\/sync$/, () => ({
        status: 404,
        value: { error: 'unknown method', message: 'Unsupported execute method' },
      }));
      await assert.rejects(
        () => driver.act({ kind: 'swipe', direction: 'up' }),
        (error: Error) => error.message === 'mobile: swipe failed: unknown method — Unsupported execute method',
      );
    });
  });

  describe('through the engine', () => {
    type StepActions = Resolution['steps'][string]['actions'];

    const journey = (
      steps: { id: string; expect?: string[]; actions: StepActions; assertions?: Record<string, Check> }[],
    ): { scenario: Scenario; resolution: Resolution } => ({
      scenario: {
        id: 'journey',
        title: 'A journey',
        steps: steps.map(({ id, expect }) => ({ id, do: `step ${id}`, ...(expect !== undefined ? { expect } : {}) })),
      },
      resolution: {
        scenario: 'journey',
        platform: 'ios',
        recordedAt: '2026-10-02T00:00:00.000Z',
        steps: Object.fromEntries(
          steps.map(({ id, actions, assertions }) => [id, { actions, ...(assertions !== undefined ? { assertions } : {}) }]),
        ),
      },
    });

    const shown: Check = { check: 'visible', target: SIGN_IN.primary };

    it('replays a step and asserts on the iOS tree', async () => {
      const report = await runScenario({
        ...journey([{ id: 's1', expect: ['shown'], actions: [{ kind: 'click', target: SIGN_IN }], assertions: { shown } }]),
        driver,
        assertTimeoutMs: 0,
      });
      assert.equal(report.status, 'passed', JSON.stringify(report.steps));
      assert.ok(fake.commands().includes('POST /element/el-1/click'));
    });

    it('refuses hover and expectDialog at planning, before touching the device', async () => {
      const refused: Action[] = [
        { kind: 'hover', target: SIGN_IN },
        { kind: 'expectDialog', response: 'accept' },
      ];
      for (const action of refused) {
        fake.calls.length = 0;
        const report = await runScenario({ ...journey([{ id: 's1', actions: [action] }]), driver, assertTimeoutMs: 0 });
        assert.equal(report.status, 'failed');
        assert.equal(report.steps[0]?.error, `action "${action.kind}" not supported on ios`);
        assert.deepEqual(fake.calls, []);
      }
    });

    /** La ligne existe encore, sous le pli : « elle a disparu » doit être faux. */
    it('fails "absent" for a row that is only scrolled below the fold', async () => {
      fake.source = ORDERS;
      const gone: Check = { check: 'absent', target: { role: 'text', name: 'Order #1042' } };
      const report = await runScenario({
        ...journey([{ id: 's1', expect: ['gone'], actions: [{ kind: 'swipe', direction: 'up' }], assertions: { gone } }]),
        driver,
        assertTimeoutMs: 0,
      });
      assert.equal(report.status, 'failed');
      assert.match(report.steps[0]?.failures[0]?.reason ?? '', /still present/);
    });

    it('fails network and console checks it cannot observe, instead of passing them', async () => {
      const report = await runScenario({
        ...journey([
          {
            id: 's1',
            expect: ['no call breaks', 'console stays quiet'],
            actions: [{ kind: 'click', target: SIGN_IN }],
            assertions: {
              'no call breaks': { check: 'noFailedRequests' },
              'console stays quiet': { check: 'noConsoleErrors' },
            },
          },
        ]),
        driver,
        assertTimeoutMs: 0,
      });
      assert.equal(report.status, 'failed');
      assert.deepEqual(
        report.steps[0]?.failures.map((failure) => failure.reason),
        [
          'not observable on ios: this driver does not report network or console activity',
          'not observable on ios: this driver does not report network or console activity',
        ],
      );
    });

    it('turns active watchdogs into an explicit failure or warning', async () => {
      const report = await runScenario({
        ...journey([{ id: 's1', actions: [{ kind: 'click', target: SIGN_IN }] }]),
        driver,
        assertTimeoutMs: 0,
        watchdogs: { requestFailures: 'fail', consoleErrors: 'warn' },
      });
      assert.equal(report.status, 'failed');
      assert.match(report.steps[0]?.error ?? '', /watchdog requestFailures cannot run on ios/);
      assert.match(report.steps[0]?.warnings?.[0] ?? '', /watchdog consoleErrors cannot run on ios/);
    });

    /**
     * Une erreur affichée en alerte reste à l'écran : elle s'asserte, et le
     * geste suivant échoue en la nommant au lieu de passer dessous.
     */
    it('keeps an app error alert assertable, then stops at the next gesture', async () => {
      fake.on('POST', /\/element\/[^/]+\/click$/, (_call, server) => {
        if (server.source === LOGIN) {
          server.source = ALERT;
          server.alert = 'Delete account?';
        }
        return undefined;
      });
      const report = await runScenario({
        ...journey([
          {
            id: 's1',
            expect: ['the alert is shown'],
            actions: [{ kind: 'click', target: SIGN_IN }],
            assertions: { 'the alert is shown': { check: 'visible', target: { role: 'dialog', name: 'Delete account?' } } },
          },
          { id: 's2', actions: [{ kind: 'click', target: { primary: { role: 'button', name: 'Delete account' } } }] },
        ]),
        driver,
        assertTimeoutMs: 0,
      });
      assert.equal(report.steps[0]?.status, 'passed', JSON.stringify(report.steps[0]));
      assert.equal(report.steps[1]?.status, 'failed');
      assert.match(report.steps[1]?.error ?? '', /an alert is open \("Delete account\?"\)/);
      assert.equal(fake.commands().some((command) => /\/alert\/(accept|dismiss)/.test(command)), false);
    });
  });

  describe('through generation', () => {
    /** Un modèle factice qui propose toujours la même chose. */
    class FixedProvider implements ModelProvider {
      readonly name = 'fixed';
      readonly #output: Record<string, unknown>;

      constructor(output: Record<string, unknown>) {
        this.#output = output;
      }

      async complete(_request: ModelRequest): Promise<ModelResponse> {
        return { output: this.#output, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }

    it('refuses to record a network check the driver cannot observe', async () => {
      const provider = new FixedProvider({
        actions: [{ kind: 'click', target: SIGN_IN }],
        captures: {},
        assertions: { 'no call breaks': { check: 'noFailedRequests' } },
      });
      const result = await generateResolution({
        scenario: { id: 'login', title: 'Sign in', steps: [{ id: 's1', do: 'sign in', expect: ['no call breaks'] }] },
        driver,
        provider,
        // Une reprise : le rejet de la première proposition est alors rapporté.
        attemptsPerStep: 2,
      });
      assert.equal(result.status, 'incomplete');
      assert.match(
        result.steps[0]?.rejections.join('\n') ?? '',
        /noFailedRequests cannot be observed on this platform/,
      );
    });

    it('records the #id fallback the model reads in the tree, and replays through it', async () => {
      const target: ResolvedTarget = { ...SIGN_IN, fallback: { testId: 'login_button' } };
      const provider = new FixedProvider({ actions: [{ kind: 'click', target }], captures: {}, assertions: {} });
      const result = await generateResolution({
        scenario: { id: 'login', title: 'Sign in', steps: [{ id: 's1', do: 'sign in' }] },
        driver,
        provider,
        attemptsPerStep: 1,
      });
      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.deepEqual(result.resolution.steps['s1']?.actions, [{ kind: 'click', target }]);

      // Le libellé change : le repli lu dans l'arbre est celui que ce pilote suit.
      fake.source = LOGIN.replace('name="login_button" label="Sign In"', 'name="login_button" label="Log in"');
      const replay = await driver.resolve(target);
      assert.equal(replay.found && replay.usedFallback, true);
    });
  });
});
