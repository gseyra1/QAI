import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from './config.ts';

describe('configuration file', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qai-config-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves paths relative to the file, not the current directory', async () => {
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

  it('accepts a single scenario as a string', async () => {
    const path = join(dir, 'un.json');
    await writeFile(path, JSON.stringify({ scenarios: 'qa/login.qai.yaml' }));
    const { config } = await loadConfig(path);
    assert.equal(config.scenarios?.length, 1);
  });

  /** Un tag n'est pas un chemin : il ne doit pas passer par l'absolutisation. */
  it('reads tags, as a list or as a single string', async () => {
    const liste = join(dir, 'tags.json');
    await writeFile(liste, JSON.stringify({ tags: ['critical-path', 'billing'] }));
    assert.deepEqual((await loadConfig(liste)).config.tags, ['critical-path', 'billing']);

    const unique = join(dir, 'tag.json');
    await writeFile(unique, JSON.stringify({ tags: 'critical-path' }));
    assert.deepEqual((await loadConfig(unique)).config.tags, ['critical-path']);
  });

  it('ignores fields of unexpected type instead of propagating them', async () => {
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
  it('rejects malformed JSON instead of ignoring it', async () => {
    const path = join(dir, 'casse.json');
    await writeFile(path, '{ ceci nest pas du json');
    await assert.rejects(() => loadConfig(path), /casse\.json/);
  });

  /**
   * Le cas qui compte : une faute de frappe sur « fail » retombait sur `off`,
   * donc l'utilisateur croyait son garde-fou armé alors qu'il ne l'était pas,
   * et la suite passait au vert. Un réglage illisible arrête déjà la commande
   * côté CLI ; un garde-fou dont la raison d'être est d'être armé mérite au
   * moins autant.
   */
  it('rejects an unknown watchdog level instead of falling back to off', async () => {
    const path = join(dir, 'sentinelle.json');
    await writeFile(path, JSON.stringify({ watchdogs: { requestFailures: 'fial' } }));
    await assert.rejects(() => loadConfig(path), /watchdogs\.requestFailures must be one of/);
  });

  it('rejects an allow list that is not made of strings', async () => {
    // Une entrée non textuelle ne se verrait qu'au moment d'appeler
    // `includes` dessus, en plein milieu d'un parcours.
    const path = join(dir, 'allow.json');
    await writeFile(path, JSON.stringify({ watchdogs: { allow: ['/analytics', 404] } }));
    await assert.rejects(() => loadConfig(path), /watchdogs\.allow must be an array of strings/);
  });

  it('rejects a misspelled watchdog key instead of silently disarming it', async () => {
    // « requestFailure » sans « s » retombait sur off : le garde-fou que
    // l'utilisateur croyait armer restait muet, exactement le silence que le
    // module refuse pour une valeur illisible.
    const path = join(dir, 'typo.json');
    await writeFile(path, JSON.stringify({ watchdogs: { requestFailure: 'fail' } }));
    await assert.rejects(() => loadConfig(path), /unknown watchdogs key "requestFailure"/);
  });

  it('rejects a non-object watchdogs block instead of ignoring it', async () => {
    const path = join(dir, 'scalar.json');
    await writeFile(path, JSON.stringify({ watchdogs: 'fail' }));
    await assert.rejects(() => loadConfig(path), /watchdogs must be an object/);
  });

  it('still reads a well-formed watchdog block', async () => {
    const path = join(dir, 'sentinelle-ok.json');
    await writeFile(
      path,
      JSON.stringify({ watchdogs: { consoleErrors: 'warn', requestFailures: 'fail', allow: ['/analytics'] } }),
    );
    const { config } = await loadConfig(path);

    assert.deepEqual(config.watchdogs, {
      consoleErrors: 'warn',
      requestFailures: 'fail',
      allow: ['/analytics'],
    });
  });

  it('returns an empty configuration when there is no file', async () => {
    const { config, path } = await loadConfig(join(dir, 'absent.json')).catch(() => ({
      config: null,
      path: null,
    }));
    assert.equal(config, null, 'a missing explicit path must throw, not return an empty config');
    assert.equal(path, null);
  });

  it('reads the iOS keys, and resolves an app path relative to the file', async () => {
    const path = join(dir, 'ios.json');
    await writeFile(
      path,
      JSON.stringify({ platform: 'ios', app: 'build/Acme.app', device: 'iPhone 16', appiumUrl: 'http://127.0.0.1:4723' }),
    );
    const { config } = await loadConfig(path);

    assert.equal(config.platform, 'ios');
    assert.equal(config.app, resolve(dir, 'build/Acme.app'));
    assert.equal(config.device, 'iPhone 16');
    assert.equal(config.appiumUrl, 'http://127.0.0.1:4723');
  });

  /** Un identifiant de bundle n'est pas un chemin : l'absolutiser le casserait. */
  it('leaves a bundle id untouched', async () => {
    const path = join(dir, 'bundle.json');
    await writeFile(path, JSON.stringify({ platform: 'ios', app: 'com.example.acme' }));
    assert.equal((await loadConfig(path)).config.app, 'com.example.acme');
  });

  /**
   * « iso » retombant sur le web jouerait la suite web en croyant tester
   * l'application mobile : un vert qui ne prouve rien.
   */
  it('rejects an unknown platform instead of falling back to web', async () => {
    const path = join(dir, 'platform.json');
    await writeFile(path, JSON.stringify({ platform: 'iso' }));
    await assert.rejects(() => loadConfig(path), /platform must be "web" or "ios"/);
  });
});
