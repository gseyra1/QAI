import type { Browser, Locator as PWLocator, Page } from 'playwright';
import type {
  Action,
  Capabilities,
  Driver,
  LaunchTarget,
  ObserveOptions,
  Platform,
  ResolvedTarget,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../types.ts';
import { buildFallback, buildLocator } from './locator.ts';
import { collectTree } from './observe-script.ts';

export type DriverErrorCode = 'not-launched' | 'unsupported' | 'unresolved';

export class DriverError extends Error {
  readonly code: DriverErrorCode;

  constructor(message: string, code: DriverErrorCode) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
  }
}

interface CollectOptions {
  interactiveOnly: boolean;
  maxDepth?: number;
}

interface PageGlobals {
  __qaiCollect?: (root: Element, options: CollectOptions) => UINode;
}

/**
 * Le collecteur est injecté sous forme de source plutôt qu'importé : il
 * s'exécute dans la page, où aucun module du projet n'existe et où aucune
 * fonction du contexte Node ne peut être transmise.
 */
const COLLECTOR_SOURCE = `(() => { globalThis.__qaiCollect = ${collectTree.toString()}; })()`;

export class PlaywrightWebDriver implements Driver {
  readonly platform: Platform = 'web';
  readonly capabilities: Capabilities = {
    hover: true,
    swipe: false,
    navigateByUrl: true,
    deepLink: true,
  };

  readonly #launch: () => Promise<Browser>;
  #browser: Browser | null = null;
  #page: Page | null = null;
  #baseUrl = '';

  constructor(launcher: () => Promise<Browser>) {
    this.#launch = launcher;
  }

  get #activePage(): Page {
    if (this.#page === null) {
      throw new DriverError('launch() doit être appelé avant toute autre opération', 'not-launched');
    }
    return this.#page;
  }

  async launch(target: LaunchTarget): Promise<void> {
    this.#browser = await this.#launch();
    const context = await this.#browser.newContext(
      target.viewport ? { viewport: target.viewport } : {},
    );
    this.#page = await context.newPage();
    this.#baseUrl = target.entry;
    await this.#page.addInitScript({ content: COLLECTOR_SOURCE });
    await this.#page.goto(target.entry);
  }

  async #ensureCollector(): Promise<void> {
    const page = this.#activePage;
    const present = await page.evaluate(
      () => typeof (globalThis as PageGlobals).__qaiCollect === 'function',
    );
    if (!present) await page.evaluate(COLLECTOR_SOURCE);
  }

  async observe(options: ObserveOptions = {}): Promise<UISnapshot> {
    const page = this.#activePage;
    await this.#ensureCollector();

    const root = await page.evaluate((opts: CollectOptions) => {
      const collect = (globalThis as PageGlobals).__qaiCollect;
      if (collect === undefined) throw new Error('collecteur QAI absent de la page');
      return collect(globalThis.document.body, opts);
    }, { interactiveOnly: options.interactiveOnly ?? false });

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const snapshot: UISnapshot = {
      platform: 'web',
      at: new Date().toISOString(),
      location: page.url(),
      viewport: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      root,
    };

    if (options.screenshot === true) snapshot.screenshot = await page.screenshot();
    return snapshot;
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    const page = this.#activePage;
    await this.#ensureCollector();

    const base = buildLocator(page, target.primary, false);
    const matches = await base.count();

    if (matches > 1 && target.primary.nth === undefined) {
      return { found: false, reason: 'ambiguous', matches };
    }

    if (matches >= 1) {
      const picked = target.primary.nth !== undefined ? base.nth(target.primary.nth) : base.first();
      const node = await this.#describe(picked);
      if (!node.state.visible) return { found: false, reason: 'not-visible', matches };
      return { found: true, node, usedFallback: false };
    }

    const fallback = target.fallback ? buildFallback(page, target.fallback) : null;
    if (fallback !== null && (await fallback.count()) >= 1) {
      const node = await this.#describe(fallback.first());
      if (!node.state.visible) return { found: false, reason: 'not-visible', matches: 0 };
      return { found: true, node, usedFallback: true };
    }

    return { found: false, reason: 'no-match', matches: 0 };
  }

  async #describe(locator: PWLocator): Promise<UINode> {
    return locator.evaluate((el: Element, opts: CollectOptions) => {
      const collect = (globalThis as PageGlobals).__qaiCollect;
      if (collect === undefined) throw new Error('collecteur QAI absent de la page');
      return collect(el, opts);
    }, { interactiveOnly: false, maxDepth: 0 });
  }

  async #locatorFor(target: ResolvedTarget): Promise<PWLocator> {
    const page = this.#activePage;
    const base = buildLocator(page, target.primary, false);
    if ((await base.count()) >= 1) {
      return target.primary.nth !== undefined ? base.nth(target.primary.nth) : base.first();
    }
    const fallback = target.fallback ? buildFallback(page, target.fallback) : null;
    if (fallback !== null && (await fallback.count()) >= 1) return fallback.first();
    throw new DriverError('cible introuvable, y compris par le repli', 'unresolved');
  }

  async act(action: Action): Promise<void> {
    const page = this.#activePage;

    switch (action.kind) {
      case 'navigate':
        await page.goto(new URL(action.to, this.#baseUrl).toString());
        return;
      case 'press':
        await page.keyboard.press(action.key);
        return;
      case 'swipe':
        throw new DriverError("le glissement n'existe pas sur le driver web", 'unsupported');
      case 'click':
        await (await this.#locatorFor(action.target)).click();
        return;
      case 'fill':
        await (await this.#locatorFor(action.target)).fill(action.value);
        return;
      case 'select':
        await (await this.#locatorFor(action.target)).selectOption(action.option);
        return;
      case 'hover':
        await (await this.#locatorFor(action.target)).hover();
        return;
      case 'scrollTo':
        await (await this.#locatorFor(action.target)).scrollIntoViewIfNeeded();
        return;
    }
  }

  async settle(timeoutMs = 5000): Promise<void> {
    const page = this.#activePage;
    try {
      await page.waitForLoadState('networkidle', { timeout: timeoutMs });
    } catch {
      // Un flux SSE ou un sondage périodique empêche définitivement le repos
      // réseau. On poursuit : l'échec de résolution qui suivra est un signal
      // plus fiable qu'une attente qui n'aboutira jamais.
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }

  async dispose(): Promise<void> {
    await this.#page?.context().close();
    await this.#browser?.close();
    this.#page = null;
    this.#browser = null;
  }
}
