import { isAbsolute, resolve as resolvePath } from 'node:path';
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
import { matchNodes } from '../../engine/match.ts';
import { AppiumClient, AppiumError, ELEMENT_KEY } from './appium.ts';
import { isAppPath, isBundleId, isUdid } from './entry.ts';
import type { Screen } from './source.ts';
import { readScreen } from './source.ts';

/**
 * Pilote iOS — EXPÉRIMENTAL.
 *
 * Il parle à un serveur Appium (pilote XCUITest) par le protocole W3C
 * WebDriver, avec `fetch` et rien d'autre : Appium et Xcode sont des
 * prérequis côté utilisateur, comme un navigateur l'est pour le web.
 *
 * Jamais validé sur un appareil au moment où il est écrit : sa justesse repose
 * sur la fidélité au protocole documenté et sur un faux serveur qui vérifie
 * chaque appel. D'où le statut expérimental, affiché dans la documentation.
 */

export type IosDriverErrorCode = 'not-launched' | 'unsupported' | 'unresolved' | 'invalid-entry';

export class IosDriverError extends Error {
  readonly code: IosDriverErrorCode;

  constructor(message: string, code: IosDriverErrorCode) {
    super(message);
    this.name = 'IosDriverError';
    this.code = code;
  }
}

export interface IosDriverOptions {
  /** Serveur Appium. Défaut : http://127.0.0.1:4723, celui d'Appium 2 et 3. */
  serverUrl?: string;
  /** UDID ou nom d'appareil ; absent, Appium choisit. */
  device?: string;
  platformVersion?: string;
  /** Délai par commande, hors création de session. Défaut : 60 s. */
  commandTimeoutMs?: number;
}

export const DEFAULT_APPIUM_URL = 'http://127.0.0.1:4723';

/** Démarrer un simulateur et installer WebDriverAgent prend des minutes. */
const SESSION_TIMEOUT_MS = 10 * 60_000;

/** Intervalle de sondage de `settle`. Une source XCUITest coûte déjà ~0,5 s. */
const POLL_MS = 250;

/** Défilements tentés par `scrollTo` avant d'abandonner. */
const MAX_SCROLLS = 8;

/**
 * Touches que `press` sait produire, en caractères tapés.
 *
 * XCUITest n'a pas d'API de touche nommée hors clavier matériel : la touche
 * passe par la saisie de texte sur l'élément actif, où « \n » est Retour et
 * « \b » l'effacement — les caractères que XCTest traduit en touches.
 */
const KEYS: Readonly<Record<string, string>> = {
  Enter: '\n',
  Return: '\n',
  Tab: '\t',
  Backspace: '\b',
  Delete: '\b',
  Space: ' ',
};

interface Picked {
  node: UINode | null;
  usedFallback: boolean;
  matches: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function elementIdOf(value: unknown, command: string): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const id = record[ELEMENT_KEY] ?? record['ELEMENT'];
    if (typeof id === 'string') return id;
  }
  throw new Error(`${command} failed: the response carries no element reference`);
}

export class IosDriver implements Driver {
  readonly platform: Platform = 'ios';
  /**
   * `hover` n'existe pas sous le doigt : le refus est déclaré ici pour que le
   * moteur l'oppose à la planification, pas au milieu d'un parcours.
   * `navigateByUrl` vaut oui parce que `navigate` est servi — par lien profond
   * ou relance — mais seulement pour une URL absolue ou « . ».
   */
  readonly capabilities: Capabilities = {
    hover: false,
    swipe: true,
    navigateByUrl: true,
    deepLink: true,
    dialogs: true,
  };

  readonly #client: AppiumClient;
  readonly #device: string | undefined;
  readonly #platformVersion: string | undefined;
  #session: string | null = null;
  #bundleId = '';
  /** File des politiques armées par `expectDialog`, consommées dans l'ordre. */
  readonly #dialogs: { response: 'accept' | 'dismiss'; promptText?: string }[] = [];

  constructor(options: IosDriverOptions = {}) {
    this.#client = new AppiumClient(options.serverUrl ?? DEFAULT_APPIUM_URL, options.commandTimeoutMs ?? 60_000);
    this.#device = options.device;
    this.#platformVersion = options.platformVersion;
  }

  get #path(): string {
    if (this.#session === null) {
      throw new IosDriverError('launch() must be called before any other operation', 'not-launched');
    }
    return `/session/${encodeURIComponent(this.#session)}`;
  }

  async #call(
    method: 'GET' | 'POST' | 'DELETE',
    suffix: string,
    body: unknown,
    command: string,
    redact?: string[],
  ): Promise<unknown> {
    return this.#client.request(method, `${this.#path}${suffix}`, body, {
      command,
      ...(redact !== undefined ? { redact } : {}),
    });
  }

  /** Les méthodes `mobile:` passent par Execute Script, arguments en un objet. */
  async #mobile(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.#call('POST', '/execute/sync', { script: `mobile: ${name}`, args: [args] }, `mobile: ${name}`);
  }

  async launch(target: LaunchTarget): Promise<void> {
    // Une seconde session sur le même appareil laisserait la première orpheline.
    if (this.#session !== null) await this.dispose();

    const entry = target.entry.trim();
    const path = isAppPath(entry);
    if (!path && !isBundleId(entry)) {
      throw new IosDriverError(
        `"${entry}" is neither a bundle id (com.example.app) nor a path to a .app or .ipa`,
        'invalid-entry',
      );
    }

    const capabilities: Record<string, string> = {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
    };
    if (path) {
      // Un chemin relatif se lit depuis le répertoire courant ; une URL
      // distante est transmise telle quelle, Appium sait la télécharger.
      capabilities['appium:app'] = /^https?:\/\//i.test(entry) || isAbsolute(entry) ? entry : resolvePath(entry);
    } else {
      capabilities['appium:bundleId'] = entry;
    }
    if (this.#device !== undefined) {
      capabilities[isUdid(this.#device) ? 'appium:udid' : 'appium:deviceName'] = this.#device;
    }
    if (this.#platformVersion !== undefined) capabilities['appium:platformVersion'] = this.#platformVersion;

    const created = await this.#client.request(
      'POST',
      '/session',
      { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
      { command: 'new session', timeoutMs: SESSION_TIMEOUT_MS },
    );
    const sessionId =
      typeof created === 'object' && created !== null ? (created as Record<string, unknown>)['sessionId'] : undefined;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('new session failed: the response carries no sessionId');
    }
    this.#session = sessionId;

    if (!path) {
      this.#bundleId = entry;
      return;
    }
    // Installée depuis un chemin, l'application n'est connue que par son
    // bundle une fois lancée : c'est lui que la relance et le lien profond
    // désignent ensuite.
    const info = await this.#mobile('activeAppInfo', {});
    const bundleId =
      typeof info === 'object' && info !== null ? (info as Record<string, unknown>)['bundleId'] : undefined;
    if (typeof bundleId !== 'string' || bundleId === '') {
      throw new Error('mobile: activeAppInfo failed: the response carries no bundleId');
    }
    this.#bundleId = bundleId;
  }

  async applyState(state: PreparedState): Promise<void> {
    const cookies = state.cookies !== undefined && state.cookies.length > 0;
    const storage = state.storage !== undefined && Object.keys(state.storage).length > 0;
    if (cookies || storage) {
      // Les ignorer ferait démarrer le parcours anonyme : un vert qui ne
      // prouverait rien. Le refus nomme l'alternative.
      throw new IosDriverError(
        'cookies and storage cannot be installed on iOS: return an "entry" deep link from the StateProvider instead',
        'unsupported',
      );
    }
    if (state.entry !== undefined) {
      await this.#navigate(state.entry);
      await this.#answerDialog();
    }
  }

  async #source(): Promise<string> {
    const xml = await this.#call('GET', '/source', undefined, 'get page source');
    if (typeof xml !== 'string') throw new Error('get page source failed: the response is not a string');
    return xml;
  }

  async #screen(): Promise<Screen> {
    return readScreen(await this.#source(), { mode: 'complete', bundleId: this.#bundleId });
  }

  async observe(options: ObserveOptions = {}): Promise<UISnapshot> {
    const screen = readScreen(await this.#source(), {
      mode: 'observe',
      interactiveOnly: options.interactiveOnly ?? false,
      bundleId: this.#bundleId,
    });
    const snapshot: UISnapshot = {
      platform: 'ios',
      at: new Date().toISOString(),
      location: screen.location,
      viewport: screen.viewport,
      root: screen.root,
    };
    if (options.screenshot === true) {
      const encoded = await this.#call('GET', '/screenshot', undefined, 'take screenshot');
      if (typeof encoded !== 'string') throw new Error('take screenshot failed: the response is not base64');
      snapshot.screenshot = new Uint8Array(Buffer.from(encoded, 'base64'));
    }
    return snapshot;
  }

  /**
   * La cascade primary → repli, définie une seule fois pour `resolve` et `act`.
   *
   * Mêmes règles que le pilote web : on compte les correspondances AVANT de
   * désambiguïser, sinon un locator devenu ambigu passerait pour valide en
   * pointant silencieusement le mauvais élément. L'appariement est celui du
   * moteur (`matchNodes`) : « le bouton Valider » veut dire la même chose ici
   * que dans les assertions.
   */
  #pick(screen: Screen, target: ResolvedTarget): Picked {
    const { nth, ...unindexed } = target.primary;
    if (unindexed.role === undefined && unindexed.name === undefined) {
      throw new Error('empty locator: neither role nor name');
    }
    const matched = matchNodes(screen.root, unindexed);

    if (matched.length > 1 && nth === undefined) return { node: null, usedFallback: false, matches: matched.length };
    if (matched.length >= 1) {
      const node = matched[nth ?? 0];
      return node === undefined
        ? { node: null, usedFallback: false, matches: 0 }
        : { node, usedFallback: false, matches: matched.length };
    }

    // `testId` et `selector` n'ont pas de sens ici : ils désignent le DOM.
    const id = target.fallback?.accessibilityId;
    if (id !== undefined) {
      // Premier dans l'ordre du document, comme `first()` côté web.
      const node = firstInOrder(screen.root, (one) => screen.elements.get(one.id)?.accessibilityId === id);
      if (node !== null) return { node, usedFallback: true, matches: 0 };
    }
    return { node: null, usedFallback: false, matches: 0 };
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    const picked = this.#pick(await this.#screen(), target);
    if (picked.node === null) {
      return picked.matches > 1
        ? { found: false, reason: 'ambiguous', matches: picked.matches }
        : { found: false, reason: 'no-match', matches: 0 };
    }
    if (!picked.node.state.visible) return { found: false, reason: 'not-visible', matches: picked.matches };
    return { found: true, node: picked.node, usedFallback: picked.usedFallback };
  }

  async #target(target: ResolvedTarget): Promise<{ screen: Screen; node: UINode }> {
    const screen = await this.#screen();
    const { node, matches } = this.#pick(screen, target);
    if (node === null) {
      throw new IosDriverError(
        matches > 1 ? `ambiguous target: ${matches} elements` : 'target not found, even via the fallback',
        'unresolved',
      );
    }
    if (!node.state.visible) throw new IosDriverError('target found but not visible', 'unresolved');
    return { screen, node };
  }

  /**
   * L'élément XCUITest qui correspond exactement au nœud résolu.
   *
   * Le chemin positionnel est évalué par XCUITest sur le document même dont le
   * nœud est issu : un homonyme ailleurs à l'écran ne peut pas être pris à sa
   * place. Si l'écran a changé entre-temps, le chemin ne désigne plus rien et
   * on le dit, plutôt que de taper au hasard.
   */
  async #elementFor(screen: Screen, node: UINode): Promise<string> {
    const info = screen.elements.get(node.id);
    if (info === undefined) throw new Error('internal: resolved node has no element path');
    const found = await this.#call('POST', '/elements', { using: 'xpath', value: info.xpath }, 'find elements');
    if (!Array.isArray(found) || found.length !== 1) {
      throw new IosDriverError('the screen changed between resolution and action', 'unresolved');
    }
    return elementIdOf(found[0], 'find elements');
  }

  /**
   * Un tap au centre de la cible, par `mobile: tap`.
   *
   * Préféré aux actions W3C : une seule commande documentée par XCUITest, sans
   * séquence pointeur à composer — et les coordonnées sont celles de l'arbre
   * que `resolve` vient de valider, sans recherche d'élément supplémentaire.
   * Sans `elementId`, x et y sont relatifs à l'application active : on les
   * ramène donc à son origine.
   */
  async #tap(screen: Screen, node: UINode): Promise<void> {
    const x = node.rect.x + node.rect.width / 2 - screen.viewport.x;
    const y = node.rect.y + node.rect.height / 2 - screen.viewport.y;
    await this.#mobile('tap', { x, y });
  }

  async #navigate(to: string): Promise<void> {
    const trimmed = to.trim();
    if (trimmed === '.' || trimmed === '/' || trimmed === '') {
      // « . » est la racine de l'application : sur iOS, la relancer.
      await this.#mobile('terminateApp', { bundleId: this.#bundleId });
      await this.#mobile('activateApp', { bundleId: this.#bundleId });
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      await this.#mobile('deepLink', { url: trimmed, bundleId: this.#bundleId });
      return;
    }
    throw new IosDriverError(
      `navigate on iOS takes an absolute deep link URL (myapp://…) or "." to relaunch the app, not "${trimmed}"`,
      'unsupported',
    );
  }

  async #press(key: string): Promise<void> {
    const typed = KEYS[key] ?? ([...key].length === 1 ? key : undefined);
    if (typed === undefined) {
      throw new IosDriverError(
        `press "${key}" is not supported on iOS (Enter, Return, Tab, Backspace, Delete, Space or a single character)`,
        'unsupported',
      );
    }
    const active = await this.#call('GET', '/element/active', undefined, 'get active element');
    await this.#call(
      'POST',
      `/element/${encodeURIComponent(elementIdOf(active, 'get active element'))}/value`,
      { text: typed },
      'element send keys',
    );
  }

  /**
   * Répond au dialogue présent, s'il y en a un. Rend vrai s'il a répondu.
   *
   * La présence se lit par `GET /alert/text` : « no such alert » est la
   * réponse documentée en l'absence de dialogue. Une politique armée est
   * consommée ; sans politique, le dialogue est refusé, comme sur le web.
   */
  async #answerDialog(): Promise<boolean> {
    try {
      await this.#call('GET', '/alert/text', undefined, 'get alert text');
    } catch (error) {
      if (error instanceof AppiumError && error.error === 'no such alert') return false;
      throw error;
    }
    const policy = this.#dialogs.shift();
    if (policy?.response === 'accept') {
      if (policy.promptText !== undefined) {
        await this.#call('POST', '/alert/text', { text: policy.promptText }, 'send alert text', [policy.promptText]);
      }
      await this.#call('POST', '/alert/accept', {}, 'accept alert');
    } else {
      await this.#call('POST', '/alert/dismiss', {}, 'dismiss alert');
    }
    return true;
  }

  /**
   * Défiler jusqu'à rendre la cible visible, dans une limite fixe.
   *
   * Une cible présente mais hors écran donne le sens ; une cible absente de
   * l'arbre — cellule pas encore rendue — fait descendre, puis remonter quand
   * la source cesse de changer (bord atteint). Au-delà de la limite, l'échec
   * est explicite : défiler indéfiniment masquerait une cible disparue.
   */
  async #scrollTo(target: ResolvedTarget): Promise<void> {
    let xml = await this.#source();
    let direction: 'down' | 'up' = 'down';
    let reversed = false;

    for (let attempt = 0; ; attempt += 1) {
      const screen = readScreen(xml, { mode: 'complete', bundleId: this.#bundleId });
      const { node, matches } = this.#pick(screen, target);
      if (node === null && matches > 1) {
        throw new IosDriverError(`ambiguous target: ${matches} elements`, 'unresolved');
      }
      if (node !== null && node.state.visible) return;
      if (node !== null) {
        direction = node.rect.y + node.rect.height <= screen.viewport.y ? 'up' : 'down';
      }
      if (attempt >= MAX_SCROLLS) break;

      await this.#mobile('scroll', { direction });
      const after = await this.#source();
      if (after === xml) {
        if (node !== null || reversed) break;
        reversed = true;
        direction = 'up';
      }
      xml = after;
    }
    throw new IosDriverError(`target still not visible after scrolling (${MAX_SCROLLS} attempts at most)`, 'unresolved');
  }

  async act(action: Action): Promise<void> {
    switch (action.kind) {
      case 'expectDialog':
        // Rien n'est exécuté : on arme, le geste suivant déclenchera.
        this.#dialogs.push({
          response: action.response,
          ...(action.promptText !== undefined ? { promptText: action.promptText } : {}),
        });
        return;
      case 'hover':
        throw new IosDriverError('hover does not exist on iOS: there is no pointer to rest over an element', 'unsupported');
      case 'upload':
        throw new IosDriverError(
          'upload is not supported on iOS: there is no file input, files come from the system picker',
          'unsupported',
        );
      case 'navigate':
        await this.#navigate(action.to);
        break;
      case 'press':
        await this.#press(action.key);
        break;
      case 'swipe':
        await this.#mobile('swipe', { direction: action.direction });
        break;
      case 'scrollTo':
        await this.#scrollTo(action.target);
        return;
      case 'click': {
        const { screen, node } = await this.#target(action.target);
        await this.#tap(screen, node);
        break;
      }
      case 'fill': {
        // Focus explicite, puis effacement, puis saisie : `clear` et la saisie
        // de XCUITest visent l'élément, mais un champ sans focus n'ouvre pas
        // son clavier sur toutes les versions.
        const { screen, node } = await this.#target(action.target);
        const element = encodeURIComponent(await this.#elementFor(screen, node));
        await this.#call('POST', `/element/${element}/click`, {}, 'element click');
        await this.#call('POST', `/element/${element}/clear`, {}, 'element clear');
        await this.#call('POST', `/element/${element}/value`, { text: action.value }, 'element send keys', [action.value]);
        break;
      }
      case 'select': {
        const { screen, node } = await this.#target(action.target);
        const info = screen.elements.get(node.id);
        if (info?.type !== 'XCUIElementTypePickerWheel') {
          throw new IosDriverError(`select needs a picker wheel on iOS, the target is a ${node.role}`, 'unsupported');
        }
        // Le libellé affiché est envoyé comme valeur : XCUITest le passe à
        // `adjustToPickerWheelValue`, qui fait tourner la roue dans le bon sens
        // jusqu'à ce libellé — la règle de docs/driver.md, viser ce qui se lit.
        const element = encodeURIComponent(await this.#elementFor(screen, node));
        await this.#call('POST', `/element/${element}/value`, { text: action.option }, 'element send keys');
        break;
      }
    }
    await this.#answerDialog();
  }

  /**
   * Repos = deux sources consécutives identiques, ou le délai écoulé.
   *
   * iOS n'expose ni requêtes en vol ni boucle de rendu : la seule preuve de
   * calme observable est un arbre qui ne bouge plus. Un dialogue apparu entre
   * deux lectures est traité ici aussi, sinon un dialogue un peu tardif
   * échapperait à la politique armée pour lui.
   */
  async settle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous: string | null = null;
    for (;;) {
      if (await this.#answerDialog()) previous = null;
      const current = await this.#source();
      if (current === previous) return;
      previous = current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(POLL_MS, remaining));
    }
  }

  takePendingDialogs(): number {
    const pending = this.#dialogs.length;
    this.#dialogs.length = 0;
    return pending;
  }

  /**
   * Idempotent, et ne lève jamais : `dispose` tourne dans un `finally`, et une
   * session déjà fermée par Appium (délai d'inactivité, serveur relancé) ne
   * doit pas masquer l'erreur qui a interrompu le parcours.
   */
  async dispose(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.#dialogs.length = 0;
    if (session === null) return;
    try {
      await this.#client.request('DELETE', `/session/${encodeURIComponent(session)}`, undefined, {
        command: 'delete session',
      });
    } catch {
      // Session déjà partie : rien à libérer.
    }
  }
}

function firstInOrder(root: UINode, accept: (node: UINode) => boolean): UINode | null {
  if (accept(root)) return root;
  for (const child of root.children) {
    const found = firstInOrder(child, accept);
    if (found !== null) return found;
  }
  return null;
}
