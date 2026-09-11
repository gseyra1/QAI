import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Action,
  Driver,
  ObserveOptions,
  ResolveOutcome,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../model/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { node } from '../engine/fixtures.ts';
import { generateResolution } from './generate.ts';

const SECRET = 's3cr3t-TOKEN-abc123';

/** Le driver ré-affiche ce qui a été saisi : le secret devient du texte à l'écran. */
class ReflectingDriver implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities = { hover: true, swipe: false, navigateByUrl: true, deepLink: false };
  #typed = '';

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async dispose(): Promise<void> {}
  async settle(): Promise<void> {}

  async observe(_options?: ObserveOptions): Promise<UISnapshot> {
    const root = node('group', 'page', [
      node('textbox', 'field'),
      node('text', `Signed in as ${this.#typed}`),
    ]);
    return { platform: 'web', at: '', location: '/', viewport: { x: 0, y: 0, width: 800, height: 600 }, root };
  }

  async act(action: Action): Promise<void> {
    if (action.kind === 'fill') this.#typed = action.value;
  }

  async resolve(): Promise<ResolveOutcome> {
    return { found: true, node: node('textbox', 'field'), usedFallback: false };
  }
}

/**
 * Un modèle scripté : à l'étape 1 il saisit {{env.PW}} et capture ce que l'app
 * ré-affiche ; à l'étape 2 il propose une assertion sur {{shown}} qui échouera
 * — le chemin de fuite exact. La rejection ne doit jamais porter le secret.
 */
class LeakyProvider implements ModelProvider {
  readonly name = 'leaky';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const text = request.messages.map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')).join('\n');
    const output = text.includes('sign in')
      ? {
          actions: [{ kind: 'fill', target: { primary: { role: 'textbox' } }, value: '{{env.GEN_PW}}' }],
          captures: { shown: { from: { role: 'text' }, extract: 'text' } },
          assertions: {},
        }
      : {
          actions: [{ kind: 'click', target: { primary: { role: 'textbox' } } }],
          captures: {},
          // Faux à dessein : « Signed in as <secret> » n'égale pas ceci.
          assertions: { 'the banner is wrong': { check: 'textEquals', target: { role: 'text' }, value: '{{shown}} NOPE' } },
        };
    return { output, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const scenario: Scenario = {
  id: 'leak',
  title: 'Secret must not leak in generation',
  steps: [
    { id: 's1', do: 'sign in', capture: { shown: 'the reflected value' } },
    { id: 's2', do: 'read the banner', expect: 'the banner is wrong' },
  ],
};

describe('fuite de secret à la génération', () => {
  it('ne recopie jamais un secret capturé dans les rejets', async () => {
    process.env['GEN_PW'] = SECRET;
    try {
      const result = await generateResolution({
        scenario,
        driver: new ReflectingDriver(),
        provider: new LeakyProvider(),
        attemptsPerStep: 2,
      });

      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(SECRET), 'the secret must not appear in the generation result');
      // Le rejet a bien eu lieu (l'assertion est fausse) mais est masqué.
      const s2 = result.steps.find((step) => step.stepId === 's2');
      assert.ok((s2?.rejections.length ?? 0) > 0, 's2 must have produced a rejection');
      assert.ok(s2?.rejections.some((r) => r.includes('***')), 'the rejection must be redacted');
    } finally {
      delete process.env['GEN_PW'];
    }
  });
});

/**
 * Une navigation absolue recopiée par le modèle enferme la résolution sur la
 * machine qui l'a générée : le port de développement part dans un fichier
 * versionné, et le rejeu meurt ailleurs sur un « network failure » qui ne dit
 * rien de l'application. La vérification ne peut pas l'attraper — l'URL marche
 * parfaitement à la génération.
 */
class NavigatingDriver extends ReflectingDriver {
  override async resolve(): Promise<ResolveOutcome> {
    return { found: true, node: node('group', 'page'), usedFallback: false };
  }
}

class NavigateProvider implements ModelProvider {
  readonly name = 'navigate';
  readonly #to: string;

  constructor(to: string) {
    this.#to = to;
  }

  async complete(): Promise<ModelResponse> {
    return {
      output: { actions: [{ kind: 'navigate', to: this.#to }], captures: {}, assertions: {} },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

describe('navigation portable', () => {
  const scenarioNav: Scenario = {
    id: 'nav',
    title: 'Navigation',
    steps: [{ id: 's1', do: 'open the home page' }],
  };

  it('ramène une URL absolue de la base à un chemin', async () => {
    const result = await generateResolution({
      scenario: scenarioNav,
      driver: new NavigatingDriver(),
      provider: new NavigateProvider('http://127.0.0.1:8940/cart?x=1'),
      baseUrl: 'http://127.0.0.1:8940',
    });
    const action = result.resolution?.steps['s1']?.actions[0];
    assert.deepEqual(action, { kind: 'navigate', to: '/cart?x=1' });
  });

  it('conserve une URL d\'un autre domaine, qui est un départ délibéré', async () => {
    const result = await generateResolution({
      scenario: scenarioNav,
      driver: new NavigatingDriver(),
      provider: new NavigateProvider('https://ailleurs.example/sso'),
      baseUrl: 'http://127.0.0.1:8940',
    });
    const action = result.resolution?.steps['s1']?.actions[0];
    assert.deepEqual(action, { kind: 'navigate', to: 'https://ailleurs.example/sso' });
  });
});
