import type { Locator, UINode } from '../driver/types.ts';

export interface Suggestion {
  role: string;
  name: string;
  /** Distance normalisée : 0 = identique, 1 = rien en commun. */
  score: number;
}

/**
 * Au-delà, la proposition dessert plus qu'elle n'aide.
 *
 * Suggérer « Annuler » quand on cherchait « Télécharger le relevé » enverrait
 * le lecteur sur une fausse piste, ce qui est pire que de ne rien dire.
 */
const SEUIL = 0.45;

/**
 * Casse, accents et espaces multiples ne sont jamais la cause d'un ciblage
 * cassé : les neutraliser fait remonter le vrai changement de libellé.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein sur deux lignes : l'arbre d'une application réelle est large. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}

/** Le nom recherché, qu'il soit exact ou partiel. */
function wantedName(locator: Locator): string | null {
  if (locator.name === undefined) return null;
  return typeof locator.name === 'string' ? locator.name : locator.name.contains;
}

function walk(node: UINode, visit: (node: UINode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Les libellés les plus proches de la cible perdue, dans l'écran observé.
 *
 * Un message « cible introuvable » laisse le lecteur ouvrir le navigateur et
 * chercher lui-même ce qui a bougé. Lui montrer « plus proches : button
 * "Sauvegarder" » transforme le même échec en correction de dix secondes — et
 * sans appel de modèle, ce qui rend le diagnostic disponible même sans
 * `--provider`.
 *
 * Fonction pure, déterministe : deux exécutions sur le même arbre proposent la
 * même chose, ce qu'un modèle ne garantit pas.
 */
export function nearest(tree: UINode, target: Locator, limit = 3): Suggestion[] {
  const wanted = wantedName(target);
  // Un locator sans nom n'a rien dont on puisse être « proche » : proposer des
  // éléments au hasard du même rôle serait du bruit déguisé en aide.
  if (wanted === null) return [];

  const reference = normalize(wanted);
  if (reference === '') return [];

  const best = new Map<string, Suggestion>();

  walk(tree, (node) => {
    if (node.name === '' || !node.state.visible) return;

    const candidate = normalize(node.name);
    if (candidate === '') return;

    const base = distance(reference, candidate) / Math.max(reference.length, candidate.length);
    // Le rôle départage deux libellés également proches : entre un lien et un
    // bouton portant le même texte, celui qu'on cherchait est le plus probable.
    const adjusted =
      target.role === undefined ? base : node.role === target.role ? base - 0.1 : base + 0.15;
    const score = Math.min(1, Math.max(0, adjusted));

    if (score > SEUIL) return;

    const key = `${node.role} ${node.name}`;
    const known = best.get(key);
    if (known === undefined || score < known.score) {
      best.set(key, { role: node.role, name: node.name, score });
    }
  });

  return [...best.values()]
    .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/** `role "nom"`, la forme sous laquelle un arbre observé se lit déjà. */
export function describeSuggestions(suggestions: readonly Suggestion[]): string {
  if (suggestions.length === 0) return '';
  const list = suggestions.map((one) => `${one.role} "${one.name}"`).join(', ');
  return ` — plus proches : ${list}`;
}

/** Le raccourci employé partout : chercher puis formuler. */
export function suggestNearest(tree: UINode, target: Locator, limit = 3): string {
  return describeSuggestions(nearest(tree, target, limit));
}
