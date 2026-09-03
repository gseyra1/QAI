import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UINode } from '../driver/types.ts';
import { renderTree } from './render.ts';
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
