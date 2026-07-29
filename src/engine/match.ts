import type { Locator, UINode } from '../driver/types.ts';

/**
 * Appariement d'un locator contre un arbre observé.
 *
 * Cette fonction est pure et vit dans le moteur, pas dans les drivers : c'est
 * ce qui garantit que « le panier contient X » veut dire exactement la même
 * chose sur le web et sur mobile. Déléguée aux drivers, la sémantique
 * divergerait sans que personne ne s'en aperçoive.
 */
export function matchNodes(root: UINode, locator: Locator): UINode[] {
  const pool =
    locator.within !== undefined
      ? dedupe(matchNodes(root, locator.within).flatMap(strictDescendants))
      : subtree(root);

  const matched = pool.filter((node) => matchesLocally(node, locator));

  if (locator.nth !== undefined) {
    const picked = matched[locator.nth];
    return picked === undefined ? [] : [picked];
  }
  return matched;
}

export function matchOne(root: UINode, locator: Locator): UINode | null {
  const matched = matchNodes(root, locator);
  return matched.length === 1 ? (matched[0] as UINode) : null;
}

function matchesLocally(node: UINode, locator: Locator): boolean {
  if (locator.role !== undefined && node.role !== locator.role) return false;
  if (locator.name === undefined) return true;
  if (typeof locator.name === 'string') return node.name === locator.name;
  return node.name.includes(locator.name.contains);
}

function subtree(node: UINode): UINode[] {
  const out: UINode[] = [node];
  for (const child of node.children) out.push(...subtree(child));
  return out;
}

function strictDescendants(node: UINode): UINode[] {
  return node.children.flatMap(subtree);
}

function dedupe(nodes: UINode[]): UINode[] {
  const seen = new Set<string>();
  const out: UINode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}
