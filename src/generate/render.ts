import type { UINode } from '../driver/types.ts';

/**
 * Rend un arbre observé sous forme de texte indenté, à destination du modèle.
 *
 * Le JSON est le mauvais format ici : accolades, guillemets et noms de champs
 * répétés à chaque nœud représentent l'essentiel des octets sans porter
 * d'information. Or l'arbre est ce qu'on paie à chaque appel : sa densité est
 * un choix d'architecture, pas de confort.
 *
 * Le format restitue exactement ce dont un locator a besoin : rôle, nom
 * accessible, imbrication. Rien d'autre.
 */
export function renderTree(root: UINode): string {
  const lines: string[] = [];
  walk(root, 0, lines);
  return lines.join('\n');
}

const STATE_MARKS: ReadonlyArray<[keyof UINode['state'], string]> = [
  ['disabled', 'désactivé'],
  ['checked', 'coché'],
  ['selected', 'sélectionné'],
  ['expanded', 'déplié'],
  ['focused', 'focus'],
];

function walk(node: UINode, depth: number, lines: string[]): void {
  if (!node.state.visible) return;

  const parts: string[] = [node.role];
  if (node.name !== '') parts.push(`"${node.name}"`);
  if (node.value !== undefined && node.value !== '') parts.push(`= "${node.value}"`);

  const marks = STATE_MARKS.filter(([key]) => node.state[key] === true).map(([, label]) => label);
  if (marks.length > 0) parts.push(`[${marks.join(' ')}]`);
  if (node.testId !== undefined) parts.push(`#${node.testId}`);

  lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
  for (const child of node.children) walk(child, depth + 1, lines);
}
