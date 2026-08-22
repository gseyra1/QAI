import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateCheck, InterpolationError, interpolate, toNumber } from './assert.ts';
import { node } from './fixtures.ts';

describe('toNumber', () => {
  it('lit les formats français et anglais', () => {
    assert.equal(toNumber('129,00 €'), 129);
    assert.equal(toNumber('$1,234.56'), 1234.56);
    assert.equal(toNumber('1 234,56 €'), 1234.56);
    assert.equal(toNumber('1.234,56'), 1234.56);
    assert.equal(toNumber('42'), 42);
    assert.equal(toNumber('-3,5'), -3.5);
  });

  it('traite un point suivi de trois chiffres comme séparateur de milliers', () => {
    assert.equal(toNumber('1.234'), 1234);
    assert.equal(toNumber('1.23'), 1.23);
  });

  it('renvoie null quand il n\'y a pas de nombre', () => {
    assert.equal(toNumber('gratuit'), null);
    assert.equal(toNumber(''), null);
  });
});

describe('interpolate', () => {
  it('remplace les captures', () => {
    assert.equal(interpolate('total {{prix}} €', { prix: '42' }), 'total 42 €');
  });

  it('signale les captures inconnues plutôt que de produire un texte vide', () => {
    assert.throws(
      () => interpolate('{{absent}}', {}),
      (error: unknown) => error instanceof InterpolationError && error.missing.includes('absent'),
    );
  });
});

describe('evaluateCheck', () => {
  const tree = node('group', 'page', [
    node('text', '2', [], { id: 'cart' }),
    node('text', '129,00 €'),
    node('list', 'Résultats', [node('listitem', 'a'), node('listitem', 'b')]),
    node('checkbox', 'CGV', [], { state: { visible: true, checked: true } }),
    node('button', 'Masqué', [], { state: { visible: false } }),
  ]);

  it('compare un texte', () => {
    assert.deepEqual(evaluateCheck({ check: 'textEquals', target: { role: 'text', name: '2' }, value: '2' }, tree, {}), { ok: true });
    const bad = evaluateCheck({ check: 'textEquals', target: { role: 'text', name: '2' }, value: '3' }, tree, {});
    assert.equal(bad.ok, false);
    assert.match(bad.ok === false ? bad.reason : '', /attendu « 3 », observé « 2 »/);
  });

  it('compare un nombre indépendamment du format', () => {
    const result = evaluateCheck(
      { check: 'numberEquals', target: { role: 'text', name: '129,00 €' }, value: '{{prix}}' },
      tree,
      { prix: '129.00' },
    );
    assert.deepEqual(result, { ok: true });
  });

  it('compte les éléments', () => {
    const ok = evaluateCheck(
      { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', name: 'Résultats' } }, value: 2 },
      tree,
      {},
    );
    assert.deepEqual(ok, { ok: true });

    const ko = evaluateCheck(
      { check: 'countAtLeast', target: { role: 'listitem', within: { role: 'list', name: 'Résultats' } }, value: 5 },
      tree,
      {},
    );
    assert.equal(ko.ok, false);
  });

  it('vérifie un état', () => {
    assert.deepEqual(
      evaluateCheck({ check: 'stateIs', target: { role: 'checkbox' }, value: 'checked' }, tree, {}),
      { ok: true },
    );
  });

  it('distingue présent-mais-invisible d\'absent', () => {
    const invisible = evaluateCheck({ check: 'visible', target: { role: 'button', name: 'Masqué' } }, tree, {});
    assert.equal(invisible.ok, false);
    assert.match(invisible.ok === false ? invisible.reason : '', /non visible/);

    assert.deepEqual(
      evaluateCheck({ check: 'absent', target: { role: 'button', name: 'Masqué' } }, tree, {}),
      { ok: true },
    );
  });

  it('échoue clairement quand la cible n\'existe pas', () => {
    const result = evaluateCheck({ check: 'textEquals', target: { role: 'text', name: 'inconnu' }, value: 'x' }, tree, {});
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /aucun élément/);
  });

  it('tolère une valeur numérique venue du schéma de génération', () => {
    // Le schéma de sortie autorise un nombre (countAtLeast l'exige) : un modèle
    // qui émet { value: 129 } pour numberEquals ne doit pas produire un
    // TypeError sur .replace, mais une comparaison normale.
    const ecran = node('group', 'page', [node('text', '129,00 €')]);
    const check = {
      check: 'numberEquals',
      target: { role: 'text' },
      value: 129 as unknown as string,
    } as const;

    assert.deepEqual(evaluateCheck(check, ecran, {}), { ok: true });
  });
});
