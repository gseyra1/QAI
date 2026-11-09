import type { Driver, Role, UINode } from './types.ts';

/** Même ensemble que les deux pilotes intégrés : ce qu'un geste peut viser. */
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

/**
 * L'arbre élagué qu'`observe({ interactiveOnly: true })` rend, tiré de l'arbre
 * complet du même instantané.
 *
 * Les deux pilotes intégrés (`collectTree` sur le web, `readScreen` sur iOS)
 * élaguent par les mêmes règles, appliquées à des nœuds déjà construits et dont
 * aucun champ ne dépend du mode : une feuille non rendue tombe, un emballage sans
 * nom, non interactif et à enfant unique s'efface devant cet enfant et lui lègue
 * son identifiant de test, un nœud sans enfant, sans nom ni rôle interactif tombe
 * (un `group` nommé aussi). Les identifiants sont attribués à chaque élément
 * parcouru, élagué ou non : un même élément porte le même sur les deux arbres. Les
 * rejouer ici sur l'arbre complet rend donc exactement l'arbre élagué du même
 * instant, ce que des tests vérifient sur chaque page de démonstration et chaque
 * source iOS d'exemple. Une règle changée d'un côté sans l'autre les casse.
 *
 * Pure : l'arbre reçu n'est jamais modifié.
 */
export function pruneInteractive(root: UINode): UINode {
  return { ...root, children: prunedChildren(root) };
}

function prunedChildren(node: UINode): UINode[] {
  const out: UINode[] = [];
  for (const child of node.children) {
    const kept = pruned(child);
    if (kept !== null) out.push(kept);
  }
  return out;
}

function pruned(node: UINode): UINode | null {
  const children = prunedChildren(node);
  if (!node.state.visible && children.length === 0) return null;

  const only = children[0];
  if (only !== undefined && children.length === 1 && node.name === '' && !INTERACTIVE.has(node.role)) {
    return node.testId !== undefined && only.testId === undefined ? { ...only, testId: node.testId } : only;
  }

  if (INTERACTIVE.has(node.role) || children.length > 0 || (node.name.length > 0 && node.role !== 'group')) {
    return { ...node, children };
  }
  return null;
}

/** Les `observe` dont l'arbre élagué est `pruneInteractive` de leur arbre complet. */
const DERIVABLE = new WeakSet<object>();

/**
 * Déclare qu'un `observe` élague par les règles de `pruneInteractive`.
 *
 * Réservé aux pilotes intégrés, dont l'équivalence est prouvée par les tests. Un
 * pilote tiers implémente le contrat publié, qui ne dit rien de son élagage : il
 * garde deux lectures.
 */
export function prunesLikeBuiltIns(observe: Driver['observe']): void {
  DERIVABLE.add(observe);
}

/**
 * Vrai si une seule lecture, complète, suffit à donner les deux arbres.
 *
 * La méthode elle-même est comparée, pas la classe : une sous-classe qui
 * redéfinit `observe` n'élague peut-être plus de la même façon.
 */
export function derivesPruned(driver: Driver): boolean {
  return DERIVABLE.has(driver.observe);
}
