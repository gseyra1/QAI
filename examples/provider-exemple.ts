import type { ModelProvider, ModelRequest, ModelResponse, Pricing } from '../src/model/types.ts';

/**
 * Squelette de fournisseur de modèle.
 *
 * Copiez ce fichier, remplacez `appelerVotreModele` par l'appel à votre modèle,
 * puis lancez :
 *
 *   npm run qai -- resolve mon-parcours.qai.yaml \
 *     --base-url http://localhost:3000 \
 *     --provider ./mon-fournisseur.ts \
 *     --max-cost 2
 *
 * Deux obligations, et une seule vraiment contraignante :
 *
 * 1. Rendre un **objet conforme à `request.responseSchema`**, jamais du texte.
 *    Si votre modèle propose un mode « sortie structurée » ou « appel d'outil »,
 *    passez-lui le schéma tel quel — c'est ce qui rend les modèles
 *    interchangeables. À défaut, demandez du JSON dans le prompt et validez
 *    avant de rendre.
 * 2. Renseigner `usage`. Sans décompte de jetons, aucun plafond n'est possible,
 *    et la maîtrise des coûts est une contrainte de survie du produit.
 */
export default {
  name: 'mon-modele',

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const reponse = await appelerVotreModele({
      system: request.system,
      messages: request.messages,
      schema: request.responseSchema,
      maxTokens: request.maxOutputTokens ?? 2048,
    });

    return {
      output: reponse.objet,
      usage: {
        inputTokens: reponse.jetonsEntree,
        outputTokens: reponse.jetonsSortie,
        cachedInputTokens: reponse.jetonsEnCache,
      },
    };
  },
} satisfies ModelProvider;

/** Le tarif de votre modèle, en unité monétaire par million de jetons. */
export const pricing: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

declare function appelerVotreModele(options: {
  system: string;
  messages: ModelRequest['messages'];
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<{
  objet: unknown;
  jetonsEntree: number;
  jetonsSortie: number;
  jetonsEnCache?: number;
}>;
