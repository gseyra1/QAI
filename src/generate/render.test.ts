import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UINode } from '../driver/types.ts';
import { renderAt, renderTree } from './render.ts';
import { checksMessage, stepMessage } from './prompt.ts';

function node(partial: Partial<UINode> & Pick<UINode, 'role'>): UINode {
  return {
    id: 'n0',
    name: '',
    state: { visible: true },
    rect: { x: 0, y: 0, width: 10, height: 10 },
    children: [],
    ...partial,
  };
}

describe('renderTree', () => {
  it('rend l\'identifiant de test en suffixe, quand il existe', () => {
    const root = node({
      role: 'group',
      children: [
        node({ role: 'button', name: 'Ajouter au panier', testId: 'add-to-cart' }),
        node({ role: 'button', name: 'Valider' }),
      ],
    });

    const lines = renderTree(root).split('\n');
    assert.equal(lines[1], '  button "Ajouter au panier" #add-to-cart');
    assert.equal(lines[2], '  button "Valider"');
  });
});

describe('messages de génération', () => {
  it('transmet la description de chaque capture, pas seulement son nom', () => {
    // La description est la seule intention dont dispose l'auteur du scénario
    // pour cadrer la capture : sans elle, le modèle devine — et sur le terrain
    // il a deviné un prix littéral comme cible.
    const message = stepMessage({
      intent: 'ouvrir le premier article',
      tree: 'group',
      location: '/',
      expectations: [],
      captures: { prix: 'le prix affiché' },
      availableCaptures: {},
    });
    assert.match(message, /- prix: le prix affiché/);

    const checks = checksMessage({
      tree: 'group',
      location: 'http://app.test/',
      expectations: [],
      captures: { commande: 'le numéro de commande' },
      availableCaptures: {},
    });
    assert.match(checks, /- commande: le numéro de commande/);
  });
});

describe('renderAt', () => {
  it('rend l\'élément et ses conteneurs nommés, du plus proche au plus lointain', () => {
    const counter = node({ role: 'text', name: '0', testId: 'cart-count' });
    const link = node({ role: 'link', name: 'Panier 0', children: [counter] });
    const root = node({ role: 'group', children: [node({ role: 'group', name: 'En-tête', children: [link] })] });

    assert.equal(renderAt(root, counter), 'text "0" #cart-count, inside link "Panier 0", inside group "En-tête"');
    assert.equal(renderAt(root, root), 'group');
  });
});
