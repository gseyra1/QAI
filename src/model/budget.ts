import type { ModelProvider, ModelRequest, ModelResponse, ModelUsage, Pricing } from './types.ts';
import { costOf } from './types.ts';

export interface Budget {
  /** Plafond de dépense, dans l'unité monétaire du tarif fourni. */
  maxCost?: number;
  maxCalls?: number;
  maxInputTokens?: number;
}

export interface Spend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
}

export class BudgetExceededError extends Error {
  readonly spend: Spend;
  readonly limit: keyof Budget;

  constructor(limit: keyof Budget, spend: Spend) {
    super(`budget épuisé (${limit}) — ${spend.calls} appels, coût ${spend.cost.toFixed(4)}`);
    this.name = 'BudgetExceededError';
    this.limit = limit;
    this.spend = spend;
  }
}

/**
 * Enveloppe n'importe quel fournisseur d'un plafond.
 *
 * Le contrôle a lieu **avant** chaque appel, sur la dépense déjà constatée :
 * le coût d'un appel n'étant connu qu'après coup, le plafond peut être dépassé
 * d'un appel au plus. C'est le comportement voulu — refuser d'agir tant qu'on
 * ne peut pas prédire le coût bloquerait le produit.
 */
export class BudgetedProvider implements ModelProvider {
  readonly name: string;

  readonly #inner: ModelProvider;
  readonly #pricing: Pricing;
  readonly #budget: Budget;
  readonly #spend: Spend = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
  };

  constructor(inner: ModelProvider, pricing: Pricing, budget: Budget) {
    this.#inner = inner;
    this.#pricing = pricing;
    this.#budget = budget;
    this.name = inner.name;
  }

  get spend(): Readonly<Spend> {
    return { ...this.#spend };
  }

  #check(): void {
    const { maxCalls, maxCost, maxInputTokens } = this.#budget;
    if (maxCalls !== undefined && this.#spend.calls >= maxCalls) {
      throw new BudgetExceededError('maxCalls', this.spend);
    }
    if (maxCost !== undefined && this.#spend.cost >= maxCost) {
      throw new BudgetExceededError('maxCost', this.spend);
    }
    if (maxInputTokens !== undefined && this.#spend.inputTokens >= maxInputTokens) {
      throw new BudgetExceededError('maxInputTokens', this.spend);
    }
  }

  #accumulate(usage: ModelUsage): void {
    this.#spend.calls += 1;
    this.#spend.inputTokens += usage.inputTokens;
    this.#spend.outputTokens += usage.outputTokens;
    this.#spend.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.#spend.cost += costOf(usage, this.#pricing);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.#check();
    const response = await this.#inner.complete(request);
    this.#accumulate(response.usage);
    return response;
  }
}
