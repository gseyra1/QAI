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
  ['disabled', 'disabled'],
  ['checked', 'checked'],
  ['selected', 'selected'],
  ['expanded', 'expanded'],
  ['focused', 'focused'],
];

function line(node: UINode): string {
  const parts: string[] = [node.role];
  if (node.name !== '') parts.push(`"${node.name}"`);
  if (node.value !== undefined && node.value !== '') parts.push(`= "${node.value}"`);

  const marks = STATE_MARKS.filter(([key]) => node.state[key] === true).map(([, label]) => label);
  if (marks.length > 0) parts.push(`[${marks.join(' ')}]`);
  if (node.testId !== undefined) parts.push(`#${node.testId}`);
  return parts.join(' ');
}

function walk(node: UINode, depth: number, lines: string[]): void {
  if (!node.state.visible) return;

  lines.push(`${'  '.repeat(depth)}${line(node)}`);
  for (const child of node.children) walk(child, depth + 1, lines);
}

function pathTo(from: UINode, node: UINode): UINode[] | null {
  if (from === node) return [];
  for (const child of from.children) {
    const below = pathTo(child, node);
    if (below !== null) return [from, ...below];
  }
  return null;
}

/**
 * Un élément et ses conteneurs nommés, du plus proche au plus lointain.
 *
 * Sa ligne seule ne dit pas où il est : `text "0"` n'apprend rien, « dans le lien
 * Panier 0 » dit que ce n'est pas un prix.
 */
export function renderAt(root: UINode, node: UINode): string {
  const named = (pathTo(root, node) ?? []).filter((parent) => parent.name !== '').reverse();
  return [line(node), ...named.map((parent) => `inside ${line(parent)}`)].join(', ');
}
