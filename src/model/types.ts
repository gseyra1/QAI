/**
 * Le contrat de modèle.
 *
 * QAI ne dépend d'aucun SDK de fournisseur : l'utilisateur implémente cette
 * interface avec le modèle de son choix — Claude, un modèle local, un service
 * interne — et l'injecte. Rien au-dessus ne sait quel modèle tourne.
 */

export type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png'; data: Uint8Array };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelContent[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Portion de l'entrée servie par un cache de prompt, facturée moins cher.
   *
   * `| undefined` est explicite : cette interface est implémentée par des tiers,
   * qui transmettront souvent une valeur éventuellement absente venue de leur
   * SDK. Leur imposer une gymnastique de typage sur un champ facultatif serait
   * une friction gratuite à l'intégration.
   */
  cachedInputTokens?: number | undefined;
}

export interface ModelRequest {
  /** Stable d'un appel à l'autre : c'est ce qui rend le cache de prompt utile. */
  system: string;
  messages: ModelMessage[];
  /**
   * Schéma JSON auquel la réponse doit se conformer.
   *
   * QAI ne lit jamais de prose : il demande un objet. C'est cette contrainte
   * qui rend les fournisseurs interchangeables — n'importe quel modèle capable
   * de sortie structurée convient, sans une ligne de code à changer.
   */
  responseSchema: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface ModelResponse {
  /** Objet conforme à `responseSchema`. Sa validation incombe au fournisseur. */
  output: unknown;
  /**
   * Obligatoire, pas optionnel : la maîtrise des coûts est une contrainte de
   * survie du produit, donc un fournisseur qui ne sait pas compter ses jetons
   * ne peut pas être branché.
   */
  usage: ModelUsage;
}

export interface ModelProvider {
  /** Identifiant lisible, repris dans les rapports et les diffs de résolution. */
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Tarif du modèle branché, en unité monétaire par million de jetons. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Défaut : un dixième du tarif d'entrée, ordre de grandeur usuel. */
  cachedInputPerMTok?: number;
}

export function costOf(usage: ModelUsage, pricing: Pricing): number {
  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok / 10;

  return (
    (fresh * pricing.inputPerMTok +
      cached * cachedRate +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}
