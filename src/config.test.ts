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

  it('returns an empty configuration when there is no file', async () => {
    const { config, path } = await loadConfig(join(dir, 'absent.json')).catch(() => ({
      config: null,
      path: null,
    }));
    assert.equal(config, null, 'a missing explicit path must throw, not return an empty config');
    assert.equal(path, null);
  });
});
