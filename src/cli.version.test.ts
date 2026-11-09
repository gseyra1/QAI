import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FORMAT_FLOOR, OBSERVATION_VERSION, RESOLUTION_VERSION } from './resolution/types.ts';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/**
 * L'avertissement de version périmée n'était vérifié par aucun test.
 *
 * C'est exactement le reproche adressé au numéro de format lui-même : un
 * mécanisme déclaré que rien ne contrôle. Or il ne sert QUE le jour où
 * l'observation change — le seul jour où son absence coûte cher, puisqu'une
 * résolution périmée passe alors au rouge sans rien expliquer.
 */
describe('avertissement de résolution périmée', () => {
  let dir: string;

  const qai = async (args: string[]): Promise<{ code: number; err: string }> => {
    try {
      const { stderr } = await run(process.execPath, [CLI, ...args]);
      return { code: 0, err: stderr };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return { code: failed.code ?? -1, err: failed.stderr ?? '' };
    }
  };

  const writeResolution = (id: string, version: number | undefined, observation?: number): void => {
    const document: Record<string, unknown> = {
      scenario: id,
      platform: 'web',
      recordedAt: '2026-01-01T00:00:00Z',
      steps: { s1: { actions: [{ kind: 'navigate', to: '.' }], healedAt: null } },
    };
    if (version !== undefined) document['version'] = version;
    if (observation !== undefined) document['observation'] = observation;
    writeFileSync(join(dir, '.qai', 'resolutions', `${id}.web.json`), JSON.stringify(document));
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'qai-version-'));
    mkdirSync(join(dir, '.qai', 'resolutions'), { recursive: true });
    for (const id of ['perimee', 'v4', 'plancher', 'courante', 'future']) {
      writeFileSync(
        join(dir, `${id}.qai.yaml`),
        `id: ${id}\ntitle: Version\nsteps:\n  - id: s1\n    do: open the home page\n`,
      );
    }
    writeResolution('perimee', 1);
    // Ce qu'écrivait 0.5.x : un format jusqu'à la v4, sans champ d'observation.
    writeResolution('v4', 4);
    // Ce qu'écrit ce QAI pour un contenu qui n'exige rien de plus.
    writeResolution('plancher', FORMAT_FLOOR, OBSERVATION_VERSION);
    writeResolution('courante', RESOLUTION_VERSION, OBSERVATION_VERSION);
    writeResolution('future', RESOLUTION_VERSION, OBSERVATION_VERSION + 1);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('prévient qu\'une résolution v1 est relue sous l\'observation courante', async () => {
    const { err } = await qai(['check', join(dir, 'perimee.qai.yaml')]);

    assert.match(err, /resolution is v1/);
    assert.match(err, new RegExp(`observes v${OBSERVATION_VERSION}`));
    // Le remède doit être dans le message : sans lui, l'utilisateur sait qu'il
    // y a un problème sans savoir quoi en faire.
    assert.match(err, /qai resolve/);
  });

  it('se tait sur une résolution à la version courante', async () => {
    const { err } = await qai(['check', join(dir, 'courante.qai.yaml')]);

    assert.doesNotMatch(err, /resolution is v/);
  });

  /**
   * Le seuil est l'observation, pas le format : un fichier au plancher, écrit
   * sous l'observation d'aujourd'hui, n'a rien de périmé. L'avertir
   * pousserait à régénérer pour rien — et apprendrait à ignorer
   * l'avertissement le jour où il comptera.
   */
  it('se tait sur un format ancien écrit sous l\'observation courante', async () => {
    const { err, code } = await qai(['check', join(dir, 'plancher.qai.yaml')]);

    assert.doesNotMatch(err, /resolution (is|was)/);
    assert.equal(code, 0);
  });

  /**
   * 0.5.x n'écrivait pas d'observation : ses fichiers se rechargent, mais leurs
   * vérifications ont été choisies sur l'ancienne visibilité. L'avertissement
   * dit pourquoi un `visible` vert jusque-là peut rougir.
   */
  it('relit une résolution écrite par 0.5.x, et prévient que l\'observation a changé', async () => {
    const { err, code } = await qai(['check', join(dir, 'v4.qai.yaml')]);

    assert.match(err, /resolution is v4/);
    assert.match(err, new RegExp(`observes v${OBSERVATION_VERSION}`));
    assert.equal(code, 0);
  });

  /**
   * L'observation ne change le sens d'aucun champ : un fichier observé par un
   * QAI plus récent se lit. Il n'est pas refusé, seulement signalé.
   */
  it('lit une résolution observée par un QAI plus récent, et le signale', async () => {
    const { err, code } = await qai(['check', join(dir, 'future.qai.yaml')]);

    assert.match(err, new RegExp(`observed under v${OBSERVATION_VERSION + 1}`));
    assert.match(err, /upgrade QAI/);
    assert.equal(code, 0);
  });

  it('n\'empêche pas la commande d\'aboutir : c\'est un avertissement', async () => {
    // Refuser de jouer une résolution périmée bloquerait une suite entière sur
    // un doute ; elle peut très bien rejouer verte.
    const { code } = await qai(['check', join(dir, 'perimee.qai.yaml')]);

    assert.equal(code, 0);
  });
});
