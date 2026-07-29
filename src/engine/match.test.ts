import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { node } from './fixtures.ts';
import { matchNodes, matchOne } from './match.ts';

const tree = node('group', 'page', [
  node('list', 'Résultats', [
    node('listitem', '', [node('link', 'Chaise de bureau')]),
    node('listitem', '', [node('link', 'Lampe de bureau')]),
  ]),
  node('list', 'Panier', [node('listitem', '', [node('link', 'Chaise de bureau')])]),
  node('button', 'Valider'),
  node('button', 'Valider'),
]);

describe('matchNodes', () => {
  it('filtre par rôle et nom exact', () => {
    assert.equal(matchNodes(tree, { role: 'button', name: 'Valider' }).length, 2);
    assert.equal(matchNodes(tree, { role: 'button', name: 'Annuler' }).length, 0);
  });

  it('filtre par nom partiel', () => {
    const found = matchNodes(tree, { role: 'link', name: { contains: 'bureau' } });
    assert.equal(found.length, 3);
  });

  it('restreint la recherche au conteneur', () => {
    const inCart = matchNodes(tree, {
      role: 'link',
      within: { role: 'list', name: 'Panier' },
    });
    assert.equal(inCart.length, 1);
    assert.equal(inCart[0]?.name, 'Chaise de bureau');
  });

  it('exclut le conteneur lui-même des résultats', () => {
    const found = matchNodes(tree, { role: 'list', within: { role: 'list', name: 'Panier' } });
    assert.equal(found.length, 0);
  });

  it('désambiguïse par nth', () => {
    assert.equal(matchNodes(tree, { role: 'button', name: 'Valider', nth: 1 }).length, 1);
    assert.equal(matchNodes(tree, { role: 'button', name: 'Valider', nth: 7 }).length, 0);
  });

  it('matchOne refuse de choisir quand plusieurs correspondent', () => {
    assert.equal(matchOne(tree, { role: 'button', name: 'Valider' }), null);
    assert.notEqual(matchOne(tree, { role: 'list', name: 'Panier' }), null);
  });

  it('sans critère, ramène tout le sous-arbre', () => {
    assert.ok(matchNodes(tree, {}).length > 5);
  });
});
