import type { Locator, ResolvedTarget, UINode } from '../driver/types.ts';
import type { CaptureSpec } from '../resolution/types.ts';
import { numberTokens, toNumber } from '../engine/assert.ts';
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
  const extra = extraKey(value, ['from', 'extract', 'after', 'before']);
  if (extra !== undefined) {
    return `${where} has an unknown key "${extra}" (it takes from, extract, after, before)`;
  }
  if (value['from'] === undefined) return `${where} needs a "from" locator`;
  const from = locatorIssue(value['from'], `${where}: from`);
  if (from !== null) return from;
  for (const bound of ['after', 'before']) {
    const anchor = value[bound];
    if (anchor === undefined) continue;
    if (!isString(anchor) || anchor.trim() === '') return `${where}: "${bound}" must be a non-empty text`;
  }
  return ['text', 'value', 'number'].includes(String(value['extract']))
    ? null
    : `${where} needs "extract": text, value or number`;
}

function flatten(node: UINode): UINode[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** Hors gabarits : `{{env.TOKEN1}}` ne porte aucun chiffre à l'écran. */
export function holdsNumber(text: string): boolean {
  return /\p{Nd}/u.test(text.replace(/\{\{[^}]*\}\}/g, ''));
}

/** Le littéral qui sert de nom au locator, sans sa forme. */
export function nameLiteral(locator: Locator): string | undefined {
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
  // Bornée, la valeur n'est qu'une partie du nom : c'est la voir dans le littéral
  // qui compte, pas l'égalité.
  if (extract === 'text') return typeof from.name === 'string' || literal.includes(read);
  return [literal, ...numberTokens(literal)].some((text) => {
    const number = toNumber(text);
    return number !== null && String(number) === read;
  });
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

const CAPTURE_REFERENCE = /\{\{(\w+)\}\}/g;

/** Les captures qu'un texte d'attente nomme (`{{nom}}`, hors `env.`), sans doublon. */
export function namedCaptures(expectation: string): string[] {
  CAPTURE_REFERENCE.lastIndex = 0;
  return [...new Set([...expectation.matchAll(CAPTURE_REFERENCE)].map((match) => match[1] as string))];
}

/**
 * Lettres et chiffres, sauf les écritures sans espaces : au milieu d'une phrase
 * japonaise, tout voisin est une lettre, et aucune valeur n'y serait isolée.
 */
const SPACELESS = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
const WORD = new RegExp(`(?!${SPACELESS.source})[\\p{L}\\p{N}]`, 'u');

const SEGMENTS = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Au milieu d'un mot, dans une écriture où seul le découpage en montre les bords. */
function inSegment(text: string, at: number, part: string): boolean {
  const end = at + part.length;
  const neighbours = `${text[at - 1] ?? ''}${text[end] ?? ''}`;
  if (!SPACELESS.test(`${part}${neighbours}`) || !SPACELESS.test(part)) return false;
  const edges = new Set<number>();
  for (const { index, segment } of SEGMENTS.segment(text)) edges.add(index).add(index + segment.length);
  return !edges.has(at) || !edges.has(end);
}

/** Dans un `{{gabarit}}` existant : réécrire ici casserait le gabarit. */
function inTemplate(text: string, at: number): boolean {
  const open = text.lastIndexOf('{{', at);
  return open >= 0 && !text.slice(open, at).includes('}}');
}

/** Un groupe de chiffres de « 1 234,50 » n'est pas un mot : il fait partie du nombre. */
function inNumber(text: string, at: number, part: string): boolean {
  if (!/^[\d\s.,]+$/.test(part)) return false;
  const end = at + part.length;
  return (
    (/\d$/.test(part) && /^[\s.,]\d/.test(text.slice(end, end + 2))) ||
    (/^\d/.test(part) && /\d[\s.,]$/.test(text.slice(Math.max(0, at - 2), at)))
  );
}

/** Les positions où `part` figure dans `text` comme un mot entier, pas au milieu d'un autre. */
function aloneAt(text: string, part: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
    const before = text[at - 1];
    const after = text[at + part.length];
    const alone = (before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after));
    if (alone && !inTemplate(text, at) && !inNumber(text, at, part) && !inSegment(text, at, part)) found.push(at);
  }
  return found;
}

function standsAlone(text: string, part: string): boolean {
  return aloneAt(text, part).length > 0;
}

/**
 * Remplace `part` là où il est un mot entier, et nulle part ailleurs.
 *
 * La réécriture proposée au modèle doit garder le sens du reste : « 442 »
 * remplacé partout dans « Commande 442, lot 44218 » donnait « lot {{n}}18 »,
 * une vérification que le rejeu ferait dépendre de la capture à tort.
 */
function replaceAlone(text: string, part: string, by: string): string {
  let out = '';
  let from = 0;
  for (const at of aloneAt(text, part)) {
    // Deux occurrences peuvent se chevaucher (« 1-1 » dans « 1-1-1 ») : la
    // première l'emporte, la seconde n'existe plus une fois remplacée.
    if (at < from) continue;
    out += text.slice(from, at) + by;
    from = at + part.length;
  }
  return out + text.slice(from);
}

/**
 * En deçà, une valeur capturée retrouvée dans un littéral n'est pas une preuve.
 *
 * « 1 », capturé comme quantité, se retrouve dans « Livraison en 1 jour » sans
 * en être la source, et un refus pousserait le modèle à écrire « Livraison en
 * {{quantite}} jour » — une vérification corrompue par la règle censée la
 * protéger. L'égalité exacte n'y échappe pas : « livré en 1 jour », comparé à
 * « 1 » quand la quantité vaut 1, n'est pas la quantité, et le réécrire en
 * silence changerait ce que la vérification prouve. Trois caractères, le seuil
 * du registre des secrets et pour la même raison : en dessous, la valeur ne se
 * distingue plus du texte ordinaire. Sous le seuil, l'égalité est une question
 * posée au modèle, l'inclusion est signalée ; aucune n'est réécrite ni refusée.
 * La frontière de mot écarte en plus « 12 » dans « 2012 ».
 */
const MIN_EMBEDDED = 3;

const LITERAL_CHECKS = new Set(['textEquals', 'textContains', 'numberEquals', 'urlEquals', 'urlContains']);

export interface FrozenOutcome {
  /** La vérification réécrite, quand le littéral ÉTAIT la capture. */
  check?: Record<string, unknown>;
  /** Ce qui a été réécrit : corrigé et revérifié, pas un doute. */
  note?: string;
  error?: string;
  warning?: string;
  /**
   * À poser une fois au modèle, quand un tour le permet ; sinon, ou s'il
   * maintient le littéral, `warning` s'applique et rien n'est réécrit.
   */
  question?: string;
}

/**
 * Une capture nommée par l'attente, mais figée en littéral dans la vérification.
 *
 * « la liste des emprunts contient la référence "{{reference}}" » est devenue
 * `textContains "EMP-4418"` : la valeur du jour, recopiée. Elle passe à la
 * génération, et passera encore au rejeu tant que l'application affiche ce
 * littéral-là — même si la référence capturée, elle, a changé. L'attente
 * disait « celle qu'on vient de lire » ; le fichier dit « celle d'hier ». Rien
 * ne le voit à la génération, puisque les deux coïncident.
 *
 * Quatre cas, du plus sûr au plus douteux :
 * - le littéral est la valeur capturée (au nombre près pour `numberEquals`) :
 *   réécrit en `{{nom}}`. Aucun sens n'est perdu aujourd'hui, et c'est ce que
 *   l'attente demandait. Un refus n'apprendrait rien de plus au modèle et lui
 *   coûterait un tour ; signalé, pour que la relecture le sache.
 * - la même égalité, sur une valeur trop courte pour être une preuve (voir
 *   `MIN_EMBEDDED`) : question au modèle, qui sait seul ce qu'il comparait.
 *   Les deux réponses sont univoques : `{{nom}}`, ou le littéral maintenu.
 * - le littéral CONTIENT la valeur capturée (« Référence EMP-4418 ») : refusé,
 *   avec la réécriture exacte à recopier. La réponse attendue est univoque, et
 *   c'est ce qui sépare ce refus de ceux qui ont dégradé les vérifications
 *   (voir `tautologicalCheck`).
 * - le littéral n'est qu'une PARTIE de la valeur capturée (« EMP-4418 » quand
 *   la capture a lu « Référence EMP-4418 ») : signalé seulement. Ni `{{nom}}`
 *   ni un littéral ne sont justes ici : le défaut est dans la capture, à une
 *   étape déjà résolue, et le modèle ne peut pas l'y corriger.
 *
 * Chaque cas est cherché sur TOUTES les captures nommées avant de passer au
 * suivant, les plus longues d'abord : « EMP-4418 » est {{reference}}, pas
 * « {{prefixe}}-4418 » parce que {{prefixe}} vaut « EMP » et vient avant dans
 * la phrase. Une fois cette réécriture-là recopiée, la valeur porte un
 * gabarit et la règle ne la verrait plus.
 *
 * Une vérification qui référence déjà `{{nom}}`, dans sa valeur ou sa cible,
 * n'est pas concernée ; une valeur qui porte un autre gabarit non plus — elle
 * n'est pas un littéral.
 */
export function frozenCapture(
  key: string,
  check: unknown,
  known: Readonly<Record<string, string>>,
): FrozenOutcome | null {
  if (!isRecord(check)) return null;
  const value = frozenValue(key, check, known);
  const target = frozenTarget(key, value?.check ?? check, known);
  if (value === null || target === null) return value ?? target;
  const joined = (first?: string, second?: string): string | undefined =>
    first === undefined ? second : second === undefined ? first : `${first}; ${second}`;
  const rewritten = target.check ?? value.check;
  const note = joined(value.note, target.note);
  const warning = joined(value.warning, target.warning);
  return {
    ...(rewritten !== undefined ? { check: rewritten } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(warning !== undefined ? { warning } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
    ...(value.question !== undefined ? { question: value.question } : {}),
  };
}

/** Les captures que l'attente nomme et que `scope` n'emploie nulle part. */
function unusedCaptures(
  key: string,
  scope: Record<string, unknown>,
  known: Readonly<Record<string, string>>,
): { name: string; value: string; template: string }[] {
  const written = JSON.stringify(scope);
  return namedCaptures(key)
    .map((name) => ({ name, value: known[name], template: `{{${name}}}` }))
    .filter(
      (capture): capture is { name: string; value: string; template: string } =>
        capture.value !== undefined && capture.value.trim() !== '' && !written.includes(capture.template),
    )
    // Stable : à longueur égale, l'ordre de la phrase départage.
    .sort((a, b) => b.value.trim().length - a.value.trim().length);
}

function frozenValue(
  key: string,
  check: Record<string, unknown>,
  known: Readonly<Record<string, string>>,
): FrozenOutcome | null {
  if (!isString(check['check']) || !LITERAL_CHECKS.has(check['check'])) return null;
  const given = check['value'];
  if (!isString(given) && typeof given !== 'number') return null;
  const literal = String(given);
  if (literal.includes('{{')) return null;
  const numeric = check['check'] === 'numberEquals';
  // La valeur seule : une cible en `{{nom}}` n'empêche pas de comparer au
  // littéral du jour, et ce rejeu-là est rouge.
  const candidates = unusedCaptures(key, { value: literal }, known);

  for (const { value, template } of candidates) {
    const same =
      literal === value ||
      (numeric && toNumber(literal) !== null && toNumber(literal) === toNumber(value));
    if (!same) continue;
    // Deux captures de même valeur : l'ordre de la phrase ne dit pas laquelle.
    const tied = candidates.some(
      (other) =>
        other.template !== template &&
        (other.value === value || (numeric && toNumber(other.value) === toNumber(value))),
    );
    const short = (numeric ? String(toNumber(value)) : value.trim()).length < MIN_EMBEDDED;
    if (short || tied) {
      const doubt = tied ? 'another capture holds the same value' : 'a value this short can match by chance';
      const reason = tied ? 'shared by several captures' : 'too short';
      return {
        question: `assertion "${key}" compares "${literal}", today's value of ${template}, but ${doubt}: if it is that capture, write ${template} in its place, so replay compares against the value captured then; if it is another value that happens to be equal, resend it unchanged`,
        warning: `assertion "${key}" compares the literal "${literal}", today's value of ${template}, ${reason} to tell whether it is the capture: kept as is; if it is, write ${template} in its place, or replay keeps comparing against today's value`,
      };
    }
    return {
      check: { ...check, value: template },
      note: `assertion "${key}" compared the literal "${literal}", today's value of ${template}: rewritten to ${template}, so replay compares against the value captured then`,
    };
  }

  // Un nombre comparé numériquement n'a pas de sous-chaîne qui fasse sens.
  if (numeric) return null;

  for (const { value, template } of candidates) {
    if (!standsAlone(literal, value)) continue;
    if (value.trim().length < MIN_EMBEDDED) {
      return {
        warning: `assertion "${key}" compares the literal "${literal}", which holds "${value}", today's value of ${template}: if that is the capture, write ${template} in its place, or replay keeps comparing against today's value`,
      };
    }
    return {
      error: `assertion "${key}": the scenario names ${template}, but "${literal}" freezes its current value "${value}", and replay would keep comparing against it once the capture changes — write ${template} in place of "${value}": "${replaceAlone(literal, value, template)}"`,
    };
  }

  for (const { value, template } of candidates) {
    if (literal.trim().length >= MIN_EMBEDDED && standsAlone(value, literal)) {
      return {
        warning: `assertion "${key}" compares the literal "${literal}", only part of today's value of ${template} ("${value}"): replay keeps comparing against today's value — capture exactly that part at the step that reads it, then use ${template}`,
      };
    }
  }
  return null;
}

/**
 * Une attente qui nomme une capture, traduite par une vérification qui ne
 * l'emploie pas.
 *
 * `frozenCapture` reconnaît un littéral qui EST la valeur du jour ; ceci couvre
 * tout le reste. Mesuré avec DeepSeek sur un parcours de commande : la capture
 * du prix a lu le compteur du panier, « le total est égal à {{prix}} » est refusé
 * (`expected 0, observed 129`), et le modèle recopie 129 de l'écran (4 fois sur
 * 4). Vert à la génération sur une attente fausse, rouge au premier prix changé,
 * et rien ne désigne la capture, seule fautive. Un `visible` sur le total serait
 * pire : vert à tous les prix.
 *
 * Refusé, pas signalé : la vérification est vraie à l'écran alors que l'attente
 * du scénario y est fausse, et le fichier serait écrit quand même. Une attente
 * qui ne s'écrit pas avec sa capture (« le double de {{prix}} ») fait échouer
 * l'étape : aucune vérification ne dirait ce que le scénario demande.
 *
 * Le refus donne la valeur de la capture : quand elle a lu le mauvais élément, le
 * défaut est à une étape déjà résolue, et seul le lecteur du rapport peut le voir.
 */
export function droppedCaptures(
  key: string,
  check: unknown,
  known: Readonly<Record<string, string>>,
): string[] {
  if (!isRecord(check)) return [];
  return unusedCaptures(key, check, known).map(
    ({ value, template }) =>
      `assertion "${key}": the scenario compares against ${template}, which holds "${value}", but this check does not use it, so it no longer tests what the scenario says — write ${template} in its value or its target. If ${template} is false on this screen, check the target; a literal copied from the screen is not the fix: if the capture read the wrong element, this step cannot be resolved from here`,
  );
}

/** Les noms littéraux d'un locator, `within` compris. */
export function locatorNames(locator: Record<string, unknown>): string[] {
  const name = locator['name'];
  const literal = isRecord(name) ? name['contains'] : name;
  const within = locator['within'];
  return [...(isString(literal) ? [literal] : []), ...(isRecord(within) ? locatorNames(within) : [])];
}

function mapNames(locator: Record<string, unknown>, map: (name: string) => string): Record<string, unknown> {
  const out = { ...locator };
  const name = locator['name'];
  if (isString(name)) out['name'] = map(name);
  else if (isRecord(name) && isString(name['contains'])) out['name'] = { contains: map(name['contains']) };
  if (isRecord(locator['within'])) out['within'] = mapNames(locator['within'], map);
  return out;
}

/**
 * La même capture figée, dans le nom de la cible.
 *
 * « la liste contient {{reference}} » est revenue en `visible` sur `{ contains:
 * "CMD-7797" }` : vert à la génération, rouge au premier rejeu sur une autre
 * commande (mesuré, 3 fois sur 3). Réécrit quand le nom porte la valeur
 * capturée : la cible réécrite est revérifiée comme le reste. Le cas du nom qui
 * n'est qu'une partie de la capture reste signalé, comme pour une valeur.
 */
function frozenTarget(
  key: string,
  check: Record<string, unknown>,
  known: Readonly<Record<string, string>>,
): FrozenOutcome | null {
  const target = check['target'];
  if (!isRecord(target)) return null;
  // La cible seule : `{{reference}}` dans la valeur n'empêche pas de chercher
  // l'élément par la référence du jour, et ce rejeu-là échoue.
  const candidates = unusedCaptures(key, {}, known);
  const names = locatorNames(target);
  // Un nombre extrait ne se replace pas dans le texte d'où il vient : « 129 »
  // dans « 129,00 € » casserait au premier montant à décimales.
  const numeric = (value: string): boolean => /^-?\d+(\.\d+)?$/.test(value);
  const rewritable = candidates.filter(
    ({ value, template }) =>
      value.trim().length >= MIN_EMBEDDED &&
      !numeric(value) &&
      !candidates.some((other) => other.template !== template && other.value === value),
  );

  let rewritten = target;
  const fixed: string[] = [];
  for (const { value, template } of rewritable) {
    if (!locatorNames(rewritten).some((name) => standsAlone(name, value))) continue;
    rewritten = mapNames(rewritten, (name) => replaceAlone(name, value, template));
    fixed.push(`assertion "${key}" located its target by "${value}", today's value of ${template}: rewritten to ${template}, so replay looks for the value captured then`);
  }
  if (fixed.length > 0) return { check: { ...check, target: rewritten }, note: fixed.join('; ') };

  for (const { value, template } of candidates) {
    // Un libellé stable, « À rendre » dans « À rendre avant le 12/11 », reste une
    // bonne cible. Seul un fragment qui porte une donnée se fige.
    const part = names.find(
      (name) => name.trim().length >= MIN_EMBEDDED && holdsNumber(name) && standsAlone(value, name),
    );
    if (part !== undefined) {
      return {
        warning: `assertion "${key}" locates its target by "${part}", only part of today's value of ${template} ("${value}"): replay keeps looking for today's value — capture exactly that part at the step that reads it, then use ${template}`,
      };
    }
    const holder = names.find(
      (name) =>
        standsAlone(name, value) ||
        (numeric(value) && numberTokens(name).some((token) => toNumber(token) === toNumber(value))),
    );
    if (holder !== undefined) {
      return {
        warning: `assertion "${key}" locates its target by "${holder}", which holds today's value of ${template}: kept as is, too short or numeric to rewrite; target the structure instead, with "within" or "nth"`,
      };
    }
  }
  return null;
}

/**
 * Les mêmes captures figées dans le `from` d'une capture de l'étape.
 *
 * « le montant de la commande {{reference}} » lu dans la ligne de CMD-1042 reste
 * vert au rejeu, et rapporte le montant de l'ancienne commande. La description
 * joue ici le rôle de l'attente.
 */
export function frozenFrom(
  description: string,
  from: Locator,
  known: Readonly<Record<string, string>>,
): { from: Locator; note?: string; warning?: string } {
  const outcome = frozenTarget(description, { target: from }, known);
  if (outcome === null) return { from };
  const rewritten = outcome.check?.['target'] as Locator | undefined;
  return {
    from: rewritten ?? from,
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    ...(outcome.warning !== undefined ? { warning: outcome.warning } : {}),
  };
}

/**
 * La partie fixe d'un texte dont on lit un nombre : « € » dans « 129,00 € ».
 *
 * Sert à situer une capture autrement que par sa valeur. Le plus long des morceaux
 * qui restent une fois les nombres retirés, sans chiffre, ou `null` s'il n'en reste
 * aucun : « 129 » n'a pas de partie fixe.
 */
export function stableFragment(text: string): string | null {
  const parts = numberTokens(text).reduce((rest, token) => rest.replace(token, '\0'), text).split('\0');
  const kept = parts.map((part) => part.trim()).filter((part) => part !== '' && !holdsNumber(part));
  return kept.reduce<string | null>((best, part) => (best === null || part.length > best.length ? part : best), null);
}

/**
 * Une capture située par sa seule position : un `nth`, et aucun nom, ni le sien
 * ni celui d'un conteneur.
 *
 * Mesuré avec DeepSeek : sur une fiche sans conteneur nommé, et avec la consigne
 * de ne pas nommer une donnée, le prix finit en `{ role: text, nth: 0 }`. Accepté,
 * puisqu'un élément existe, et ce `nth` compte depuis le haut de la page : il lit
 * le compteur du panier. Rien ne relie ce locator à ce que la capture doit lire,
 * et le modèle ne voit jamais la valeur obtenue.
 */
export function locatedByPosition(spec: CaptureSpec): boolean {
  return spec.from.nth !== undefined && locatorNames(spec.from as Record<string, unknown>).length === 0;
}

/**
 * Une capture qui rapporte tout un texte de plusieurs mots.
 *
 * Mesuré : avec la consigne seule, le modèle n'a jamais borné « le numéro de
 * commande » dans « Votre commande CMD-7797 est confirmée » (0 sur 3). Le défaut
 * ne se voit qu'à l'étape qui compare, déjà trop tard pour corriger celle-ci.
 * La question part ici, sur la capture, et le modèle tranche : « Chaise de
 * bureau » est bien un texte entier. Deux mots suffisent : « Référence EMP-4418 »
 * est le cas courant, et une question coûte moins qu'un rejeu rouge. Une référence
 * d'un seul tenant n'est pas concernée ; là où l'écriture n'a pas d'espaces, on
 * compte les segments. Un nombre se soude à ses voisins dès que le texte en porte
 * deux : « 129,00 € pour 3 articles » lit 129003.
 */
export function readsWholeText(spec: CaptureSpec, read: string, source: string): boolean {
  if (spec.extract === 'number') {
    return spec.after === undefined && spec.before === undefined && numberTokens(source).length >= 2;
  }
  if (spec.after !== undefined || spec.before !== undefined) return false;
  if (read.trim().split(/\s+/).length >= 2) return true;
  if (!SPACELESS.test(read)) return false;
  return [...SEGMENTS.segment(read)].filter((segment) => segment.isWordLike).length >= 3;
}
