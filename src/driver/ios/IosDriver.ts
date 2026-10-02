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
import { capabilitiesProblem } from './capabilities.ts';
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

export type IosDriverErrorCode =
  | 'not-launched'
  | 'unsupported'
  | 'unresolved'
  | 'invalid-entry'
  | 'invalid-capabilities'
  | 'blocked-by-alert';

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
  /**
   * Capacités ajoutées à la session (`appium:noReset`, signature de
   * WebDriverAgent sur un appareil réel…). Celles que QAI pose lui-même sont
   * refusées : voir `capabilities.ts`.
   */
  capabilities?: Record<string, unknown>;
  /** Délai par commande, hors création de session. Défaut : 60 s. */
  commandTimeoutMs?: number;
}

export const DEFAULT_APPIUM_URL = 'http://127.0.0.1:4723';

/** Démarrer un simulateur et installer WebDriverAgent prend des minutes. */
const SESSION_TIMEOUT_MS = 10 * 60_000;

/** Intervalle de sondage de `settle`. Une source XCUITest coûte déjà ~0,5 s. */
const POLL_MS = 250;

/**
 * Le tableau de bord d'iOS. Au premier plan après une installation, il veut
 * dire que l'application n'a pas démarré : relancer « l'application » ou y
 * ouvrir un lien profond viserait le système.
 */
const SPRINGBOARD = 'com.apple.springboard';

/**
 * Touches que `press` sait produire, en caractères tapés.
 *
 * XCUITest n'a pas d'API de touche nommée hors clavier matériel : la touche
 * passe par la saisie de texte sur l'élément actif, où « \n » est Retour.
 *
 * L'effacement est la paire U+0008 U+007F, pas « \b » seul : c'est la
 * séquence que WebDriverAgent tape lui-même pour vider un champ
 * (`backspaceDeleteSequence`, XCUIElement+FBTyping.m). Reprendre la sienne
 * plutôt qu'en deviner une autre : c'est la seule éprouvée sur appareil.
 */
const KEYS: Readonly<Record<string, string>> = {
  Enter: '\n',
  Return: '\n',
  Tab: '\t',
  Backspace: '\u0008\u007F',
  Delete: '\u0008\u007F',
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

/** Un texte d'alerte dans un message d'erreur : une ligne, bornée. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** Le serveur tourne-t-il sur cette machine ? Un chemin local n'a de sens que là. */
function isLoopback(serverUrl: string): boolean {
  try {
    const host = new URL(serverUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Un lien profond : un schéma suivi d'autre chose qu'un port.
 *
 * « localhost:3000/x » a la forme d'un schéma pour une URL, mais c'est une
 * adresse web recopiée sans « http:// » : l'envoyer comme lien profond
 * produirait une erreur de serveur illisible au lieu d'un refus clair.
 */
function isDeepLink(to: string): boolean {
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(to);
}

function flatten(node: UINode): UINode[] {
  return [node, ...node.children.flatMap(flatten)];
}

export class IosDriver implements Driver {
  readonly platform: Platform = 'ios';
  /**
   * `hover` n'existe pas sous le doigt : le refus est déclaré ici pour que le
   * moteur l'oppose à la planification, pas au milieu d'un parcours.
   *
   * `dialogs` vaut non, et ce n'est pas un manque. Une alerte d'application
   * iOS fait partie de l'écran : elle est observée (rôle `dialog`), assertable,
   * et on y répond en cliquant son bouton par son libellé — exactement comme
   * à une modale web. Répondre « accepter » ou « refuser » à l'aveugle passe
   * par l'heuristique de WebDriverAgent, qui choisit un bouton par sa
   * POSITION : sur une alerte à trois boutons, « accepter » touche Annuler ;
   * sur [Supprimer, Garder], « refuser » touche Supprimer. Le style d'un
   * bouton n'étant pas exposé à l'accessibilité, aucun choix sûr n'est
   * possible : mieux vaut refuser `expectDialog` à la planification.
   *
   * `navigateByUrl` vaut oui parce que `navigate` est servi — par lien profond
   * ou relance — mais seulement pour une URL absolue, « . » ou « / ».
   */
  readonly capabilities: Capabilities = {
    hover: false,
    swipe: true,
    navigateByUrl: true,
    deepLink: true,
    dialogs: false,
  };

  readonly #client: AppiumClient;
  readonly #device: string | undefined;
  readonly #platformVersion: string | undefined;
  readonly #extra: Readonly<Record<string, unknown>>;
  #session: string | null = null;
  #bundleId = '';

  constructor(options: IosDriverOptions = {}) {
    this.#client = new AppiumClient(options.serverUrl ?? DEFAULT_APPIUM_URL, options.commandTimeoutMs ?? 60_000);
    this.#device = options.device;
    this.#platformVersion = options.platformVersion;
    // Refusé à la construction, avant toute session : une capacité qui
    // contredit --app ou --device ne doit rien lancer sur l'appareil.
    const problem = options.capabilities === undefined ? undefined : capabilitiesProblem(options.capabilities);
    if (problem !== undefined) throw new IosDriverError(`capabilities: ${problem}`, 'invalid-capabilities');
    this.#extra = { ...options.capabilities };
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

    // Les capacités ajoutées d'abord : celles de QAI ne peuvent pas être
    // remplacées, et le constructeur a déjà refusé toute collision.
    const capabilities: Record<string, unknown> = {
      ...this.#extra,
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
    };
    if (path) {
      // `appium:app` est lu par le SERVEUR, sur sa machine. Un chemin relatif
      // ne peut donc se compléter ici que si le serveur est ici ; sinon il
      // désignerait un fichier de cette machine-ci, inexistant là-bas. Une URL
      // distante est transmise telle quelle : Appium sait la télécharger.
      const remote = /^https?:\/\//i.test(entry);
      if (!remote && !isAbsolute(entry) && !isLoopback(this.#client.serverUrl)) {
        throw new IosDriverError(
          `"${entry}" is a relative path, but the Appium server ${this.#client.serverUrl} is not on this machine: ` +
            'pass an absolute path on the server host, or a URL',
          'invalid-entry',
        );
      }
      capabilities['appium:app'] = remote || isAbsolute(entry) ? entry : resolvePath(entry);
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
    if (bundleId === SPRINGBOARD) {
      throw new IosDriverError(
        `the app installed from "${entry}" is not in the foreground (SpringBoard is): pass its bundle id with --app instead`,
        'invalid-entry',
      );
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
      const open = this.#navigation(state.entry);
      await open();
      await this.#refuseForeignAlert();
    }
  }

  async #source(): Promise<string> {
    const xml = await this.#call('GET', '/source', undefined, 'get page source');
    if (typeof xml !== 'string') throw new Error('get page source failed: the response is not a string');
    return xml;
  }

  /**
   * Une lecture, deux projections du même document.
   *
   * `observed` est l'arbre que voient le modèle et les assertions : c'est sur
   * lui qu'on compte les correspondances, sans quoi `nth: 1` désignerait ici
   * un autre élément que celui montré là. `complete` garde les nœuds non
   * rendus, pour distinguer « absent » de « non rendu ». Les identifiants sont
   * attribués avant tout élagage : un même élément porte le même dans les deux.
   */
  async #read(): Promise<{ observed: Screen; complete: Screen }> {
    const xml = await this.#source();
    return {
      observed: readScreen(xml, { mode: 'observe', bundleId: this.#bundleId }),
      complete: readScreen(xml, { mode: 'complete', bundleId: this.#bundleId }),
    };
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
   *
   * Ordre : primary rendu, repli rendu, puis seulement un nœud non rendu —
   * comme `getByRole` côté web, qui ignore les éléments masqués avant de
   * passer au repli.
   */
  #pick(observed: Screen, complete: Screen, target: ResolvedTarget): Picked {
    const { nth, ...unindexed } = target.primary;
    if (unindexed.role === undefined && unindexed.name === undefined) {
      throw new Error('empty locator: neither role nor name');
    }

    const matched = matchNodes(observed.root, unindexed);
    if (matched.length > 1 && nth === undefined) return { node: null, usedFallback: false, matches: matched.length };
    if (matched.length >= 1) {
      const node = matched[nth ?? 0];
      return node === undefined
        ? { node: null, usedFallback: false, matches: 0 }
        : { node, usedFallback: false, matches: matched.length };
    }

    /**
     * Le repli désigne l'identifiant d'accessibilité — `testId` dans l'arbre.
     *
     * `fallback.testId` est accepté au même titre qu'`accessibilityId` : c'est
     * ce que le modèle et le réparateur écrivent en lisant « #id », et sur iOS
     * l'identifiant d'accessibilité EST l'identifiant de test. Seul le vrai
     * identifiant compte, jamais un libellé recopié dans `name` par
     * WebDriverAgent ; et il est compté, comme le primary : un identifiant de
     * cellule réutilisé sur chaque ligne est ambigu, pas « la première ».
     */
    const id = target.fallback?.accessibilityId ?? target.fallback?.testId;
    const carriers = id === undefined ? [] : flatten(observed.root).filter((node) => node.testId === id);
    if (carriers.length > 1) return { node: null, usedFallback: false, matches: carriers.length };
    const carrier = carriers[0];
    if (carrier !== undefined) return { node: carrier, usedFallback: true, matches: 0 };

    // Rien de rendu : un nœud présent mais sans boîte dit « non visible ».
    const hidden = matchNodes(complete.root, unindexed);
    const unrendered = hidden[nth ?? 0];
    if (unrendered !== undefined) return { node: unrendered, usedFallback: false, matches: hidden.length };
    if (id !== undefined) {
      const ghost = flatten(complete.root).find((node) => node.testId === id);
      if (ghost !== undefined) return { node: ghost, usedFallback: true, matches: 0 };
    }
    return { node: null, usedFallback: false, matches: 0 };
  }

  async resolve(target: ResolvedTarget): Promise<ResolveOutcome> {
    const { observed, complete } = await this.#read();
    const picked = this.#pick(observed, complete, target);
    if (picked.node === null) {
      return picked.matches > 1
        ? { found: false, reason: 'ambiguous', matches: picked.matches }
        : { found: false, reason: 'no-match', matches: 0 };
    }
    if (!picked.node.state.visible) return { found: false, reason: 'not-visible', matches: picked.matches };
    return { found: true, node: picked.node, usedFallback: picked.usedFallback };
  }

  /**
   * La cible d'un geste, avec l'écran dont elle est issue.
   *
   * Une alerte ou une feuille d'actions de l'application ouverte bloque tout
   * ce qui est dessous : un toucher hors d'elle la ferait disparaître (une
   * feuille se referme ainsi) ou n'atteindrait rien. Le refus nomme l'alerte,
   * pour que le rapport dise ce qui était à l'écran.
   */
  async #target(target: ResolvedTarget): Promise<{ screen: Screen; node: UINode }> {
    const { observed, complete } = await this.#read();
    const { node, matches } = this.#pick(observed, complete, target);
    if (node === null) {
      throw new IosDriverError(
        matches > 1 ? `ambiguous target: ${matches} elements` : 'target not found, even via the fallback',
        'unresolved',
      );
    }
    if (!node.state.visible) throw new IosDriverError('target found but not visible', 'unresolved');

    const modal = observed.elements.get(node.id)?.modal;
    const open = observed.modals;
    if (open.length > 0 && !open.some((one) => one.id === modal)) {
      const shown = open[open.length - 1]?.name ?? '';
      throw new IosDriverError(
        `an alert is open ("${excerpt(shown)}"): answer it first by clicking one of its buttons`,
        'blocked-by-alert',
      );
    }
    return { screen: observed, node };
  }

  /**
   * L'élément XCUITest qui correspond exactement au nœud résolu.
   *
   * WebDriverAgent évalue le chemin sur un instantané neuf : le chemin porte
   * donc le rang ET l'identité (`name` ou `label`) de l'élément. Si l'écran a
   * changé entre-temps, il ne désigne plus rien et on le dit, plutôt que
   * d'agir sur le voisin venu prendre la place.
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
   * Un toucher sur l'élément, par Element Click (W3C).
   *
   * Pas de tap par coordonnées : un point de l'écran ne sait pas ce qui le
   * recouvre. Le clavier virtuel, retiré de l'arbre, cache souvent le bas de
   * l'écran ; un tap à l'aveugle y taperait une lettre dans le champ actif et
   * le geste passerait pour réussi. Le clic d'élément passe par XCTest, qui
   * calcule un point réellement atteignable, défile jusqu'à l'élément s'il est
   * sous le pli, et échoue s'il n'y parvient pas.
   */
  async #click(screen: Screen, node: UINode): Promise<void> {
    const element = encodeURIComponent(await this.#elementFor(screen, node));
    await this.#call('POST', `/element/${element}/click`, {}, 'element click');
  }

  /**
   * Prépare la navigation et la refuse tout de suite si elle est invalide.
   *
   * « . » et « / » désignent la racine de l'application : on la relance.
   * `mobile: launchApp` plutôt qu'`activateApp` : la documentation dit
   * qu'`activateApp` échoue sur une application arrêtée, et WebDriverAgent ne
   * réarme sa détection de plantage qu'au lancement.
   */
  #navigation(to: string): () => Promise<void> {
    const trimmed = to.trim();
    if (trimmed === '.' || trimmed === '/') {
      return async () => {
        await this.#mobile('terminateApp', { bundleId: this.#bundleId });
        await this.#mobile('launchApp', { bundleId: this.#bundleId });
      };
    }
    if (isDeepLink(trimmed)) {
      return async () => {
        await this.#mobile('deepLink', { url: trimmed, bundleId: this.#bundleId });
      };
    }
    throw new IosDriverError(
      `navigate on iOS takes an absolute deep link URL (myapp://…), or "." or "/" to relaunch the app, not "${trimmed}"`,
      'unsupported',
    );
  }

  async #press(typed: string): Promise<void> {
    const active = await this.#call('GET', '/element/active', undefined, 'get active element');
    await this.#call(
      'POST',
      `/element/${encodeURIComponent(elementIdOf(active, 'get active element'))}/value`,
      { text: typed },
      'element send keys',
    );
  }

  /**
   * Refuse de continuer sous une alerte qui n'appartient pas à l'application.
   *
   * `GET /alert/text` voit aussi les alertes du système (autorisations,
   * SpringBoard), absentes de la source de l'application : elles ne sont ni
   * observables ni cliquables par un scénario. Y répondre par
   * `/alert/accept` ou `/alert/dismiss` serait choisir un bouton par sa
   * position — « Autoriser une fois » pour un refus, sur l'invite de
   * localisation. Le geste échoue donc en nommant l'alerte. Une alerte de
   * l'application, elle, est dans la source : on la laisse à l'écran, où
   * elle s'observe et se clique comme le reste.
   */
  async #refuseForeignAlert(): Promise<void> {
    let text: unknown;
    try {
      text = await this.#call('GET', '/alert/text', undefined, 'get alert text');
    } catch (error) {
      if (error instanceof AppiumError && error.error === 'no such alert') return;
      throw error;
    }
    const screen = readScreen(await this.#source(), { mode: 'complete', bundleId: this.#bundleId });
    if (screen.modals.length > 0) return;
    throw new IosDriverError(
      `an alert outside the app is open ("${excerpt(typeof text === 'string' ? text : '')}"): ` +
        'QAI never answers system alerts, grant the permission before the run',
      'blocked-by-alert',
    );
  }

  /**
   * Amène la cible à l'écran par `mobile: scrollToElement`.
   *
   * La cible est déjà dans l'arbre — c'est ce que `resolve` vient d'établir :
   * XCUITest sait la rejoindre directement, sans deviner un sens ni une
   * distance de défilement. Déjà à l'écran, rien n'est fait. Après coup, on
   * relit l'écran pour le vérifier : un défilement qui n'a rien montré est un
   * échec explicite, pas un succès supposé.
   */
  async #scrollTo(target: ResolvedTarget): Promise<void> {
    const { screen, node } = await this.#target(target);
    if (screen.elements.get(node.id)?.onScreen === true) return;
    await this.#mobile('scrollToElement', { elementId: await this.#elementFor(screen, node) });

    const after = await this.#read();
    const seen = this.#pick(after.observed, after.complete, target).node;
    if (seen === null || after.observed.elements.get(seen.id)?.onScreen !== true) {
      throw new IosDriverError('target still off screen after scrolling to it', 'unresolved');
    }
  }

  /**
   * Valide le geste, puis rend son exécution.
   *
   * Tout refus qui ne dépend que de l'action tombe ici, avant la moindre
   * requête : un geste impossible ne doit rien toucher sur l'appareil.
   */
  #plan(action: Action): () => Promise<void> {
    switch (action.kind) {
      case 'expectDialog':
        throw new IosDriverError(
          'expectDialog is not supported on iOS: an app alert is part of the screen, click its button by its label',
          'unsupported',
        );
      case 'hover':
        throw new IosDriverError('hover does not exist on iOS: there is no pointer to rest over an element', 'unsupported');
      case 'upload':
        throw new IosDriverError(
          'upload is not supported on iOS: there is no file input, files come from the system picker',
          'unsupported',
        );
      case 'navigate':
        return this.#navigation(action.to);
      case 'press': {
        const typed = KEYS[action.key] ?? ([...action.key].length === 1 ? action.key : undefined);
        if (typed === undefined) {
          throw new IosDriverError(
            `press "${action.key}" is not supported on iOS (Enter, Return, Tab, Backspace, Delete, Space or a single character)`,
            'unsupported',
          );
        }
        return () => this.#press(typed);
      }
      case 'swipe':
        return async () => {
          await this.#mobile('swipe', { direction: action.direction });
        };
      case 'scrollTo':
        return () => this.#scrollTo(action.target);
      case 'click':
        return async () => {
          const { screen, node } = await this.#target(action.target);
          await this.#click(screen, node);
        };
      case 'fill':
        // Focus explicite, puis effacement, puis saisie : `clear` et la saisie
        // de XCUITest visent l'élément, mais un champ sans focus n'ouvre pas
        // son clavier sur toutes les versions.
        return async () => {
          const { screen, node } = await this.#target(action.target);
          const element = encodeURIComponent(await this.#elementFor(screen, node));
          await this.#call('POST', `/element/${element}/click`, {}, 'element click');
          await this.#call('POST', `/element/${element}/clear`, {}, 'element clear');
          await this.#call('POST', `/element/${element}/value`, { text: action.value }, 'element send keys', [
            action.value,
          ]);
        };
      case 'select':
        return async () => {
          const { screen, node } = await this.#target(action.target);
          const info = screen.elements.get(node.id);
          if (info?.type !== 'XCUIElementTypePickerWheel') {
            throw new IosDriverError(`select needs a picker wheel on iOS, the target is a ${node.role}`, 'unsupported');
          }
          // Le libellé affiché est envoyé comme valeur : XCUITest le passe à
          // `adjustToPickerWheelValue`, qui fait tourner la roue dans le bon
          // sens jusqu'à ce libellé — la règle de docs/driver.md, viser ce qui
          // se lit.
          const element = encodeURIComponent(await this.#elementFor(screen, node));
          await this.#call('POST', `/element/${element}/value`, { text: action.option }, 'element send keys');
        };
    }
  }

  /**
   * Un geste encadré par deux contrôles d'alerte système.
   *
   * Avant : une alerte apparue pendant le repos ou les assertions recevrait le
   * toucher destiné à l'application. Après : le geste qui l'a fait naître est
   * celui qui doit échouer, le rapport pointant la bonne étape.
   */
  async act(action: Action): Promise<void> {
    const gesture = this.#plan(action);
    await this.#refuseForeignAlert();
    await gesture();
    await this.#refuseForeignAlert();
  }

  /**
   * L'empreinte d'un écran : l'arbre projeté, pas la source brute.
   *
   * La source porte la barre d'état — l'heure — et des attributs que la
   * projection ignore : les comparer bruts ferait courir chaque `settle`
   * jusqu'au bout de son délai sur un écran pourtant immobile.
   */
  async #fingerprint(): Promise<string> {
    const screen = readScreen(await this.#source(), { mode: 'complete', bundleId: this.#bundleId });
    return `${screen.location}\n${JSON.stringify(screen.root)}`;
  }

  /**
   * Repos = deux lectures consécutives de l'arbre identiques, ou le délai écoulé.
   *
   * iOS n'expose ni requêtes en vol ni boucle de rendu : la seule preuve de
   * calme observable est un arbre qui ne bouge plus.
   */
  async settle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous: string | null = null;
    for (;;) {
      const current = await this.#fingerprint();
      if (current === previous) return;
      previous = current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(POLL_MS, remaining));
    }
  }

  /**
   * Idempotent, et ne lève jamais : `dispose` tourne dans un `finally`, et une
   * session déjà fermée par Appium (délai d'inactivité, serveur relancé) ne
   * doit pas masquer l'erreur qui a interrompu le parcours.
   */
  async dispose(): Promise<void> {
    const session = this.#session;
    this.#session = null;
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
