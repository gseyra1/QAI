import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from './config.ts';

describe('fichier de configuration', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qai-config-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('résout les chemins relativement au fichier, pas au répertoire courant', async () => {
    const path = join(dir, 'qai.config.json');
    await writeFile(
      path,
      JSON.stringify({ states: './qa/states.ts', provider: './qa/provider.ts', scenarios: 'qa/' }),
    );

    const { config } = await loadConfig(path);

    assert.equal(config.states, resolve(dir, 'qa/states.ts'));
    assert.equal(config.provider, resolve(dir, 'qa/provider.ts'));
    assert.deepEqual(config.scenarios, [resolve(dir, 'qa/')]);
  });

  it('accepte un scénario unique comme chaîne', async () => {
    const path = join(dir, 'un.json');
    await writeFile(path, JSON.stringify({ scenarios: 'qa/login.qai.yaml' }));
    const { config } = await loadConfig(path);
    assert.equal(config.scenarios?.length, 1);
  });

  /** Un tag n'est pas un chemin : il ne doit pas passer par l'absolutisation. */
  it('lit les tags, en liste ou en chaîne unique', async () => {
    const liste = join(dir, 'tags.json');
    await writeFile(liste, JSON.stringify({ tags: ['critical-path', 'paiement'] }));
    assert.deepEqual((await loadConfig(liste)).config.tags, ['critical-path', 'paiement']);

    const unique = join(dir, 'tag.json');
    await writeFile(unique, JSON.stringify({ tags: 'critical-path' }));
    assert.deepEqual((await loadConfig(unique)).config.tags, ['critical-path']);
  });

  it('ignore les champs de type inattendu plutôt que de les propager', async () => {
    const path = join(dir, 'types.json');
    await writeFile(path, JSON.stringify({ workers: 'quatre', baseUrl: 42, strict: true }));
    const { config } = await loadConfig(path);

    assert.equal(config.workers, undefined);
    assert.equal(config.baseUrl, undefined);
    assert.equal(config.strict, true);
  });

  /**
   * Un fichier présent mais invalide doit crier. Le passer sous silence ferait
   * tourner la suite avec des réglages que personne n'a voulus.
   */
  it('refuse un JSON malformé au lieu de l\'ignorer', async () => {
    const path = join(dir, 'casse.json');
    await writeFile(path, '{ ceci nest pas du json');
    await assert.rejects(() => loadConfig(path), /casse\.json/);
  });

  it('rend une configuration vide quand il n\'y a pas de fichier', async () => {
    const { config, path } = await loadConfig(join(dir, 'absent.json')).catch(() => ({
      config: null,
      path: null,
    }));
    assert.equal(config, null, 'un chemin explicite absent doit lever, pas rendre du vide');
    assert.equal(path, null);
  });
});
