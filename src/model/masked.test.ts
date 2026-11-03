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
    const masked = maskedProvider(provider, (text) => text.replaceAll('zzz', '[secret]'));
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
        { role: 'user', content: [{ type: 'text', text: 'a [secret] b' }] },
        { role: 'assistant', content: [{ type: 'text', text: '[secret]' }] },
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

/** Rend les réponses dans l'ordre ; un appel de trop fait échouer le test. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  readonly #outputs: unknown[];

  constructor(outputs: unknown[]) {
    this.#outputs = outputs;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const output = this.#outputs[this.requests.length - 1];
    assert.ok(output !== undefined, `réponse ${this.requests.length} non scénarisée`);
    return { output, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const textbox = { primary: { role: 'textbox' } };

describe('le masque ne remplace pas la valeur', () => {
  it('refuse un [secret] recopié dans une saisie', async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'fill', target: textbox, value: '[secret]' }], captures: {}, assertions: {} },
      { actions: [{ kind: 'fill', target: textbox, value: '{{env.QAI_MASK_PW}}' }], captures: {}, assertions: {} },
    ]);
    const result = await withSecret(() =>
      generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'se connecter avec QAI_MASK_PW' }] },
        driver: new ExposingDriver(SECRET),
        provider,
      }),
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.ok(result.steps[0]?.rejections.some((r) => r.includes('never copy it')));
    assert.ok(!JSON.stringify(result.resolution).includes('[secret]'));
  });

  it('refuse un [secret] recopié dans une adresse, sans rien écrire', async () => {
    const copied = { actions: [{ kind: 'navigate', to: '/compte?jeton=[secret]' }], captures: {}, assertions: {} };
    const result = await withSecret(() =>
      generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'rouvrir le compte avec QAI_MASK_PW' }] },
        driver: new ExposingDriver(SECRET),
        provider: new ScriptedProvider([copied, copied]),
        attemptsPerStep: 2,
      }),
    );
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.resolution.steps, {});
  });

  it('refuse un [secret] recopié dans une vérification', async () => {
    const proposal = (value: string): unknown => ({
      captures: {},
      assertions: { 'le bandeau est là': { check: 'textContains', target: { role: 'text' }, value } },
    });
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'click', target: textbox }], ...(proposal('Connecté : [secret]') as object) },
      proposal('Connecté'),
    ]);
    const result = await withSecret(() =>
      generateResolution({
        scenario: {
          id: 'm',
          title: 't',
          steps: [{ id: 's1', do: 'continuer avec QAI_MASK_PW', expect: 'le bandeau est là' }],
        },
        driver: new ExposingDriver(SECRET),
        provider,
      }),
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.ok(result.steps[0]?.rejections.some((r) => r.includes('never copy it')));
  });

  it('refuse le masque même quand l\'écran affiche de vraies étoiles', async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'fill', target: textbox, value: '[secret]' }], captures: {}, assertions: {} },
      { actions: [{ kind: 'fill', target: textbox, value: '{{env.QAI_MASK_PW}}' }], captures: {}, assertions: {} },
    ]);
    const result = await withSecret(() =>
      generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'se connecter avec QAI_MASK_PW' }] },
        driver: new ExposingDriver('Carte **** 4242'),
        provider,
      }),
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    assert.ok(result.steps[0]?.rejections.some((r) => r.includes('never copy it')));
  });

  it("n'oppose rien à des étoiles écrites par l'auteur", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'fill', target: textbox, value: '***' }], captures: {}, assertions: {} },
    ]);
    const result = await withSecret(() =>
      generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'saisir *** avec QAI_MASK_PW' }] },
        driver: new ExposingDriver(),
        provider,
      }),
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
  });

  it('ne touche à rien quand aucun secret n\'est connu', async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'fill', target: textbox, value: '[secret]' }], captures: {}, assertions: {} },
    ]);
    const result = await generateResolution({
      scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'recopier' }] },
      driver: new ExposingDriver(),
      provider,
    });
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
  });
});

describe("ce que l'auteur a écrit", () => {
  const value = 'admin@acme.test';

  it("garde le nom d'une capture, qu'une variable peut valoir", async () => {
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: textbox }],
        captures: { reference: { from: { role: 'text' }, extract: 'text' } },
        assertions: {},
      },
      { captures: { reference: { from: { role: 'text' }, extract: 'text' } }, assertions: {} },
    ]);
    const result = await withSecret(
      () =>
        generateResolution({
          scenario: {
            id: 'm',
            title: 't',
            steps: [{ id: 's1', do: 'continuer avec QAI_MASK_PW', capture: { reference: 'la référence' } }],
          },
          driver: new ExposingDriver(),
          provider,
        }),
      'reference',
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
  });

  it('revient mot pour mot quand une attente nomme la valeur', async () => {
    const key = `le bandeau affiche ${value}`;
    const provider = new ScriptedProvider([
      {
        actions: [{ kind: 'click', target: textbox }],
        captures: {},
        assertions: { [key]: { check: 'textContains', target: { role: 'text' }, value } },
      },
    ]);
    const result = await withSecret(
      () =>
        generateResolution({
          scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'continuer avec QAI_MASK_PW', expect: key }] },
          driver: new ExposingDriver(value),
          provider,
        }),
      value,
    );
    assert.equal(result.status, 'complete', JSON.stringify(result.steps));
    const sent = JSON.stringify(provider.requests[0]?.messages);
    assert.ok(sent.includes(key), 'the expectation goes as written');
    assert.ok(sent.includes('Connecté : [secret]'), 'the screen stays masked');
  });

  it("garde dans l'intention la valeur qu'elle donne à saisir", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'fill', target: textbox, value: '3000' }], captures: {}, assertions: {} },
    ]);
    process.env['QAI_PORT'] = '3000';
    try {
      const result = await generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'saisir 3000 dans le champ QAI_PORT' }] },
        driver: new ExposingDriver(),
        provider,
      });
      assert.equal(result.status, 'complete', JSON.stringify(result.steps));
      assert.ok(JSON.stringify(provider.requests[0]?.messages).includes('saisir 3000'));
    } finally {
      delete process.env['QAI_PORT'];
    }
  });
});

describe('les variables connues avant le premier écran', () => {
  const click = { actions: [{ kind: 'click', target: textbox }], captures: {}, assertions: {} };

  it("ne lit pas un sigle comme une variable", async () => {
    const provider = new ScriptedProvider([click]);
    process.env['QAI'] = 'valeur-publique';
    try {
      await generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'ouvrir le tableau QAI' }] },
        driver: new ExposingDriver('valeur-publique'),
        provider,
      });
    } finally {
      delete process.env['QAI'];
    }
    assert.ok(JSON.stringify(provider.requests[0]?.messages).includes('valeur-publique'));
  });

  it("n'en déduit rien d'une étiquette ou du titre", async () => {
    const provider = new ScriptedProvider([click]);
    await withSecret(() =>
      generateResolution({
        scenario: { id: 'm', title: 'QAI_MASK_PW', tags: ['QAI_MASK_PW'], steps: [{ id: 's1', do: 'continuer' }] },
        driver: new ExposingDriver('valeur-publique'),
        provider,
      }),
    'valeur-publique');
    assert.ok(JSON.stringify(provider.requests[0]?.messages).includes('valeur-publique'));
  });

  it('lit une intention sur plusieurs lignes', async () => {
    const provider = new ScriptedProvider([click]);
    await withSecret(() =>
      generateResolution({
        scenario: { id: 'm', title: 't', steps: [{ id: 's1', do: 'se connecter avec\nQAI_MASK_PW' }] },
        driver: new ExposingDriver(SECRET),
        provider,
      }),
    );
    assertNothingLeaked(provider.requests);
  });

  it('masque la variable seule quand la saisie la compose', async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: 'fill', target: textbox, value: 'Bearer {{env.qai_tok}}' }], captures: {}, assertions: {} },
      click,
    ]);
    process.env['qai_tok'] = SECRET;
    try {
      await generateResolution({
        scenario: {
          id: 'm',
          title: 't',
          steps: [{ id: 's1', do: 'saisir qai_tok' }, { id: 's2', do: 'continuer' }],
        },
        driver: new BareValueDriver(),
        provider,
      });
    } finally {
      delete process.env['qai_tok'];
    }
    assertNothingLeaked(provider.requests);
  });
});

/** Réaffiche ce qui suit « Bearer », sans le préfixe. */
class BareValueDriver extends ExposingDriver {
  override async act(action: Action): Promise<void> {
    await super.act(action.kind === 'fill' ? { ...action, value: action.value.replace('Bearer ', '') } : action);
  }
}

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
