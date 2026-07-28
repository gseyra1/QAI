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
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' };

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

  dispose(): Promise<void>;
}
