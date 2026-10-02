import type { Rect, Role, UINode } from '../types.ts';
import type { XmlElement } from './xml.ts';
import { parseXml } from './xml.ts';

/**
 * Projection de la source de page XCUITest vers l'arbre normalisé.
 *
 * Le format est celui de WebDriverAgent : un élément par nœud, nommé d'après
 * son type (`XCUIElementTypeButton`), portant `type`, `value`, `name`,
 * `label`, `enabled`, `visible`, `accessible`, `x`, `y`, `width`, `height`,
 * `index`, et selon les versions `placeholderValue` et `traits`. Aucun texte
 * hors des attributs.
 *
 * Pure et sans réseau : c'est ce qui la rend testable sur des échantillons de
 * source réels, sans simulateur.
 */

/** Ce que le pilote garde d'un élément pour pouvoir agir dessus ensuite. */
export interface ElementInfo {
  /** Type XCUITest complet, `XCUIElementTypePickerWheel` par exemple. */
  type: string;
  /**
   * Chemin positionnel dans la source, complété par l'identité de l'élément.
   *
   * WebDriverAgent évalue le chemin sur un NOUVEL instantané, pas sur celui que
   * la source a sérialisé : un rang seul désignerait n'importe quel voisin
   * venu prendre la place après un rechargement de liste. Le prédicat sur
   * `name` (ou `label`) fait qu'un écran changé ne désigne plus rien, au lieu
   * de désigner autre chose.
   */
  xpath: string;
  /**
   * À l'écran au sens de XCUITest (attribut `visible`), ce que `state.visible`
   * ne dit PAS : celui-ci suit le web — rendu, même sous le pli. Seul
   * `scrollTo` a besoin de la différence.
   */
  onScreen: boolean;
  /** L'identifiant du dialogue (`Alert` ou `Sheet`) qui contient l'élément. */
  modal?: string;
}

/** Un dialogue de l'application affiché : alerte ou feuille d'actions. */
export interface Modal {
  id: string;
  name: string;
}

export interface Screen {
  root: UINode;
  elements: Map<string, ElementInfo>;
  /** Les dialogues de l'application à l'écran, dans l'ordre du document. */
  modals: Modal[];
  bundleId?: string;
  location: string;
  viewport: Rect;
}

export interface ReadOptions {
  /**
   * `complete` garde tout — non rendus compris — pour que `resolve` sache
   * distinguer « absent » de « non rendu ». `observe` suit les règles du
   * pilote web : feuilles non rendues retirées, élagage sur demande.
   */
  mode: 'complete' | 'observe';
  interactiveOnly?: boolean;
  /** Bundle connu du pilote, quand la source n'en porte pas. */
  bundleId?: string;
}

const PREFIX = 'XCUIElementType';

/**
 * Table des rôles, alignée sur docs/driver.md.
 *
 * `Button` dans une `TabBar` devient `tab`, et `StaticText` portant le trait
 * `Header` devient `heading` : ces deux cas dépendent du contexte et sont
 * traités à part. Tout type absent tombe sur `group`, comme un conteneur web
 * générique.
 */
const ROLES: Readonly<Record<string, Role>> = {
  Button: 'button',
  Link: 'link',
  StaticText: 'text',
  Image: 'image',
  Icon: 'image',
  TextField: 'textbox',
  SecureTextField: 'textbox',
  TextView: 'textbox',
  SearchField: 'searchbox',
  PickerWheel: 'combobox',
  ComboBox: 'combobox',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  Switch: 'switch',
  Toggle: 'switch',
  Slider: 'slider',
  Table: 'list',
  CollectionView: 'list',
  Cell: 'listitem',
  TabBar: 'tablist',
  Alert: 'dialog',
  Sheet: 'dialog',
  Menu: 'menu',
  MenuItem: 'menuitem',
  ProgressIndicator: 'progressbar',
  ActivityIndicator: 'progressbar',
};

/**
 * Sous-arbres jamais observés.
 *
 * Le clavier virtuel ajoute une trentaine de boutons à chaque saisie : du
 * bruit pour le modèle, et des cibles qu'un scénario ne doit pas viser — une
 * touche se presse par `press`. Ce retrait est sans danger pour les gestes :
 * ils passent par l'élément, et XCTest refuse de toucher un élément que le
 * clavier recouvre. La barre d'état porte l'heure : elle change chaque
 * minute, et `settle` — qui compare l'arbre projeté — ne trouverait jamais
 * deux lectures identiques.
 */
const SKIPPED: ReadonlySet<string> = new Set(['Keyboard', 'StatusBar']);

/** Même ensemble que le pilote web : ce qu'un geste peut viser. */
const INTERACTIVE: ReadonlySet<Role> = new Set<Role>([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'tab',
  'menuitem',
]);

/** Rôles dont la valeur est une donnée saisie ou réglée, comme sur le web. */
const VALUED: ReadonlySet<Role> = new Set<Role>(['textbox', 'searchbox', 'combobox', 'slider', 'progressbar']);

function shortType(element: XmlElement): string {
  const type = element.attributes['type'] ?? element.tag;
  return type.startsWith(PREFIX) ? type.slice(PREFIX.length) : type;
}

function traitsOf(element: XmlElement): Set<string> {
  const raw = element.attributes['traits'];
  if (raw === undefined || raw === '') return new Set();
  return new Set(raw.split(',').map((trait) => trait.trim()));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function numberAttr(element: XmlElement, name: string): number {
  const value = Number(element.attributes[name]);
  return Number.isFinite(value) ? value : 0;
}

function rectOf(element: XmlElement): Rect {
  return {
    x: numberAttr(element, 'x'),
    y: numberAttr(element, 'y'),
    width: numberAttr(element, 'width'),
    height: numberAttr(element, 'height'),
  };
}

function roleOf(type: string, traits: Set<string>, inTabBar: boolean): Role {
  // L'en-tête n'existe sur iOS que comme trait : un `StaticText` (ou un
  // conteneur) marqué `Header` est le titre de section que VoiceOver annonce.
  if (traits.has('Header') && (type === 'StaticText' || type === 'Other')) return 'heading';
  if (type === 'Button' && inTabBar) return 'tab';
  return ROLES[type] ?? 'group';
}

/**
 * Le nom accessible : le libellé, puis l'indication de saisie, puis `name`.
 *
 * Le libellé est ce que VoiceOver lit — l'équivalent d'`aria-label`. Un champ
 * sans libellé est nommé par son indication (« E-mail »), comme le web retombe
 * sur `placeholder`. `name` vient en dernier : c'est l'identifiant
 * d'accessibilité quand il existe, un détail technique que l'utilisateur ne
 * voit jamais.
 */
function nameOf(element: XmlElement, role: Role): string {
  const label = collapse(element.attributes['label'] ?? '');
  if (label !== '') return label;
  if (role === 'textbox' || role === 'searchbox') {
    const placeholder = collapse(element.attributes['placeholderValue'] ?? '');
    if (placeholder !== '') return placeholder;
  }
  return collapse(element.attributes['name'] ?? '');
}

/**
 * La valeur, jamais celle d'un champ sécurisé.
 *
 * L'instantané part vers le modèle branché par le client : un mot de passe
 * saisi ne doit pas quitter l'appareil — même règle que `type=password` sur le
 * web. XCUITest masque déjà par des puces, mais leur nombre trahit la longueur.
 *
 * WebDriverAgent rend l'indication de saisie comme valeur d'un champ vide :
 * on la retire, sinon un champ vide passerait pour rempli par « E-mail ».
 */
function valueOf(element: XmlElement, type: string, role: Role): string | undefined {
  if (type === 'SecureTextField') return undefined;
  if (!VALUED.has(role)) return undefined;
  const value = element.attributes['value'];
  if (value === undefined) return role === 'textbox' || role === 'searchbox' ? '' : undefined;
  const placeholder = element.attributes['placeholderValue'];
  if ((role === 'textbox' || role === 'searchbox') && placeholder !== undefined && value === placeholder) {
    return '';
  }
  return value;
}

/**
 * Rendu, au sens du web : présent dans l'arbre avec une boîte non vide.
 *
 * L'attribut `visible` de XCUITest veut dire « à l'écran » : une ligne de
 * liste sous le pli y vaut « false ». Le reprendre tel quel faisait passer
 * « la commande 1042 a disparu » pour vrai tant que la ligne était hors
 * écran — un vert qui ne prouve rien — et faisait compter à `resolve` une
 * autre population que celle montrée au modèle. Le web ne regarde pas la
 * fenêtre non plus : un élément sous le pli y est visible. UIKit retire déjà
 * de l'arbre d'accessibilité les vues masquées ou transparentes ; reste la
 * boîte vide d'une vue repliée.
 */
function isRendered(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * À l'écran, au sens de XCUITest. `visible` peut être exclu de la source par
 * réglage (pageSourceExcludedAttributes) : on retombe alors sur l'intersection
 * avec l'application.
 */
function isOnScreen(element: XmlElement, rect: Rect, viewport: Rect): boolean {
  const raw = element.attributes['visible'];
  if (raw !== undefined) return raw === 'true';
  return (
    isRendered(rect) &&
    rect.x < viewport.x + viewport.width &&
    rect.x + rect.width > viewport.x &&
    rect.y < viewport.y + viewport.height &&
    rect.y + rect.height > viewport.y
  );
}

function stateOf(element: XmlElement, role: Role, traits: Set<string>, rect: Rect): UINode['state'] {
  const state: UINode['state'] = { visible: isRendered(rect) };

  if (element.attributes['enabled'] === 'false' || traits.has('NotEnabled')) state.disabled = true;

  // WebDriverAgent rend la valeur d'un interrupteur comme un booléen
  // numérique : « 1 » activé, « 0 » désactivé.
  if (role === 'switch' || role === 'checkbox' || role === 'radio') {
    const value = element.attributes['value'];
    if (value === '1' || value === '0') state.checked = value === '1';
  }

  // `selected` n'est pas un attribut de la source : seul le trait le porte.
  if (traits.has('Selected')) {
    if (role === 'radio' || role === 'checkbox') state.checked = true;
    else state.selected = true;
  }
  // `focused` n'est écrit que sur tvOS ; on le lit quand il est là.
  if (element.attributes['focused'] === 'true') state.focused = true;
  return state;
}

/**
 * Un littéral XPath 1.0. Le langage n'a pas d'échappement : une chaîne qui
 * porte les deux guillemets se recompose par `concat()`.
 */
function xpathLiteral(text: string): string {
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  return `concat(${text
    .split('"')
    .map((part) => `"${part}"`)
    .join(`, '"', `)})`;
}

/** Le prédicat d'identité du dernier pas : `name`, sinon `label`, sinon rien. */
function identityOf(element: XmlElement): string {
  for (const attribute of ['name', 'label']) {
    const value = element.attributes[attribute];
    if (value !== undefined && value !== '') return `[@${attribute}=${xpathLiteral(value)}]`;
  }
  return '';
}

function keep(node: UINode, interactiveOnly: boolean): boolean {
  if (!interactiveOnly) return true;
  if (INTERACTIVE.has(node.role)) return true;
  if (node.children.length > 0) return true;
  return node.name.length > 0 && node.role !== 'group';
}

/** La racine utile : l'application sous `AppiumAUT`. */
function applicationOf(document: XmlElement): XmlElement {
  if (document.tag !== 'AppiumAUT') return document;
  const app = document.children.find((child) => shortType(child) === 'Application');
  const first = app ?? document.children[0];
  if (first === undefined) throw new Error('page source contains no application element');
  return first;
}

/**
 * L'identifiant d'écran : bundle, puis titre de la barre de navigation.
 *
 * iOS n'a pas d'URL. Ce qui en tient lieu doit rester stable d'une exécution à
 * l'autre et changer quand l'utilisateur change d'écran : le titre de la
 * barre de navigation visible est le seul repère que presque toutes les
 * applications exposent. Sans barre, l'identifiant se réduit au bundle.
 */
function locationOf(bundleId: string | undefined, navigationTitle: string | undefined): string {
  const base = bundleId ?? 'ios-app';
  return navigationTitle === undefined || navigationTitle === '' ? base : `${base}/${navigationTitle}`;
}

export function readScreen(xml: string, options: ReadOptions): Screen {
  const app = applicationOf(parseXml(xml));
  const viewport = rectOf(app);
  const elements = new Map<string, ElementInfo>();
  const modals: Modal[] = [];
  const interactiveOnly = options.interactiveOnly === true;
  const complete = options.mode === 'complete';
  let counter = 0;
  let navigationTitle: string | undefined;

  function walk(
    element: XmlElement,
    xpath: string,
    isRoot: boolean,
    inTabBar: boolean,
    modal: string | undefined,
  ): UINode | null {
    const type = shortType(element);
    if (!isRoot && SKIPPED.has(type)) return null;

    const traits = traitsOf(element);
    const rect = rectOf(element);
    const role = roleOf(type, traits, inTabBar);
    const state = stateOf(element, role, traits, rect);
    const onScreen = isOnScreen(element, rect, viewport);
    // L'identifiant est réservé avant les enfants : ils doivent pouvoir
    // désigner le dialogue qui les contient.
    const id = `n${counter++}`;
    const isModal = (type === 'Alert' || type === 'Sheet') && onScreen;
    const within = isModal ? id : modal;

    if (type === 'NavigationBar' && onScreen && navigationTitle === undefined) {
      navigationTitle = collapse(element.attributes['name'] ?? element.attributes['label'] ?? '');
    }

    // Rang parmi les frères de même balise, compté sur la source brute — avant
    // tout élagage — puisque c'est sur elle que XCUITest évaluera le chemin.
    const ranks = new Map<string, number>();
    const children: UINode[] = [];
    for (const child of element.children) {
      const rank = (ranks.get(child.tag) ?? 0) + 1;
      ranks.set(child.tag, rank);
      const built = walk(child, `${xpath}/${child.tag}[${rank}]`, false, inTabBar || type === 'TabBar', within);
      if (built !== null) children.push(built);
    }

    const node: UINode = {
      id,
      role,
      name: nameOf(element, role),
      state,
      rect,
      children,
    };
    const value = valueOf(element, type, role);
    if (value !== undefined) node.value = value;

    // L'identifiant d'accessibilité n'est un identifiant de test que s'il
    // diffère du libellé : WebDriverAgent recopie le libellé dans `name`
    // quand aucun identifiant n'est posé, et ce n'est alors rien de plus.
    // La barre de navigation fait exception : UIKit lui donne pour
    // identifiant le titre de l'écran, sans libellé. « #Sign In » passerait
    // pour un identifiant stable alors que c'est un texte affiché, qui change
    // avec la langue et la copie.
    const rawName = element.attributes['name'];
    if (
      type !== 'NavigationBar' &&
      rawName !== undefined &&
      rawName !== '' &&
      rawName !== (element.attributes['label'] ?? '')
    ) {
      node.testId = rawName;
    }

    const info: ElementInfo = { type: `${PREFIX}${type}`, xpath: `${xpath}${identityOf(element)}`, onScreen };
    if (within !== undefined) info.modal = within;
    elements.set(node.id, info);
    if (isModal) modals.push({ id, name: node.name });

    if (isRoot || complete) return node;
    if (!state.visible && children.length === 0) return null;

    // Les vues anonymes s'empilent sur iOS plus encore que les `div` sur le
    // web : un emballage sans nom, non interactif, à enfant unique, ne dit
    // rien au modèle et se paie en jetons à chaque réparation.
    const only = children[0];
    if (interactiveOnly && only !== undefined && children.length === 1 && node.name === '' && !INTERACTIVE.has(role)) {
      if (node.testId !== undefined && only.testId === undefined) only.testId = node.testId;
      return only;
    }

    return keep(node, interactiveOnly) ? node : null;
  }

  const root = walk(app, `//${app.tag}[1]`, true, false, undefined) as UINode;
  const declared = app.attributes['bundleId'];
  const bundleId = declared !== undefined && declared !== '' ? declared : options.bundleId;
  const screen: Screen = {
    root,
    elements,
    modals,
    location: locationOf(bundleId, navigationTitle),
    viewport,
  };
  if (bundleId !== undefined) screen.bundleId = bundleId;
  return screen;
}
