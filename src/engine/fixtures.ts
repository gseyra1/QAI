import type { Role, UINode } from '../driver/types.ts';

let sequence = 0;

/** Construit un nœud d'arbre pour les tests. Les identifiants sont uniques par processus. */
export function node(
  role: Role,
  name: string,
  children: UINode[] = [],
  extra: Partial<UINode> = {},
): UINode {
  return {
    id: `n${sequence++}`,
    role,
    name,
    state: { visible: true },
    rect: { x: 0, y: 0, width: 10, height: 10 },
    children,
    ...extra,
  };
}
