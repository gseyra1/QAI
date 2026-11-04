import type { ModelMessage, ModelProvider, ModelRequest } from './types.ts';

function masked(message: ModelMessage, redact: (text: string) => string): ModelMessage {
  return {
    role: message.role,
    content: message.content.map((part) =>
      // Un écho de `JSON.stringify(undefined)` : une réponse vide ne doit pas
      // transformer un rejet ordinaire en panne de chaque tour suivant.
      part.type === 'text' && typeof part.text === 'string' ? { type: 'text', text: redact(part.text) } : part,
    ),
  };
}

/**
 * Le fournisseur tel que le voient la génération et la réparation.
 *
 * Un fournisseur est un tiers. Masquer à chaque point d'appel reviendrait à
 * refaire le travail à chaque nouveau message, et l'oubli ne se verrait pas :
 * les rejets étaient masqués, l'arbre de l'écran, l'adresse et les captures ne
 * l'étaient pas. Tout passe ici, y compris ce qui sera ajouté demain.
 *
 * `system` et `responseSchema` sont des constantes sans donnée d'exécution. Une
 * image ne se masque pas : ni la génération ni la réparation n'en envoient, et
 * en envoyer une demanderait d'abord de répondre à cette question.
 */
export function maskedProvider(provider: ModelProvider, redact: (text: string) => string): ModelProvider {
  return {
    name: provider.name,
    complete: (request: ModelRequest) =>
      provider.complete({
        ...request,
        messages: request.messages.map((message) => masked(message, redact)),
      }),
  };
}
