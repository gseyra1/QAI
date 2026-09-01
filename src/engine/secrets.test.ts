import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Action, Driver, Observations, ResolveOutcome, UINode } from '../driver/types.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { evaluateCheck, SecretRegistry } from './assert.ts';
import { node } from './fixtures.ts';
import { runScenario } from './run.ts';

const SECRET = 's3cr3t-TOKEN-abc123';

function scenario(steps: Scenario['steps']): Scenario {
  return { id: 'test', title: 'Secret test', steps };
}
function resolution(steps: Resolution['steps']): Resolution {
  return { scenario: 'test', platform: 'web', recordedAt: '2026-07-28T00:00:00Z', steps };
}

describe('SecretRegistry', () => {
  it('masque une valeur enregistrée, où qu\'elle apparaisse', () => {
    const reg = new SecretRegistry();
    reg.add(SECRET);
    assert.equal(reg.redact(`saw ${SECRET} in the url`), 'saw *** in the url');
  });

  it('ne masque pas une valeur trop courte, qui polluerait tout un rapport', () => {
    const reg = new SecretRegistry();
    reg.add('ab');
    assert.equal(reg.redact('label ab here'), 'label ab here');
  });

  it('enregistre le secret qu\'une assertion sur {{env.X}} révèle', () => {
    process.env['QAI_TEST_PW'] = SECRET;
    try {
      const reg = new SecretRegistry();
      const tree = node('group', 'page', [node('text', 'wrong')]);
      // Une assertion sur {{env.X}} enseigne le secret au registre…
      evaluateCheck(
        { check: 'textEquals', target: { role: 'text' }, value: '{{env.QAI_TEST_PW}}' },
        { root: tree, location: '/', bag: {}, secrets: reg },
      );
      // …qui masque désormais ce même secret arrivé autrement (ici une capture).
      assert.equal(reg.redact(`captured ${SECRET}`), 'captured ***');
    } finally {
      delete process.env['QAI_TEST_PW'];
    }
  });
});

/**
 * Le pilote factice qui rejoue le scénario de fuite : un champ rempli, puis
 * l'application le RÉ-AFFICHE (le secret devient du texte à l'écran), qu'une
 * capture lit, qu'une assertion compare — le chemin exact que l'audit a cassé.
 */
class ReflectingDriver implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities = {
    hover: true,
    swipe: false,
    navigateByUrl: true,
    deepLink: false,
  };
  #typed = '';

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async dispose(): Promise<void> {}
  async settle(): Promise<void> {}

  async observe(): Promise<{ platform: 'web'; at: string; location: string; viewport: UINode['rect']; root: UINode }> {
    // L'application affiche ce qui a été saisi — un bandeau « Signed in as … ».
    const root = node('group', 'page', [node('text', `Signed in as ${this.#typed}`)]);
    return { platform: 'web', at: '', location: '/', viewport: { x: 0, y: 0, width: 800, height: 600 }, root };
  }

  async act(action: Action): Promise<void> {
    if (action.kind === 'fill') this.#typed = action.value;
  }

  async resolve(): Promise<ResolveOutcome> {
    return { found: true, node: node('textbox', 'field'), usedFallback: false };
  }

  drainObservations(): Observations {
    return { network: [], console: [] };
  }
}

describe('fuite de secret de bout en bout', () => {
  it('ne publie jamais un secret capturé, ni en raison ni en capture', async () => {
    process.env['QAI_LOGIN_PW'] = SECRET;
    try {
      const report = await runScenario({
        driver: new ReflectingDriver(),
        scenario: scenario([
          { id: 's1', do: 'sign in', expect: 'the banner shows the wrong name' },
        ]),
        resolution: resolution({
          s1: {
            actions: [{ kind: 'fill', target: { primary: { role: 'textbox' } }, value: '{{env.QAI_LOGIN_PW}}' }],
            captures: { shown: { from: { role: 'text' }, extract: 'text' } },
            assertions: {
              'the banner shows the wrong name': {
                check: 'textEquals',
                target: { role: 'text' },
                value: 'Signed in as nobody',
              },
            },
          },
        }),
        assertTimeoutMs: 0,
      });

      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes(SECRET), 'the secret must not appear anywhere in the report');
      // La capture a bien eu lieu (elle contient le secret) mais est masquée.
      assert.match(report.captures['shown'] ?? '', /\*\*\*/);
    } finally {
      delete process.env['QAI_LOGIN_PW'];
    }
  });
});
