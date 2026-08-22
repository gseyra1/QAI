import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { node } from './fixtures.ts';
import { describeSuggestions, nearest, suggestNearest } from './nearest.ts';

const PAGE = node('group', 'page', [
  node('button', 'Sauvegarder'),
  node('button', 'Annuler'),
  node('link', 'Télécharger le relevé'),
  node('heading', 'Fiche élève'),
  node('button', 'Masqué', [], { state: { visible: false } }),
]);

/**
 * Ces suggestions remplacent l'ouverture d'un navigateur par une lecture de
 * deux secondes, sans appel de modèle : c'est ce qui rend le diagnostic
 * disponible même sans `--provider`.
 */
describe('nearest', () => {
  it('retrouve un libellé qui a légèrement changé', () => {
    const [premier] = nearest(PAGE, { role: 'button', name: 'Sauvegarde' });
    assert.equal(premier?.name, 'Sauvegarder');
    assert.equal(premier?.role, 'button');
  });

  it('ignore la casse et les accents, qui ne cassent jamais un ciblage', () => {
    const [premier] = nearest(PAGE, { role: 'link', name: 'TELECHARGER LE RELEVE' });
    assert.equal(premier?.name, 'Télécharger le relevé');
    assert.equal(premier?.score, 0, 'à la normalisation près, c\'est le même libellé');
  });

  /**
   * Envoyer le lecteur sur une fausse piste est pire que de ne rien dire.
   */
  it('ne propose rien quand rien n\'est proche', () => {
    assert.deepEqual(nearest(PAGE, { role: 'button', name: 'Exporter en PDF' }), []);
  });

  it('privilégie le rôle attendu à libellés égaux', () => {
    const arbre = node('group', 'page', [node('link', 'Valider'), node('button', 'Valider')]);
    const [premier] = nearest(arbre, { role: 'button', name: 'Valides' });
    assert.equal(premier?.role, 'button');
  });

  it('n\'invente rien à partir d\'un locator sans nom', () => {
    assert.deepEqual(nearest(PAGE, { role: 'button' }), []);
  });

  it('écarte ce qui n\'est pas visible', () => {
    assert.deepEqual(nearest(PAGE, { role: 'button', name: 'Masque' }), []);
  });

  it('classe du plus proche au plus lointain et borne le nombre', () => {
    const arbre = node('group', 'page', [
      node('button', 'Valider'),
      node('button', 'Valider 2'),
      node('button', 'Valider 3'),
      node('button', 'Valider 4'),
    ]);
    const trouves = nearest(arbre, { role: 'button', name: 'Valider' }, 2);

    assert.equal(trouves.length, 2);
    assert.equal(trouves[0]?.name, 'Valider');
    assert.ok((trouves[0]?.score ?? 1) <= (trouves[1]?.score ?? 1));
  });

  it('accepte un ciblage partiel', () => {
    const [premier] = nearest(PAGE, { name: { contains: 'Fiche eleve' } });
    assert.equal(premier?.name, 'Fiche élève');
  });
});

describe('describeSuggestions', () => {
  it('se lit comme un arbre observé', () => {
    assert.equal(
      suggestNearest(PAGE, { role: 'button', name: 'Sauvegarde' }),
      ' — plus proches : button "Sauvegarder"',
    );
  });

  it('reste muet quand il n\'y a rien à dire', () => {
    assert.equal(describeSuggestions([]), '');
  });
});
