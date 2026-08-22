import type { Browser, Locator as PWLocator, Page } from 'playwright';
import type {
  Action,
  Capabilities,
  Driver,
  LaunchTarget,
  ObserveOptions,
  Platform,
  PreparedState,
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
      throw new DriverError('launch() must be called before any other operation', 'not-launched');
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

  async applyState(state: PreparedState): Promise<void> {
    const page = this.#activePage;
    const context = page.context();

    if (state.cookies !== undefined && state.cookies.length > 0) {
      const origin = new URL(this.#baseUrl);
      await context.addCookies(
        state.cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain ?? origin.hostname,
          path: cookie.path ?? '/',
          // Omis plutot que rendus explicites : laisser le navigateur appliquer
          // ses propres defauts quand l'appelant ne se prononce pas.
          ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
          ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
        })),
      );
    }

    if (state.storage !== undefined && Object.keys(state.storage).length > 0) {
      const entries = JSON.stringify(Object.entries(state.storage));
      // Le script d'initialisation couvre les navigations à venir ; l'écriture
      // directe couvre la page déjà ouverte. Les deux sont nécessaires.
      const script = `for (const [k, v] of ${entries}) localStorage.setItem(k, v);`;
      await context.addInitScript({ content: script });
      await page.evaluate(script);
    }

    if (state.entry !== undefined) {
      await page.goto(new URL(state.entry, this.#baseUrl).toString());
      return;
    }

    // La page a été chargée par launch(), AVANT la pose de l'état : le code
    // d'amorçage de l'application a déjà lu des cookies et un storage absents.
    // Sans point d'entrée demandé, on recharge pour que l'application démarre
    // avec l'état réellement installé — sinon elle resterait rendue
    // « déconnectée » pour toute la durée du parcours.
    const applied =
      (state.cookies !== undefined && state.cookies.length > 0) ||
      (state.storage !== undefined && Object.keys(state.storage).length > 0);
    if (applied) await page.reload();
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
      if (collect === undefined) throw new Error('QAI collector missing from the page');
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

  /**
   * La cascade primary → repli, définie une seule fois.
   *
   * `resolve()` et `act()` doivent appliquer exactement les mêmes règles :
   * deux implémentations parallèles finiraient par diverger, et le moteur
   * agirait alors sur un élément différent de celui qu'il a validé.
   */
  async #pick(
    target: ResolvedTarget,
  ): Promise<{ locator: PWLocator | null; usedFallback: boolean; matches: number }> {
    const page = this.#activePage;
    const base = buildLocator(page, target.primary, false);
    const matches = await base.count();

    if (matches > 1 && target.primary.nth === undefined) {
      return { locator: null, usedFallback: false, matches };
    }

    if (matches >= 1) {
      const locator =
        target.primary.nth !== undefined ? base.nth(target.primary.nth) : base.first();
      return { locator, usedFallback: false, matches };
    }

    const fallback = target.fallback ? buildFallback(page, target.fallback) : null;
    if (fallback !== null && (await fallback.count()) >= 1) {
      return { locator: fallback.first(), usedFallback: true, matches: 0 };
    }

    return { locator: null, usedFallback: false, matches: 0 };
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    await this.#ensureCollector();
    const { locator, usedFallback, matches } = await this.#pick(target);

    if (locator === null) {
      return matches > 1
        ? { found: false, reason: 'ambiguous', matches }
        : { found: false, reason: 'no-match', matches: 0 };
    }

    const node = await this.#describe(locator);
    if (!node.state.visible) return { found: false, reason: 'not-visible', matches };
    return { found: true, node, usedFallback };
  }

  async #describe(locator: PWLocator): Promise<UINode> {
    return locator.evaluate((el: Element, opts: CollectOptions) => {
      const collect = (globalThis as PageGlobals).__qaiCollect;
      if (collect === undefined) throw new Error('QAI collector missing from the page');
      return collect(el, opts);
    }, { interactiveOnly: false, maxDepth: 0 });
  }

  /**
   * Choisir par **libellé** d'abord, par valeur ensuite.
   *
   * `selectOption(string)` de Playwright apparie la *value* de l'option, qui
   * est un détail technique invisible de l'utilisateur — un outil d'intention
   * doit viser ce qui est affiché. L'ordre est donc libellé puis valeur : les
   * résolutions produites par le modèle décrivent ce qu'il a lu à l'écran, et
   * les anciennes, écrites par valeur, passent par le repli.
   *
   * Les options sont lues d'un coup avant de choisir. Tenter le libellé puis
   * rattraper l'erreur consommerait un délai d'attente complet — trente
   * secondes par `select` sur les résolutions existantes.
   */
  async #select(locator: PWLocator, option: string): Promise<void> {
    const labels = await locator.evaluate((element) =>
      element instanceof HTMLSelectElement
        ? Array.from(element.options).map((one) => (one.label || one.textContent) ?? '')
        : [],
    );

    const known = labels.some((label) => label.trim() === option);
    await locator.selectOption(known ? { label: option } : option);
  }

  async #locatorFor(target: ResolvedTarget): Promise<PWLocator> {
    const { locator, matches } = await this.#pick(target);
    if (locator !== null) return locator;
    throw new DriverError(
      matches > 1 ? `ambiguous target: ${matches} elements` : 'target not found, even via the fallback',
      'unresolved',
    );
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
        throw new DriverError('swipe does not exist on the web driver', 'unsupported');
      case 'click':
        await (await this.#locatorFor(action.target)).click();
        return;
      case 'fill':
        await (await this.#locatorFor(action.target)).fill(action.value);
        return;
      case 'select':
        await this.#select(await this.#locatorFor(action.target), action.option);
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
