import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { resolveUpload } from './files.ts';

const BASE = resolve('qa', 'fixtures');

describe('resolveUpload', () => {
  it('résout un chemin relatif depuis le dossier du scénario', () => {
    assert.equal(resolveUpload(BASE, 'photo.png'), join(BASE, 'photo.png'));
    assert.equal(resolveUpload(BASE, join('eleves', 'photo.png')), join(BASE, 'eleves', 'photo.png'));
  });

  /**
   * `path.resolve` abandonne sa base dès que le second argument est absolu :
   * `resolve('/qa', '/home/moi/.ssh/id_rsa')` rend la clé, pas une erreur. Le
   * moteur téléversait donc vers l'application testée n'importe quel fichier
   * qu'un scénario désignait.
   */
  it('refuse un chemin absolu, que la base ne cadre pas', () => {
    const cle = join(homedir(), '.ssh', 'id_rsa');
    assert.throws(() => resolveUpload(BASE, cle), /outside the scenario directory/);
  });

  it('refuse une remontée, même profonde', () => {
    assert.throws(() => resolveUpload(BASE, '../secret.env'), /outside the scenario directory/);
    assert.throws(
      () => resolveUpload(BASE, '../../../.ssh/id_rsa'),
      /outside the scenario directory/,
    );
    assert.throws(() => resolveUpload(BASE, '..'), /outside the scenario directory/);
  });

  it('refuse le dossier lui-même, qui n\'est pas un fichier', () => {
    assert.throws(() => resolveUpload(BASE, '.'), /outside the scenario directory/);
    assert.throws(() => resolveUpload(BASE, ''), /outside the scenario directory/);
  });

  it('accepte un nom qui commence par deux points sans être une remontée', () => {
    // La garde teste « .. suivi du séparateur », pas le préfixe « .. » : un
    // fichier nommé « ..cache » est un nom légitime, et le refuser ferait
    // passer le cadrage pour un caprice.
    assert.equal(resolveUpload(BASE, '..cache'), join(BASE, '..cache'));
  });

  it('nomme la base dans le message, pour que le refus soit corrigeable', () => {
    // Un refus qui ne dit pas par rapport à quoi il refuse envoie l'auteur
    // deviner. Le message porte le dossier attendu et la conduite à tenir.
    assert.throws(() => resolveUpload(BASE, '../ailleurs.png'), (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      return message.includes(BASE) && message.includes('../ailleurs.png');
    });
  });
});
