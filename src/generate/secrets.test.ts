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
    { id: 's1', do: 'sign in with GEN_PW', capture: { shown: 'the reflected value' } },
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
    assert.deepEqual(action, { kind: 'navigate', to: 'cart?x=1' });
  });

  it('rend le chemin relatif à la base, préfixe de montage conservé', async () => {
    // Une application servie sous « /ecole/ » perdait son préfixe : un chemin
    // absolu écrase le préfixe au rejeu, où que la base soit montée.
    const result = await generateResolution({
      scenario: scenarioNav,
      driver: new NavigatingDriver(),
      provider: new NavigateProvider('http://127.0.0.1:8940/ecole/eleves'),
      baseUrl: 'http://127.0.0.1:8940/ecole',
    });
    const action = result.resolution?.steps['s1']?.actions[0];
    assert.deepEqual(action, { kind: 'navigate', to: 'eleves' });
    // La forme versionnée doit rejouer sous une AUTRE base.
    assert.equal(new URL('eleves', 'https://staging.example/ecole/').href, 'https://staging.example/ecole/eleves');
  });

  it('signale une navigation absolue sauvée sans baseUrl', async () => {
    // generateResolution est exporté : un harnais qui omet baseUrl n'obtient
    // aucune relativisation. Se taire lui livrerait une résolution liée à sa
    // machine sans qu'il l'apprenne.
    const result = await generateResolution({
      scenario: scenarioNav,
      driver: new NavigatingDriver(),
      provider: new NavigateProvider('http://127.0.0.1:8940/cart'),
    });
    const rejets = result.steps.find((s) => s.stepId === 's1')?.rejections ?? [];
    assert.ok(rejets.some((r) => r.includes('pass baseUrl')), JSON.stringify(rejets));
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

/**
 * Les deux garde-fous que la revue a réclamés : une variable que l'intention
 * ne nomme pas est refusée AVANT d'être saisie, et un fournisseur qui lève
 * consomme une tentative au lieu d'abandonner tous les scénarios restants.
 */
class ThrowingProvider implements ModelProvider {
  readonly name = 'throwing';
  calls = 0;
  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    throw new Error('réponse tronquée : augmente maxOutputTokens');
  }
}

class EnvProvider implements ModelProvider {
  readonly name = 'env';
  async complete(): Promise<ModelResponse> {
    return {
      output: {
        actions: [{ kind: 'fill', target: { primary: { role: 'textbox' } }, value: '{{env.QAI_USER}}' }],
        captures: {},
        assertions: {},
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

describe('garde-fous de génération', () => {
  it('refuse {{env.X}} quand l\'intention ne nomme pas la variable', async () => {
    // Le cas silencieux est le pire : si QAI_USER existe, l'identifiant est
    // saisi dans le champ adresse sans erreur ET masqué en *** au rapport.
    process.env['QAI_USER'] = 'alice@example.test';
    try {
      const result = await generateResolution({
        scenario: {
          id: 'addr',
          title: 'Adresse',
          steps: [{ id: 's1', do: 'fill in the address with the client-fr data set' }],
        },
        driver: new NavigatingDriver(),
        provider: new EnvProvider(),
        attemptsPerStep: 2,
      });

      assert.equal(result.status, 'incomplete');
      const rejets = result.steps.find((s) => s.stepId === 's1')?.rejections ?? [];
      assert.ok(
        rejets.some((r) => r.includes('does not name this variable')),
        JSON.stringify(rejets),
      );
    } finally {
      delete process.env['QAI_USER'];
    }
  });

  it('traite une exception du fournisseur comme un rejet, sans tout abandonner', async () => {
    // Un fournisseur sans décodage contraint lève ici — JSON.parse échoue chez
    // lui — et c'est son mode de panne NORMAL. Laisser filer l'exception
    // abandonnait la génération de tous les scénarios restants.
    const provider = new ThrowingProvider();
    const result = await generateResolution({
      scenario: { id: 'th', title: 'Throw', steps: [{ id: 's1', do: 'open' }] },
      driver: new NavigatingDriver(),
      provider,
      attemptsPerStep: 3,
    });

    assert.equal(result.status, 'incomplete');
    assert.equal(provider.calls, 3, 'chaque tentative doit être consommée');
    const rejets = result.steps.find((s) => s.stepId === 's1')?.rejections ?? [];
    assert.ok(rejets.some((r) => r.includes('tronquée')), JSON.stringify(rejets));
  });
});
