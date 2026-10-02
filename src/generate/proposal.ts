import type { Locator, ResolvedTarget, UINode } from '../driver/types.ts';
import { toNumber } from '../engine/assert.ts';
import { matchNodes } from '../engine/match.ts';

/**
 * La forme exacte de ce que le modèle propose, contrôlée avant tout usage.
 *
 * Le décodage contraint par schéma n'est pas une garantie : un fournisseur en
 * mode JSON simple — DeepSeek, le modèle par défaut — rend ce qu'il veut. Un
 * `fallback` glissé dans la cible d'une assertion passait la vérification
 * (la clé était ignorée) et finissait versionné dans un fichier que le schéma
 * publié refuse. Une valeur oubliée revenait au modèle sous la forme
 * « "undefined" not found », qui ne lui dit rien. Chaque refus ici nomme la
 * clé fautive et ce qui est admis à sa place : c'est ce qui permet au modèle
 * de se corriger au tour suivant.
 *
 * Les règles sont celles de `schema/resolution.schema.json`, en plus strict
 * là où le schéma laisse passer un vert qui ne prouve rien.
 */

const ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'text', 'heading', 'image', 'textbox', 'searchbox', 'combobox',
  'checkbox', 'radio', 'switch', 'slider', 'list', 'listitem', 'table', 'row',
  'cell', 'tab', 'tablist', 'dialog', 'menu', 'menuitem', 'progressbar', 'alert',
  'group', 'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function extraKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

const LOCATOR_KEYS = ['role', 'name', 'nth', 'within'];

/** `where` préfixe le message : « assertion "…": target », « action 2: target.primary »… */
export function locatorIssue(value: unknown, where: string): string | null {
  if (!isRecord(value)) return `${where} must be an object`;
  const extra = extraKey(value, LOCATOR_KEYS);
  if (extra !== undefined) {
    const hint = extra === 'fallback' ? ' — a fallback belongs to an action target, beside "primary", never inside a locator' : '';
    return `${where} has an unknown key "${extra}": a locator only takes ${LOCATOR_KEYS.join(', ')}${hint}`;
  }
  const { role, name, nth, within } = value;
  if (role !== undefined && (!isString(role) || !ROLES.has(role))) {
    return `${where}.role "${String(role)}" is not a known role`;
  }
  if (name !== undefined && !isString(name)) {
    if (!isRecord(name) || !isString(name['contains']) || Object.keys(name).length !== 1) {
      return `${where}.name must be a string or { "contains": "..." }`;
    }
  }
  if (nth !== undefined && (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 0)) {
    return `${where}.nth must be an integer ≥ 0`;
  }
  if (within !== undefined) return locatorIssue(within, `${where}.within`);
  return null;
}

const FALLBACK_KEYS = ['testId', 'selector', 'accessibilityId'];

export function targetIssue(value: unknown, where: string): string | null {
  if (!isRecord(value)) return `${where} must be an object with "primary"`;
  const extra = extraKey(value, ['primary', 'fallback']);
  if (extra !== undefined) return `${where} has an unknown key "${extra}": a target only takes primary, fallback`;
  if (value['primary'] === undefined) return `${where} has no "primary" locator`;
  const primary = locatorIssue(value['primary'], `${where}.primary`);
  if (primary !== null) return primary;
  const fallback = value['fallback'];
  if (fallback === undefined) return null;
  if (!isRecord(fallback)) return `${where}.fallback must be an object`;
  const unknown = extraKey(fallback, FALLBACK_KEYS);
  if (unknown !== undefined) {
    return `${where}.fallback has an unknown key "${unknown}": it only takes ${FALLBACK_KEYS.join(', ')}`;
  }
  const notString = FALLBACK_KEYS.find((key) => fallback[key] !== undefined && !isString(fallback[key]));
  return notString === undefined ? null : `${where}.fallback.${notString} must be a string`;
}

/** Les champs de chaque geste, hors `kind`, et ceux qui sont obligatoires. */
const ACTION_FIELDS: Record<string, { allowed: string[]; required: string[] }> = {
  navigate: { allowed: ['to'], required: ['to'] },
  click: { allowed: ['target'], required: ['target'] },
  fill: { allowed: ['target', 'value'], required: ['target', 'value'] },
  select: { allowed: ['target', 'option'], required: ['target', 'option'] },
  press: { allowed: ['key'], required: ['key'] },
  scrollTo: { allowed: ['target'], required: ['target'] },
  hover: { allowed: ['target'], required: ['target'] },
  swipe: { allowed: ['direction'], required: ['direction'] },
  upload: { allowed: ['target', 'files'], required: ['target', 'files'] },
  expectDialog: { allowed: ['response', 'promptText'], required: ['response'] },
};

export function actionIssue(value: unknown, where: string): string | null {
  if (!isRecord(value) || !isString(value['kind'])) return `${where} has no "kind"`;
  const kind = value['kind'];
  const fields = ACTION_FIELDS[kind];
  if (fields === undefined) {
    return `${where}: unknown gesture "${kind}" (known: ${Object.keys(ACTION_FIELDS).join(', ')})`;
  }
  const extra = extraKey(value, ['kind', ...fields.allowed]);
  if (extra !== undefined) {
    return `${where}: ${kind} has an unknown key "${extra}" (it takes ${fields.allowed.join(', ')})`;
  }
  const missing = fields.required.find((key) => value[key] === undefined);
  if (missing !== undefined) return `${where}: ${kind} needs "${missing}"`;

  if (value['target'] !== undefined) {
    const target = targetIssue(value['target'], `${where}: target`);
    if (target !== null) return target;
  }
  for (const key of ['to', 'value', 'option', 'key', 'promptText']) {
    if (value[key] !== undefined && !isString(value[key])) return `${where}: "${key}" must be a string`;
  }
  if (kind === 'swipe' && !['up', 'down', 'left', 'right'].includes(String(value['direction']))) {
    return `${where}: swipe "direction" must be up, down, left or right`;
  }
  if (kind === 'expectDialog' && !['accept', 'dismiss'].includes(String(value['response']))) {
    return `${where}: expectDialog "response" must be accept or dismiss`;
  }
  if (kind === 'upload') {
    const files = value['files'];
    if (!Array.isArray(files) || files.length === 0 || !files.every(isString)) {
      return `${where}: upload "files" must be a non-empty list of paths`;
    }
  }
  return null;
}

const TARGET_CHECKS = ['visible', 'absent', 'textEquals', 'textContains', 'countAtLeast', 'numberEquals', 'stateIs'];
const URL_CHECKS = ['urlContains', 'urlEquals'];
const OBSERVATION_CHECKS = ['noFailedRequests', 'noConsoleErrors'];
const COMPARED = new Set(['textEquals', 'textContains', 'numberEquals']);
const STATES = ['checked', 'disabled', 'selected'];

/**
 * Une vérification bien formée, ou la raison du refus.
 *
 * Plus strict que le schéma sur deux points, parce que ces formes passent la
 * vérification sans rien prouver : une valeur posée sur `visible` ou `absent`
 * n'est jamais comparée — le relecteur croit le nombre vérifié, il ne l'est
 * pas — et `countAtLeast` 0 est vrai sur n'importe quel écran.
 */
export function checkIssue(value: unknown, where: string): string | null {
  if (!isRecord(value) || !isString(value['check'])) {
    return `${where} has no "check" (known: ${[...TARGET_CHECKS, ...URL_CHECKS, ...OBSERVATION_CHECKS].join(', ')})`;
  }
  const kind = value['check'];

  if (TARGET_CHECKS.includes(kind)) {
    const extra = extraKey(value, ['check', 'target', 'value']);
    if (extra !== undefined) return `${where}: ${kind} has an unknown key "${extra}" (it takes check, target, value)`;
    if (value['target'] === undefined) return `${where}: ${kind} needs a "target" locator`;
    const target = locatorIssue(value['target'], `${where}: target`);
    if (target !== null) return target;
    const given = value['value'];

    if (kind === 'visible' || kind === 'absent') {
      return given === undefined
        ? null
        : `${where}: ${kind} compares no value, so "value" would never be checked — drop it, or use textEquals, textContains or numberEquals`;
    }
    if (kind === 'countAtLeast') {
      return typeof given === 'number' && Number.isInteger(given) && given >= 1
        ? null
        : `${where}: countAtLeast needs an integer "value" ≥ 1 (0 is true on any screen)`;
    }
    if (kind === 'stateIs') {
      return isString(given) && STATES.includes(given)
        ? null
        : `${where}: stateIs needs a "value" among ${STATES.join(', ')}`;
    }
    // textEquals, textContains, numberEquals.
    return isString(given) || typeof given === 'number'
      ? null
      : `${where}: ${kind} needs a "value" — the text or number it compares the target to`;
  }

  if (URL_CHECKS.includes(kind)) {
    const extra = extraKey(value, ['check', 'value']);
    if (extra !== undefined) {
      return `${where}: ${kind} has an unknown key "${extra}" — it bears on the address, so it takes only check and value`;
    }
    return isString(value['value']) ? null : `${where}: ${kind} needs a string "value"`;
  }

  if (OBSERVATION_CHECKS.includes(kind)) {
    const extra = extraKey(value, ['check', 'allow']);
    if (extra !== undefined) return `${where}: ${kind} has an unknown key "${extra}" (it takes check, allow)`;
    const allow = value['allow'];
    return allow === undefined || (Array.isArray(allow) && allow.every(isString))
      ? null
      : `${where}: ${kind} "allow" must be a list of strings`;
  }

  return `${where}: unknown check "${kind}" (known: ${[...TARGET_CHECKS, ...URL_CHECKS, ...OBSERVATION_CHECKS].join(', ')})`;
}

export function captureIssue(value: unknown, where: string): string | null {
  if (!isRecord(value)) return `${where} must be an object with "from" and "extract"`;
  const extra = extraKey(value, ['from', 'extract']);
  if (extra !== undefined) return `${where} has an unknown key "${extra}" (it takes from, extract)`;
  if (value['from'] === undefined) return `${where} needs a "from" locator`;
  const from = locatorIssue(value['from'], `${where}: from`);
  if (from !== null) return from;
  return ['text', 'value', 'number'].includes(String(value['extract']))
    ? null
    : `${where} needs "extract": text, value or number`;
}

function flatten(node: UINode): UINode[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** Le littéral qui sert de nom au locator, sans sa forme. */
function nameLiteral(locator: Locator): string | undefined {
  if (locator.name === undefined) return undefined;
  return typeof locator.name === 'string' ? locator.name : locator.name.contains;
}

/**
 * Une vérification qui retrouve sa cible par la valeur même qu'elle affirme.
 *
 * `textEquals "1"` sur `{ role: text, name: "1" }` ne compare rien : si
 * l'élément est trouvé, son texte EST son nom. Le jour où la valeur change, il
 * n'est plus trouvé, et le rapport dit « aucun élément » au lieu de
 * « attendu 1, observé 2 ». Rouge quand même — les cibles d'assertion ne sont
 * jamais réparées —, mais le motif égare, et la donnée est figée dans le
 * fichier.
 *
 * SIGNALÉ, PAS REFUSÉ. Mesuré avec le vrai modèle : refuser l'a poussé soit à
 * lâcher la valeur — un `visible` sur une cible structurelle, vert quand le
 * statut affiché est faux —, soit à capturer le mauvais élément, soit à ne
 * plus converger en cinq tentatives. Un refus qui dégrade ce qu'il corrige
 * fabrique exactement les verts qu'il devait empêcher.
 *
 * La règle est étroite, pour ne pas toucher un libellé légitime : elle ne
 * regarde que le nom de la cible elle-même (pas de ses conteneurs), après
 * interpolation, et seulement quand le texte comparé vient de ce nom. Un champ
 * de saisie compare sa valeur, pas son libellé : il n'est pas concerné.
 * Signalé quand le nom contient la valeur attendue, ou — pour numberEquals —
 * quand il porte le même nombre.
 */
export function tautologicalCheck(
  kind: string,
  target: Locator,
  expected: string,
  matched: readonly UINode[],
): boolean {
  if (!COMPARED.has(kind)) return false;
  const literal = nameLiteral(target);
  if (literal === undefined || expected.trim() === '') return false;
  if (matched.some((node) => node.value !== undefined && node.value !== '')) return false;
  if (literal.includes(expected)) return true;
  if (kind !== 'numberEquals') return false;
  const left = toNumber(literal);
  return left !== null && left === toNumber(expected);
}

/**
 * Une capture dont la valeur lue est entièrement dictée par son locator.
 *
 * Lire `{ role: text, name: "39,00 €" }` rend « 39,00 € » — ou 39 — par
 * construction : rien n'est lu, la donnée est figée dans le fichier, et le
 * premier changement de prix casse la capture. Signalé, pour la même raison
 * que `tautologicalCheck` n'est pas refusé, quand la valeur lue
 * vient du nom du nœud et que le littéral du locator la détermine : un nom
 * exact lu en texte, un fragment `contains` égal au texte entier, ou un
 * littéral qui porte le nombre extrait. Un libellé partiel — `contains:
 * "Référence"` sur « Référence EMP-4418 » — lit bien quelque chose : admis.
 */
export function tautologicalCapture(
  from: Locator,
  extract: string,
  node: UINode,
  read: string,
): boolean {
  const literal = nameLiteral(from);
  if (literal === undefined || literal.trim() === '') return false;
  if (extract === 'value') return false;
  if (extract === 'number' && node.value !== undefined && node.value !== '') return false;
  if (extract === 'text') return typeof from.name === 'string' || read === literal;
  const number = toNumber(literal);
  return number !== null && String(number) === read;
}

/**
 * Un repli doit désigner l'élément que vise `primary`, pas un voisin.
 *
 * Le repli ne sert que le jour où `primary` ne trouve plus rien. S'il porte
 * l'identifiant d'un autre nœud — celui de la cellule autour du bouton, vu sur
 * iOS avec le vrai modèle — ce jour-là le geste part ailleurs, sans erreur :
 * le toucher ouvre la cellule, et la vérification suivante peut encore
 * passer. Rien ne le voit à la génération, puisque `primary` y fonctionne.
 *
 * L'identifiant est donc comparé à celui du nœud trouvé. Le pilote le décrit
 * hors élagage ; l'arbre présenté au modèle peut, lui, avoir hérité de
 * l'identifiant d'un emballage anonyme aplati — le même élément aux yeux de
 * l'auteur de la page. Les deux sont admis, rien d'autre.
 */
export async function fallbackIssue(
  target: ResolvedTarget,
  node: UINode,
  tree: () => Promise<UINode>,
): Promise<string | null> {
  const ids = [target.fallback?.testId, target.fallback?.accessibilityId].filter(isString);
  if (ids.length === 0) return null;
  const own = new Set<string>();
  if (node.testId !== undefined) own.add(node.testId);
  if (ids.every((id) => own.has(id))) return null;

  const root = await tree();
  const shown = matchNodes(root, target.primary);
  const single = shown.length === 1 ? shown[0] : undefined;
  if (single?.testId !== undefined) own.add(single.testId);
  const wrong = ids.find((id) => !own.has(id));
  if (wrong === undefined) return null;

  const carried = own.size === 0 ? 'the targeted element carries none' : `the targeted element's own is #${[...own].join(', #')}`;
  const elsewhere = flatten(root).some((candidate) => candidate.testId === wrong);
  return elsewhere
    ? `fallback "${wrong}" is the identifier of another element (${carried}): once the label changes, the gesture would silently land on that element — use the targeted line's own #id, or no fallback`
    : `fallback "${wrong}" designates no element on this screen (${carried}): a fallback must be the targeted line's own #id — otherwise give no fallback`;
}
