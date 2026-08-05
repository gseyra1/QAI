import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Pricing,
} from '../src/model/types.ts';

/**
 * Fournisseur Claude, prêt à l'emploi.
 *
 *   export ANTHROPIC_API_KEY=…
 *   npm run qai -- resolve qa/parcours.qai.yaml --base-url $URL \
 *     --provider ./examples/provider-claude.ts --max-cost 2
 *
 * Ce fichier est un **exemple**, pas une dépendance de QAI : le paquet publié
 * n'embarque aucun SDK de fournisseur. Copiez-le, changez le modèle, ou
 * réécrivez-le pour le vôtre.
 */

const MODEL = process.env['QAI_MODEL'] ?? 'claude-sonnet-5';

/** Tarif du modèle choisi, en dollars par million de jetons. */
const PRICES: Record<string, Pricing> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

export const pricing: Pricing = PRICES[MODEL] ?? { inputPerMTok: 3, outputPerMTok: 15 };

const client = new Anthropic();

function toAnthropic(message: ModelMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map((block) =>
      block.type === 'text'
        ? { type: 'text' as const, text: block.text }
        : {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: block.mediaType,
              data: Buffer.from(block.data).toString('base64'),
            },
          },
    ),
  };
}

export default {
  name: MODEL,

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: request.maxOutputTokens ?? 4096,
      system: request.system,
      messages: request.messages.map(toAnthropic),
      // La sortie contrainte par schéma est ce que QAI exige : il ne lit jamais
      // de prose, donc une réponse hors schéma doit échouer ici, pas six étapes
      // plus loin.
      output_config: { format: { type: 'json_schema', schema: request.responseSchema } },
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('le modèle a refusé la requête');
    }

    const text = response.content.find((block) => block.type === 'text');
    if (text === undefined) throw new Error('réponse sans contenu textuel');

    const usage: ModelResponse['usage'] = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? undefined,
    };

    return { output: JSON.parse(text.text) as unknown, usage };
  },
} satisfies ModelProvider;
