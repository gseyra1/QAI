import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBaseFor, relativeToBase, resolveAgainstBase } from './url.ts';

/**
 * L'écriture et la lecture partagent ces règles : ce que `relativeToBase`
 * écrit, `resolveAgainstBase` doit le relire comme l'adresse d'origine — sur
 * la base de la génération comme sur celle d'un autre port.
 */
describe('adresses relatives à la base', () => {
  const cases: [string, string, string][] = [
    ['http://h:1/', 'http://h:1/orders?id=3#top', 'orders?id=3#top'],
    ['http://h:1/app', 'http://h:1/app/eleves/42', 'eleves/42'],
    ['http://h:1/app/', 'http://h:1/login?next=/app', '/login?next=/app'],
    ['http://h:1/app', 'http://h:1/app/', '.'],
    ['http://h:1/app/', 'http://h:1/app/?vue=liste', '?vue=liste'],
    ['http://h:1/app/', 'http://h:1/app/#haut', '#haut'],
    // Relues autrement sans le « ./ » : un schéma, un chemin d'origine.
    ['http://h:1/app/', 'http://h:1/app/a:b', './a:b'],
    ['http://h:1/app/', 'http://h:1/app//x', './/x'],
    // Un « ? » ou un « # » vide fait partie de l'adresse : `search` et `hash`
    // l'effacent, la forme écrite doit le garder.
    ['http://h:1/app/', 'http://h:1/app/x?', 'x?'],
    ['http://h:1/app/', 'http://h:1/app/x#', 'x#'],
    ['http://h:1/app/', 'http://h:1/app/?', '?'],
    // La base sans sa barre finale n'est pas la base : « . » ajouterait la
    // barre, et l'égalité stricte porte justement sur elle.
    ['http://h:1/app', 'http://h:1/app', '/app'],
  ];

  for (const [base, absolute, relative] of cases) {
    it(`${absolute} sous ${base} → ${relative}`, () => {
      assert.equal(relativeToBase(absolute, base), relative);
      assert.equal(resolveAgainstBase(relative, base), absolute);
      // Rejouée sur un autre port, la forme relative suit la base.
      const moved = base.replace(':1', ':2');
      assert.equal(resolveAgainstBase(relative, moved), absolute.replace(':1', ':2'));
    });
  }

  it('ne ramène pas une autre origine', () => {
    assert.equal(relativeToBase('https://auth.example.com/login', 'http://h:1/'), null);
    assert.equal(relativeToBase('http://h:2/x', 'http://h:1/'), null);
  });

  it('rend une valeur absolue telle quelle, et toute valeur sans base', () => {
    assert.equal(resolveAgainstBase('http://APP.test/a', 'http://h:1/'), 'http://APP.test/a');
    assert.equal(resolveAgainstBase('orders', undefined), 'orders');
  });

  /**
   * L'analyse d'URL résout « » en la base et efface les blancs : une capture
   * revenue vide ferait d'un urlEquals l'affirmation « on est à la racine ».
   */
  it('ne résout pas une valeur vide ou bordée de blancs', () => {
    for (const value of ['', ' ', ' orders', 'orders\n', 'or\tders']) {
      assert.equal(resolveAgainstBase(value, 'http://h:1/app'), value, JSON.stringify(value));
    }
  });

  it('ne vaut que sur le web : ailleurs, une adresse est un identifiant d\'écran', () => {
    assert.equal(checkBaseFor('web', 'http://h:1/'), 'http://h:1/');
    assert.equal(checkBaseFor('android', 'monapp://accueil'), undefined);
  });
});
