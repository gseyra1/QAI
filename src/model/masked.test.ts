import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Action,
  Driver,
  ObserveOptions,
  ResolveOutcome,
  ResolvedTarget,
  UINode,
  UISnapshot,
} from '../driver/types.ts';
import { node } from '../engine/fixtures.ts';
// Confronté au schéma publié à chaque appel : voir conformance.ts.
import { generateResolution } from '../generate/conformance.ts';
import { runScenario } from '../engine/run.ts';
import { ModelHealer } from '../heal/ModelHealer.ts';
import type { Resolution } from '../resolution/types.ts';
import type { Scenario } from '../scenario/types.ts';
import { maskedProvider } from './masked.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from './types.ts';

// Des caractères que l'adresse encode : la forme en clair n'y figure jamais.
const SECRET = 's3cr3t/TOKEN@abc 123';
const ENCODED = encodeURIComponent(SECRET);

function assertNothingLeaked(requests: ModelRequest[]): void {
  const sent = JSON.stringify(requests);
  assert.ok(requests.length > 0, 'no request reached the provider');
  assert.ok(!sent.includes(SECRET), `secret sent as typed: ${sent}`);
  assert.ok(!sent.includes(ENCODED), `secret sent URL-encoded: ${sent}`);
}

/** L'application réaffiche la saisie : dans un champ, un bandeau et l'adresse. */
class ExposingDriver implements Driver {
  readonly platform = 'web' as const;
  readonly capabilities = { hover: true, swipe: false, navigateByUrl: true, deepLink: false };
  #typed: string;

  constructor(shown = '') {
    this.#typed = shown;
  }

  async launch(): Promise<void> {}
  async applyState(): Promise<void> {}
  async dispose(): Promise<void> {}
  async settle(): Promise<void> {}

  async observe(_options?: ObserveOptions): Promise<UISnapshot> {
    const field = { ...node('textbox', 'Jeton'), value: this.#typed };
    const root = node('group', 'page', [field, node('text', `Connecté : ${this.#typed}`)]);
    return {
      platform: 'web',
      at: '',
      location: `https://app.test/compte?jeton=${encodeURIComponent(this.#typed)}`,
      viewport: { x: 0, y: 0, width: 800, height: 600 },
      root,
    };
  }

  async act(action: Action): Promise<void> {
    if (action.kind === 'fill') this.#typed = action.value;
  }

  async resolve(): Promise<ResolveOutcome> {
    return { found: true, node: node('textbox', 'Jeton'), usedFallback: false };
  }
}

/** Saisit, capture la valeur réaffichée, puis se trompe une fois : il y a un retour. */
class RecordingProvider implements ModelProvider {
  readonly name = 'recording';
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const last = request.messages.at(-1)?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    const target = { primary: { role: 'textbox' } };
    let output: unknown;
    if (last.includes('Intent: se connecter')) {
      output = {
        actions: [{ kind: 'fill', target, value: '{{env.QAI_MASK_PW}}' }],
        captures: { lu: { from: { role: 'text' }, extract: 'text' } },
        assertions: {},
      };
    } else if (last.includes('Intent: relire')) {
      output = {
        actions: [{ kind: 'click', target }],
        captures: {},
        assertions: { 'le bandeau est là': { check: 'textEquals', target: { role: 'text' }, value: 'faux' } },
      };
    } else {
      output = {
        actions: [{ kind: 'click', target }],
        captures: {},
        assertions: { 'le bandeau est là': { check: 'visible', target: { role: 'text' } } },
      };
    }
    return { output, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const scenario: Scenario = {
  id: 'fuite',
  title: 'Ce qui part chez le fournisseur',
  steps: [
    { id: 's1', do: 'se connecter avec QAI_MASK_PW', capture: { lu: 'la valeur affichée' } },
    { id: 's2', do: 'relire le bandeau', expect: 'le bandeau est là' },
  ],
};

async function withSecret<T>(run: () => Promise<T>, value = SECRET): Promise<T> {
  process.env['QAI_MASK_PW'] = value;
  try {
    return await run();
  } finally {
    delete process.env['QAI_MASK_PW'];
  }
}

describe('maskedProvider', () => {
  it('masque chaque texte, sans toucher au reste de la requête', async () => {
    const provider = new RecordingProvider();
    const masked = maskedProvider(provider, (text) => text.replaceAll('zzz', '***'));
    assert.equal(masked.name, 'recording');
    await masked.complete({
      system: 'consigne',
      responseSchema: { type: 'object' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a zzz b' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'zzz' }] },
      ],
    });
    assert.deepEqual(provider.requests[0], {
      system: 'consigne',
      responseSchema: { type: 'object' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a *** b' }] },
        { role: 'assistant', content: [{ type: 'text', text: '***' }] },
      ],
    });
  });
});

describe('ce que la génération envoie au fournisseur', () => {
  it("ne porte le secret ni dans l'arbre, ni dans l'adresse, ni dans les captures", async () => {
    const provider = new RecordingProvider();
    const result = await withSecret(() =>
      generateResolution({ scenario, driver: new ExposingDriver(), provider, attemptsPerStep: 3 }),
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.ok(provider.requests.length >= 4, 'the retry path must have been taken');
    assertNothingLeaked(provider.requests);
  });

  it('masque dès le premier écran une variable que le scénario nomme', async () => {
    // Le compte déjà affiché au chargement : rien n'a encore été saisi.
    const provider = new RecordingProvider();
    await withSecret(() =>
      generateResolution({ scenario, driver: new ExposingDriver(SECRET), provider, attemptsPerStep: 3 }),
    );
    assertNothingLeaked(provider.requests);
  });

  it('avertit quand la valeur saisie est trop courte pour être masquée', async () => {
    const result = await withSecret(
      () => generateResolution({ scenario, driver: new ExposingDriver(), provider: new RecordingProvider(), attemptsPerStep: 3 }),
      'ab',
    );
    const warnings = result.steps.find((step) => step.stepId === 's1')?.warnings ?? [];
    assert.ok(warnings.some((w) => w.includes('too short')), JSON.stringify(warnings));
  });
});

/** La cible perdue déclenche le réparateur, sur un écran qui expose le secret. */
class LostTargetDriver extends ExposingDriver {
  override async resolve(target?: ResolvedTarget): Promise<ResolveOutcome> {
    if (target?.primary.name === 'Disparu') return { found: false, reason: 'no-match', matches: 0 };
    return super.resolve();
  }
}

class HealProvider implements ModelProvider {
  readonly name = 'heal';
  readonly requests: ModelRequest[] = [];
  #turn = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    this.#turn += 1;
    // Refusé au premier tour : la raison repart dans la conversation.
    const target = this.#turn === 1 ? { primary: { role: 'link', name: 'Disparu' } } : { primary: { role: 'textbox' } };
    return { output: { target, note: 'le libellé a changé' }, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const lost: ResolvedTarget = { primary: { role: 'button', name: 'Disparu' } };

function resolution(steps: Resolution['steps']): Resolution {
  return { scenario: 'fuite', platform: 'web', recordedAt: '2026-11-03T00:00:00Z', steps };
}

describe('ce que la réparation envoie au fournisseur', () => {
  it("ne porte pas un secret saisi plus tôt, ni sur l'écran ni dans l'adresse", async () => {
    const provider = new HealProvider();
    const report = await withSecret(() => {
      const driver = new LostTargetDriver();
      return runScenario({
        scenario: { ...scenario, steps: [{ id: 's1', do: 'se connecter' }, { id: 's2', do: 'continuer' }] },
        resolution: resolution({
          s1: { actions: [{ kind: 'fill', target: { primary: { role: 'textbox' } }, value: '{{env.QAI_MASK_PW}}' }] },
          s2: { actions: [{ kind: 'click', target: lost }] },
        }),
        driver,
        healer: new ModelHealer({ driver, provider }),
      });
    });
    assert.equal(report.healCount, 1, JSON.stringify(report.steps));
    assertNothingLeaked(provider.requests);
  });

  it("ne porte pas un secret affiché avant l'étape qui le saisit", async () => {
    const provider = new HealProvider();
    await withSecret(() => {
      const driver = new LostTargetDriver(SECRET);
      return runScenario({
        scenario: { ...scenario, steps: [{ id: 's1', do: 'continuer' }, { id: 's2', do: 'se connecter' }] },
        resolution: resolution({
          s1: { actions: [{ kind: 'click', target: lost }] },
          s2: { actions: [{ kind: 'fill', target: { primary: { role: 'textbox' } }, value: '{{env.QAI_MASK_PW}}' }] },
        }),
        driver,
        healer: new ModelHealer({ driver, provider }),
      });
    });
    assertNothingLeaked(provider.requests);
  });
});
