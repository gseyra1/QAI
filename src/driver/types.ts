/**
 * Le contrat que toute plateforme doit satisfaire.
 *
 * Rien ici n'est spécifique au web : c'est le vocabulaire commun dans lequel
 * l'arbre DOM, l'arbre d'accessibilité iOS et celui d'Android doivent tous se
 * projeter. Si un concept ne peut pas s'exprimer sur les trois, il n'a pas sa
 * place dans ce fichier — il appartient à l'implémentation.
 */

export type Platform = 'web' | 'ios' | 'android';

/**
 * Le sous-ensemble de rôles qui existe réellement sur les trois plateformes.
 * Correspondances documentées dans docs/driver.md.
 *
 * `link` est délibérément conservé bien qu'il n'ait pas d'équivalent natif sur
 * mobile : un même scénario produit une résolution `link` sur le web et
 * `button` sur iOS. La portabilité vit dans le scénario, pas dans le locator.
 */
export type Role =
  | 'button'
  | 'link'
  | 'text'
  | 'heading'
  | 'image'
  | 'textbox'
  | 'searchbox'
  | 'combobox'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'slider'
  | 'list'
  | 'listitem'
  | 'table'
  | 'row'
  | 'cell'
  | 'tab'
  | 'tablist'
  | 'dialog'
  | 'menu'
  | 'menuitem'
  | 'progressbar'
  | 'alert'
  | 'group'
  | 'unknown';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeState {
  visible: boolean;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  focused?: boolean;
}

/**
 * Un élément d'interface, normalisé.
 *
 * `rect` n'est pas optionnel : l'étage de réparation et le futur repli vision
 * en dépendent, et c'est aussi ce qui permet de détecter les défauts de mise en
 * page (chevauchement, texte tronqué) qu'aucun sélecteur ne révèle.
 */
export interface UINode {
  /** Stable à l'intérieur d'un instantané uniquement. Jamais persisté. */
  id: string;
  role: Role;
  /** Nom accessible, calculé selon les règles de la plateforme. */
  name: string;
  value?: string;
  state: NodeState;
  rect: Rect;
  children: UINode[];
}

export interface UISnapshot {
  platform: Platform;
  at: string;
  /** URL sur le web, identifiant d'écran ou d'activité sur mobile. */
  location: string;
  viewport: Rect;
  root: UINode;
  /** Coûteux : n'est capturé que sur demande explicite. */
  screenshot?: Uint8Array;
}

/**
 * La grammaire de ciblage partagée.
 *
 * Un `Locator` décrit sémantiquement quoi atteindre. Il est produit par la
 * machine et vit dans le fichier de résolution — jamais dans un scénario.
 */
export interface Locator {
  role?: Role;
  name?: string | { contains: string };
  /** Index parmi les correspondances, quand plusieurs sont légitimes. */
  nth?: number;
  within?: Locator;
}

/**
 * Repli spécifique à la plateforme, toléré dans la résolution parce que ce
 * fichier est déjà propre à une plateforme et régénérable. Le repli n'est
 * essayé que si `primary` échoue, et un repli qui sert devient un signal :
 * l'accessibilité de l'application testée s'est dégradée.
 */
export interface PlatformFallback {
  testId?: string;
  selector?: string;
  accessibilityId?: string;
}

export interface ResolvedTarget {
  primary: Locator;
  fallback?: PlatformFallback;
}

export type Action =
  | { kind: 'navigate'; to: string }
  | { kind: 'click'; target: ResolvedTarget }
  | { kind: 'fill'; target: ResolvedTarget; value: string }
  | { kind: 'select'; target: ResolvedTarget; option: string }
  | { kind: 'press'; key: string }
  | { kind: 'scrollTo'; target: ResolvedTarget }
  | { kind: 'hover'; target: ResolvedTarget }
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' }
  /**
   * Dépose des fichiers dans un champ de téléversement.
   *
   * Les chemins sont relatifs au **fichier scénario** et résolus par le moteur,
   * pas par le driver : un chemin absolu dans une résolution versionnée ne
   * fonctionnerait que sur la machine qui l'a écrite.
   */
  | { kind: 'upload'; target: ResolvedTarget; files: string[] }
  /**
   * Arme la réponse au **prochain** dialogue natif, pour une seule fois.
   *
   * Se place juste avant le geste qui le déclenche, jamais après : le dialogue
   * bloque la page dès le clic, il n'y a donc aucun moment ultérieur où
   * répondre. Sans cette action, tout parcours « supprimer puis confirmer »
   * casse en silence — un pilote sans politique déclarée refuse le dialogue,
   * et la suppression n'a jamais lieu.
   *
   * `promptText` ne vaut que pour un prompt() ; il est ignoré ailleurs.
   */
  | { kind: 'expectDialog'; response: 'accept' | 'dismiss'; promptText?: string };

/**
 * Ce que la plateforme sait faire. Le moteur consulte ces drapeaux avant de
 * dispatcher : une étape `hover` sur mobile doit produire une erreur explicite
 * au moment de la planification, pas une exception au milieu d'un parcours.
 */
export interface Capabilities {
  hover: boolean;
  swipe: boolean;
  navigateByUrl: boolean;
  deepLink: boolean;
  /** Dialogues natifs : alert, confirm, prompt — et leurs équivalents mobiles. */
  dialogs: boolean;
  /** Observation passive du réseau et de la console. */
  network: boolean;
}

/**
 * Une requête sortante observée pendant une étape.
 *
 * `status: null` distingue l'échec réseau — DNS, CORS, connexion refusée — du
 * code d'erreur applicatif. Les deux cassent une interface, mais pas pour les
 * mêmes raisons, et le rapport doit permettre de les séparer.
 */
export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  at: string;
}

export interface ConsoleEntry {
  level: 'error' | 'warning';
  text: string;
  at: string;
}

/**
 * Ce qui s'est passé hors de l'arbre pendant une étape.
 *
 * Une assertion prouve ce que l'écran affiche ; ces observations disent ce que
 * l'application a fait pour l'afficher. Un écran vide parce qu'un appel a rendu
 * 500 et un écran vide parce qu'il n'y a rien à montrer se ressemblent
 * exactement — c'est la seule information qui les sépare.
 */
export interface Observations {
  network: NetworkEntry[];
  console: ConsoleEntry[];
}

export type ResolveOutcome =
  | { found: true; node: UINode; usedFallback: boolean }
  | { found: false; reason: 'no-match' | 'ambiguous' | 'not-visible'; matches: number };

export interface ObserveOptions {
  /** Inclure une capture d'écran. Coûteux, réservé au diagnostic et à l'étage 2. */
  screenshot?: boolean;
  /** Élaguer les nœuds sans nom accessible ni rôle interactif. */
  interactiveOnly?: boolean;
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /**
   * Sans ces deux attributs, aucune session inter-site n'est installable.
   *
   * Un cookie posé sans `sameSite` retombe cote navigateur sur « Lax », qui
   * refuse de l'envoyer sur les requetes vers une autre origine que la page.
   * Un front servi sur localhost dont l'API vit sur un domaine distinct — le
   * cas de tout developpement contre un backend deploye — verrait donc sa
   * session ignoree, et chaque parcours demarrerait anonyme sans que rien ne
   * le signale : le symptome est un echec d'assertion six etapes plus loin.
   *
   * `secure` suit la meme logique : un cookie « SameSite=None » n'est accepte
   * par le navigateur que s'il est aussi « Secure ».
   *
   * Sur mobile, l'equivalent est porte par le stockage de la webview.
   */
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * État à installer avant qu'un scénario ne commence : session déjà ouverte,
 * bannière de consentement déjà acceptée, préférence déjà posée.
 *
 * Sur le web, cookies et stockage local. Sur mobile, l'équivalent sera le
 * stockage de la webview ou les préférences de l'application ; `entry` s'y
 * traduit en lien profond. C'est pour cette raison que le contrat ne parle pas
 * de « cookies » à son plus haut niveau mais d'état préparé.
 */
export interface PreparedState {
  cookies?: Cookie[];
  storage?: Record<string, string>;
  /** Point d'entrée imposé par cet état, sinon la racine de l'application. */
  entry?: string;
}

export interface LaunchTarget {
  /** URL de base sur le web, chemin de bundle ou identifiant d'app sur mobile. */
  entry: string;
  viewport?: { width: number; height: number };
}

/**
 * Trois responsabilités, pas quatre.
 *
 * L'évaluation des assertions est délibérément absente : elle appartient au
 * moteur, qui l'applique sur un `UISnapshot`. Si chaque driver implémentait ses
 * propres assertions, le web et le mobile finiraient par diverger sur ce que
 * signifie « le total est égal à 42 » — et la promesse de portabilité tomberait.
 */
export interface Driver {
  readonly platform: Platform;
  readonly capabilities: Capabilities;

  launch(target: LaunchTarget): Promise<void>;

  /**
   * Installe l'état de départ. Appelé après `launch`, avant la première étape.
   *
   * Sans lui, aucun parcours nécessitant une session ouverte n'est exprimable —
   * c'est-à-dire la quasi-totalité des parcours critiques réels.
   */
  applyState(state: PreparedState): Promise<void>;

  observe(options?: ObserveOptions): Promise<UISnapshot>;
  resolve(target: ResolvedTarget): Promise<ResolveOutcome>;
  act(action: Action): Promise<void>;

  /**
   * Attendre le repos avant d'observer ou de conclure à un échec.
   *
   * C'est le garde-fou anti-instabilité placé devant l'étage de réparation :
   * sans lui, chaque élément pas encore rendu déclencherait un appel de modèle
   * et polluerait l'historique de réparations.
   */
  settle(timeoutMs?: number): Promise<void>;

  /**
   * Rend et efface les politiques de dialogue armées mais jamais consommées.
   *
   * Une politique qui survit à son étape répondrait à un dialogue qu'aucun
   * scénario n'a prévu, trois étapes plus loin. La rendre au moteur permet
   * d'avertir : « expectDialog armé, aucun dialogue n'est apparu » signale le
   * plus souvent que le bouton de confirmation a disparu de l'application.
   */
  takePendingDialogs?(): number;

  /**
   * Rend et vide ce qui a été observé depuis le dernier appel.
   *
   * Optionnelle, et doublée d'une capability : un driver mobile peut ne pas
   * savoir écouter le réseau, et le moteur doit continuer de fonctionner sans.
   * Vider à la lecture est ce qui découpe l'observation par étape sans que le
   * driver ait à connaître la notion d'étape.
   */
  drainObservations?(): Observations;

  dispose(): Promise<void>;
}
