import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveUpload } from './files.ts';

/**
 * Un vrai dossier de scénario avec un vrai fichier : le cadrage résout les
 * liens symboliques, ce qui exige des fichiers réels — un chemin lexical seul
 * ne prouve plus rien.
 */
describe('resolveUpload', () => {
  let root: string;
  let base: string;
  let outside: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'qai-upload-'));
    base = join(root, 'scenario');
    outside = join(root, 'secrets');
    mkdirSync(join(base, 'eleves'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(base, 'photo.png'), 'x');
    writeFileSync(join(base, 'eleves', 'photo.png'), 'x');
    writeFileSync(join(base, '..cache'), 'x');
    writeFileSync(join(outside, 'id_rsa'), 'SECRET KEY');
    // Le vecteur : un lien DANS le scénario qui pointe DEHORS. Git préserve les
    // liens, donc un dépôt de scénarios tiers pourrait en contenir un.
    symlinkSync(join(outside, 'id_rsa'), join(base, 'avatar.png'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('résout un chemin relatif à un fichier réel du dossier', () => {
    assert.equal(resolveUpload(base, 'photo.png'), join(base, 'photo.png'));
    assert.equal(
      resolveUpload(base, join('eleves', 'photo.png')),
      join(base, 'eleves', 'photo.png'),
    );
  });

  it('refuse un lien symbolique qui sort du dossier — la faille du cadrage lexical', () => {
    // « avatar.png » est lexicalement dans le dossier, mais réel dehors :
    // sans résolution des liens, ~/.ssh/id_rsa serait parti vers l'application.
    assert.throws(() => resolveUpload(base, 'avatar.png'), /outside the scenario directory/);
  });

  it('refuse un chemin absolu, que la base ne cadre pas', () => {
    assert.throws(() => resolveUpload(base, resolve(outside, 'id_rsa')), /outside the scenario directory/);
  });

  it('refuse une remontée, même profonde', () => {
    assert.throws(() => resolveUpload(base, '../secrets/id_rsa'), /outside the scenario directory/);
    assert.throws(() => resolveUpload(base, '../../../.ssh/id_rsa'), /outside the scenario directory/);
    assert.throws(() => resolveUpload(base, '..'), /outside the scenario directory/);
  });

  it('refuse le dossier lui-même, qui n\'est pas un fichier', () => {
    assert.throws(() => resolveUpload(base, '.'), /outside the scenario directory/);
    assert.throws(() => resolveUpload(base, ''), /outside the scenario directory/);
  });

  it('accepte un nom qui commence par deux points sans être une remontée', () => {
    // La garde teste « .. suivi du séparateur », pas le préfixe « .. » : un
    // fichier nommé « ..cache » est un nom légitime.
    assert.equal(resolveUpload(base, '..cache'), join(base, '..cache'));
  });

  it('signale un fichier absent plutôt que de laisser le driver expirer dessus', () => {
    assert.throws(() => resolveUpload(base, 'jamais-la.png'), /not found/);
  });

  it('nomme la base dans le message, pour que le refus soit corrigeable', () => {
    assert.throws(() => resolveUpload(base, '../ailleurs.png'), (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      return message.includes(base) && message.includes('../ailleurs.png');
    });
  });
});
