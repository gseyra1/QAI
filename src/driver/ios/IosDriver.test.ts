import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { runScenario } from '../../engine/run.ts';
import type { Resolution } from '../../resolution/types.ts';
import type { Scenario } from '../../scenario/types.ts';
import type { ResolvedTarget } from '../types.ts';
import { FakeAppium, fixture } from './fake-appium.ts';
import { IosDriver } from './IosDriver.ts';

const LOGIN = fixture('login.xml');
const ORDERS = fixture('orders.xml');
const SCROLLED = fixture('orders-scrolled.xml');
const ALERT = fixture('alert.xml');

const SIGN_IN: ResolvedTarget = { primary: { role: 'button', name: 'Sign In' } };

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

    it('installs a .app by absolute path, targets a UDID, then learns the bundle id', async () => {
      const udid = '6A0E4B1C-2D3F-4A5B-8C7D-9E0F1A2B3C4D';
      const own = new IosDriver({ serverUrl: fake.url, device: udid });
      fake.activeBundleId = 'com.example.built';
      await own.launch({ entry: 'build/Acme.app' });
      await own.act({ kind: 'navigate', to: '.' });
      await own.dispose();
      fake.activeBundleId = 'com.example.acme';

      const created = fake.calls[0]?.body as { capabilities: { alwaysMatch: Record<string, string> } };
      assert.deepEqual(created.capabilities.alwaysMatch, {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:app': resolve('build/Acme.app'),
        'appium:udid': udid,
      });
      assert.deepEqual(fake.calls[1]?.body, { script: 'mobile: activeAppInfo', args: [{}] });
      // La relance vise le bundle appris, pas le chemin.
      assert.deepEqual(fake.calls[2]?.body, { script: 'mobile: terminateApp', args: [{ bundleId: 'com.example.built' }] });
      assert.deepEqual(fake.calls[3]?.body, { script: 'mobile: activateApp', args: [{ bundleId: 'com.example.built' }] });
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
      fake.on('DELETE', /^\/session\//, () => ({
        status: 404,
        value: { error: 'invalid session id', message: 'A session is either terminated or not started' },
      }));
      await own.dispose();
      await own.dispose();
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
  });

  describe('resolve', () => {
    it('finds a unique, visible target', async () => {
      const outcome = await driver.resolve(SIGN_IN);
      assert.equal(outcome.found, true);
      assert.equal(outcome.found && outcome.node.testId, 'login_button');
      assert.equal(outcome.found && outcome.usedFallback, false);
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

    it('says not-visible for a target present off screen', async () => {
      fake.source = ORDERS;
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Track parcel' } });
      assert.deepEqual(outcome, { found: false, reason: 'not-visible', matches: 1 });
    });

    it('says no-match when nothing matches', async () => {
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Pay now' } });
      assert.deepEqual(outcome, { found: false, reason: 'no-match', matches: 0 });
    });

    it('falls back to the accessibility identifier, and says so', async () => {
      const outcome = await driver.resolve({
        primary: { role: 'button', name: 'Log in' },
        fallback: { accessibilityId: 'login_button' },
      });
      assert.equal(outcome.found, true);
      assert.equal(outcome.found && outcome.usedFallback, true);
      assert.equal(outcome.found && outcome.node.name, 'Sign In');
    });

    it('ignores the web-only fallbacks', async () => {
      const outcome = await driver.resolve({
        primary: { role: 'button', name: 'Log in' },
        fallback: { testId: 'login_button', selector: '#login' },
      });
      assert.deepEqual(outcome, { found: false, reason: 'no-match', matches: 0 });
    });
  });

  describe('act', () => {
    it('click taps the centre of the target through mobile: tap', async () => {
      await driver.act({ kind: 'click', target: SIGN_IN });
      assert.deepEqual(fake.commands(), ['GET /source', 'POST /execute/sync mobile: tap', 'GET /alert/text']);
      assert.deepEqual(fake.calls[1]?.body, { script: 'mobile: tap', args: [{ x: 195, y: 501 }] });
    });

    it('click refuses an ambiguous or hidden target without touching the screen', async () => {
      fake.source = ORDERS;
      await assert.rejects(
        () => driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Reorder' } } }),
        /ambiguous target: 2 elements/,
      );
      await assert.rejects(
        () => driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Track parcel' } } }),
        /not visible/,
      );
      assert.deepEqual(fake.commands(), ['GET /source', 'GET /source']);
    });

    it('fill finds the exact element, focuses, clears, then types', async () => {
      await driver.act({ kind: 'fill', target: { primary: { role: 'textbox', name: 'Password' } }, value: 'hunter2-secret' });
      assert.deepEqual(fake.commands(), [
        'GET /source',
        'POST /elements',
        'POST /element/el-1/click',
        'POST /element/el-1/clear',
        'POST /element/el-1/value',
        'GET /alert/text',
      ]);
      assert.deepEqual(fake.calls[1]?.body, {
        using: 'xpath',
        value:
          '//XCUIElementTypeApplication[1]/XCUIElementTypeWindow[1]/XCUIElementTypeOther[1]' +
          '/XCUIElementTypeOther[1]/XCUIElementTypeOther[1]/XCUIElementTypeSecureTextField[1]',
      });
      assert.deepEqual(fake.calls[4]?.body, { text: 'hunter2-secret' });
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

    it('fill refuses when the screen changed between resolution and action', async () => {
      fake.on('POST', /\/elements$/, () => ({ value: [] }));
      await assert.rejects(
        () => driver.act({ kind: 'fill', target: { primary: { role: 'textbox', name: 'Email' } }, value: 'a@b.c' }),
        /the screen changed between resolution and action/,
      );
      assert.equal(fake.commands().includes('POST /element/el-1/value'), false);
    });

    it('select sends the displayed label to the picker wheel', async () => {
      await driver.act({ kind: 'select', target: { primary: { role: 'combobox', name: 'Delivery' } }, option: 'Express delivery' });
      assert.deepEqual(fake.commands(), ['GET /source', 'POST /elements', 'POST /element/el-1/value', 'GET /alert/text']);
      assert.deepEqual(fake.calls[2]?.body, { text: 'Express delivery' });
      assert.match(String((fake.calls[1]?.body as { value: string }).value), /XCUIElementTypePickerWheel\[1\]$/);
    });

    it('select refuses anything but a picker wheel', async () => {
      await assert.rejects(
        () => driver.act({ kind: 'select', target: SIGN_IN, option: 'x' }),
        /select needs a picker wheel on iOS, the target is a button/,
      );
    });

    it('press types the key into the focused element', async () => {
      await driver.act({ kind: 'press', key: 'Enter' });
      assert.deepEqual(fake.commands(), ['GET /element/active', 'POST /element/el-active/value', 'GET /alert/text']);
      assert.deepEqual(fake.calls[1]?.body, { text: '\n' });
    });

    it('press refuses a key it cannot produce, before any request', async () => {
      await assert.rejects(() => driver.act({ kind: 'press', key: 'F5' }), /press "F5" is not supported on iOS/);
      assert.deepEqual(fake.calls, []);
    });

    it('swipe goes through mobile: swipe', async () => {
      await driver.act({ kind: 'swipe', direction: 'left' });
      assert.deepEqual(fake.calls[0]?.body, { script: 'mobile: swipe', args: [{ direction: 'left' }] });
    });

    it('navigate opens an absolute URL as a deep link into the app under test', async () => {
      await driver.act({ kind: 'navigate', to: 'acme://orders/1042' });
      assert.deepEqual(fake.calls[0]?.body, {
        script: 'mobile: deepLink',
        args: [{ url: 'acme://orders/1042', bundleId: 'com.example.acme' }],
      });
    });

    it('navigate "." relaunches the app', async () => {
      await driver.act({ kind: 'navigate', to: '.' });
      assert.deepEqual(fake.commands(), [
        'POST /execute/sync mobile: terminateApp',
        'POST /execute/sync mobile: activateApp',
        'GET /alert/text',
      ]);
    });

    it('navigate refuses a relative path: iOS has no base URL', async () => {
      await assert.rejects(() => driver.act({ kind: 'navigate', to: '/cart' }), /absolute deep link URL/);
      assert.deepEqual(fake.calls, []);
    });

    it('scrollTo scrolls toward an off-screen target until it is visible', async () => {
      fake.source = ORDERS;
      fake.on('POST', /\/execute\/sync$/, (call, server) => {
        if ((call.body as { script: string }).script === 'mobile: scroll') server.source = SCROLLED;
        return undefined;
      });
      await driver.act({ kind: 'scrollTo', target: { primary: { role: 'button', name: 'Track parcel' } } });
      assert.deepEqual(fake.commands(), ['GET /source', 'POST /execute/sync mobile: scroll', 'GET /source']);
      assert.deepEqual(fake.calls[1]?.body, { script: 'mobile: scroll', args: [{ direction: 'down' }] });
    });

    it('scrollTo searches down then up for a missing target, and gives up at the edges', async () => {
      await assert.rejects(
        () => driver.act({ kind: 'scrollTo', target: { primary: { role: 'button', name: 'Nowhere' } } }),
        /target still not visible after scrolling/,
      );
      const scrolls = fake.calls.filter((call) => (call.body as { script?: string } | undefined)?.script === 'mobile: scroll');
      assert.deepEqual(
        scrolls.map((call) => (call.body as { args: [{ direction: string }] }).args[0].direction),
        ['down', 'up'],
      );
    });

    it('scrollTo is bounded even when the screen keeps changing', async () => {
      let tick = 0;
      fake.on('POST', /\/execute\/sync$/, (_call, server) => {
        tick += 1;
        server.source = `${LOGIN}<!-- ${tick} -->`;
        return undefined;
      });
      await assert.rejects(
        () => driver.act({ kind: 'scrollTo', target: { primary: { role: 'button', name: 'Nowhere' } } }),
        /at most/,
      );
      assert.equal(tick, 8);
    });

    it('hover and upload are refused explicitly, and hover is declared unsupported', async () => {
      assert.equal(driver.capabilities.hover, false);
      assert.equal(driver.capabilities.dialogs, true);
      await assert.rejects(() => driver.act({ kind: 'hover', target: SIGN_IN }), /hover does not exist on iOS/);
      await assert.rejects(
        () => driver.act({ kind: 'upload', target: SIGN_IN, files: ['a.csv'] }),
        /upload is not supported on iOS/,
      );
      assert.deepEqual(fake.calls, []);
    });
  });

  describe('dialogs', () => {
    const showAlertOnTap = (): void => {
      fake.on('POST', /\/execute\/sync$/, (call, server) => {
        if ((call.body as { script: string }).script === 'mobile: tap') server.alert = 'Delete account?';
        return undefined;
      });
    };

    it('dismisses an alert nobody armed, like the web driver', async () => {
      showAlertOnTap();
      await driver.act({ kind: 'click', target: SIGN_IN });
      assert.deepEqual(fake.commands().slice(-2), ['GET /alert/text', 'POST /alert/dismiss']);
      assert.equal(fake.alert, null);
    });

    it('accepts an armed alert after the next gesture, once', async () => {
      showAlertOnTap();
      await driver.act({ kind: 'expectDialog', response: 'accept' });
      assert.deepEqual(fake.calls, [], 'arming sends nothing');
      await driver.act({ kind: 'click', target: SIGN_IN });
      assert.deepEqual(fake.commands().slice(-2), ['GET /alert/text', 'POST /alert/accept']);

      // Consommée : le dialogue suivant retombe sur le refus.
      await driver.act({ kind: 'click', target: SIGN_IN });
      assert.deepEqual(fake.commands().slice(-1), ['POST /alert/dismiss']);
      assert.equal(driver.takePendingDialogs(), 0);
    });

    it('types the prompt text before accepting', async () => {
      showAlertOnTap();
      await driver.act({ kind: 'expectDialog', response: 'accept', promptText: 'New name' });
      await driver.act({ kind: 'click', target: SIGN_IN });
      assert.deepEqual(fake.commands().slice(-3), ['GET /alert/text', 'POST /alert/text', 'POST /alert/accept']);
      assert.deepEqual(fake.calls.at(-2)?.body, { text: 'New name' });
    });

    it('answers an armed alert that only appears while settling', async () => {
      fake.source = ALERT;
      await driver.act({ kind: 'expectDialog', response: 'dismiss' });
      await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Delete account' } } });
      assert.equal(driver.takePendingDialogs(), 1, 'nothing appeared yet: still armed');

      await driver.act({ kind: 'expectDialog', response: 'dismiss' });
      fake.alert = 'Delete account?';
      await driver.settle(1000);
      assert.ok(fake.commands().includes('POST /alert/dismiss'));
      assert.equal(driver.takePendingDialogs(), 0);
    });

    it('hands back and clears the policies never consumed', async () => {
      await driver.act({ kind: 'expectDialog', response: 'accept' });
      await driver.act({ kind: 'expectDialog', response: 'dismiss' });
      assert.equal(driver.takePendingDialogs(), 2);
      assert.equal(driver.takePendingDialogs(), 0);
    });
  });

  describe('settle', () => {
    it('returns once two consecutive sources are identical', async () => {
      await driver.settle(2000);
      assert.deepEqual(fake.commands(), ['GET /alert/text', 'GET /source', 'GET /alert/text', 'GET /source']);
    });

    it('stops at the timeout when the screen never rests', async () => {
      let tick = 0;
      fake.on('GET', /\/source$/, () => ({ value: `${LOGIN}<!-- ${(tick += 1)} -->` }));
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
    const scenario: Scenario = {
      id: 'login',
      title: 'Sign in',
      steps: [{ id: 's1', do: 'sign in', expect: 'the sign-in button is shown' }],
    };
    const resolutionWith = (actions: Resolution['steps'][string]['actions']): Resolution => ({
      scenario: 'login',
      platform: 'ios',
      recordedAt: '2026-10-02T00:00:00.000Z',
      steps: {
        s1: {
          actions,
          assertions: { 'the sign-in button is shown': { check: 'visible', target: SIGN_IN.primary } },
        },
      },
    });

    it('replays a step and asserts on the iOS tree', async () => {
      const report = await runScenario({
        scenario,
        resolution: resolutionWith([{ kind: 'click', target: SIGN_IN }]),
        driver,
        assertTimeoutMs: 0,
      });
      assert.equal(report.status, 'passed', JSON.stringify(report.steps));
      assert.ok(fake.commands().includes('POST /execute/sync mobile: tap'));
    });

    it('refuses hover at planning, before touching the device', async () => {
      const report = await runScenario({
        scenario,
        resolution: resolutionWith([{ kind: 'hover', target: SIGN_IN }]),
        driver,
        assertTimeoutMs: 0,
      });
      assert.equal(report.status, 'failed');
      assert.equal(report.steps[0]?.error, 'action "hover" not supported on ios');
      assert.equal(fake.commands().includes('POST /execute/sync mobile: tap'), false);
    });
  });
});
