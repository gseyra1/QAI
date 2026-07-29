import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetedProvider, BudgetExceededError } from './budget.ts';
import type { ModelProvider, ModelRequest, ModelResponse, ModelUsage, Pricing } from './types.ts';
import { costOf } from './types.ts';

/** Tarif fictif, choisi pour que les calculs se vérifient de tête. */
const PRICING: Pricing = { inputPerMTok: 10, outputPerMTok: 100, cachedInputPerMTok: 1 };

class StubProvider implements ModelProvider {
  readonly name = 'stub';
  calls = 0;

  readonly #usage: ModelUsage;

  constructor(usage: ModelUsage) {
    this.#usage = usage;
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return { output: { ok: true }, usage: this.#usage };
  }
}

const REQUEST: ModelRequest = {
  system: 's',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  responseSchema: { type: 'object' },
};

describe('costOf', () => {
  it('facture entrée et sortie séparément', () => {
    assert.equal(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, PRICING), 10);
    assert.equal(costOf({ inputTokens: 0, outputTokens: 1_000_000 }, PRICING), 100);
  });

  it('applique le tarif réduit à la portion mise en cache', () => {
    const cost = costOf(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
      PRICING,
    );
    // 100k frais à 10 + 900k en cache à 1 = 1 + 0,9
    assert.equal(Number(cost.toFixed(6)), 1.9);
  });

  it('retombe sur un dixième du tarif d\'entrée quand le cache n\'est pas tarifé', () => {
    const cost = costOf(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
      { inputPerMTok: 10, outputPerMTok: 100 },
    );
    assert.equal(cost, 1);
  });
});

describe('BudgetedProvider', () => {
  it('laisse passer tant que le plafond n\'est pas atteint', async () => {
    const stub = new StubProvider({ inputTokens: 1000, outputTokens: 100 });
    const provider = new BudgetedProvider(stub, PRICING, { maxCalls: 3 });

    await provider.complete(REQUEST);
    await provider.complete(REQUEST);

    assert.equal(stub.calls, 2);
    assert.equal(provider.spend.calls, 2);
  });

  it('coupe au nombre d\'appels', async () => {
    const stub = new StubProvider({ inputTokens: 10, outputTokens: 10 });
    const provider = new BudgetedProvider(stub, PRICING, { maxCalls: 2 });

    await provider.complete(REQUEST);
    await provider.complete(REQUEST);
    await assert.rejects(
      () => provider.complete(REQUEST),
      (error: unknown) => error instanceof BudgetExceededError && error.limit === 'maxCalls',
    );
    assert.equal(stub.calls, 2, 'le troisième appel ne doit pas atteindre le fournisseur');
  });

  it('coupe au coût', async () => {
    const stub = new StubProvider({ inputTokens: 100_000, outputTokens: 10_000 });
    const provider = new BudgetedProvider(stub, PRICING, { maxCost: 1 });

    // 100k × 10/M + 10k × 100/M = 1,0 + 1,0 = 2,0 → plafond franchi d'un appel
    await provider.complete(REQUEST);
    assert.ok(provider.spend.cost >= 1);

    await assert.rejects(
      () => provider.complete(REQUEST),
      (error: unknown) => error instanceof BudgetExceededError && error.limit === 'maxCost',
    );
  });

  it('cumule la dépense, cache compris', async () => {
    const stub = new StubProvider({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800 });
    const provider = new BudgetedProvider(stub, PRICING, {});

    await provider.complete(REQUEST);
    await provider.complete(REQUEST);

    assert.deepEqual(
      { ...provider.spend, cost: Number(provider.spend.cost.toFixed(6)) },
      {
        calls: 2,
        inputTokens: 2000,
        outputTokens: 100,
        cachedInputTokens: 1600,
        cost: Number(((2 * (200 * 10 + 800 * 1 + 50 * 100)) / 1_000_000).toFixed(6)),
      },
    );
  });

  it('conserve le nom du fournisseur enveloppé', () => {
    const provider = new BudgetedProvider(new StubProvider({ inputTokens: 0, outputTokens: 0 }), PRICING, {});
    assert.equal(provider.name, 'stub');
  });
});
