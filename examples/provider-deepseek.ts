import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Pricing,
} from '../src/model/types.ts';

/**
 * Fournisseur DeepSeek, prêt à l'emploi — et sans SDK : l'API REST suffit.
 *
 *   export DEEPSEEK_API_KEY=…
 *   npm run qai -- resolve qa/parcours.qai.yaml --base-url $URL \
 *     --provider ./examples/provider-deepseek.ts --max-cost 2
 *
 * Ce fichier est un **exemple**, pas une dépendance de QAI : le paquet publié
 * n'embarque aucun SDK de fournisseur.
 *
 * Il est surtout la démonstration que le contrat tient face à un fournisseur
 * qui ne sait PAS décoder sous contrainte de schéma. L'API DeepSeek est
 * compatible OpenAI mais n'offre qu'un mode JSON — « réponds par du JSON »,
 * sans garantie de forme. Le schéma part donc dans le message système, et la
 * conformité est vérifiée en aval : `asProposal` rejette une réponse mal
 * formée, et la boucle de génération la renvoie au modèle avec son erreur.
 * C'est ce qui rend QAI branchable sur n'importe quel modèle capable
 * d'émettre du JSON, pas seulement sur ceux à sortie contrainte.
 */

const MODEL = process.env['QAI_MODEL'] ?? 'deepseek-chat';

/**
 * Tarif en dollars par million de jetons.
 *
 * DeepSeek facture l'entrée moins cher quand elle sort de son cache — le
 * message système de QAI étant stable d'un appel à l'autre, ce cas est le
 * normal, pas l'exception. Vérifiez les tarifs courants avant de vous fier au
 * plafond : ils bougent.
 */
const PRICES: Record<string, Pricing> = {
  'deepseek-chat': { inputPerMTok: 0.27, outputPerMTok: 1.1, cachedInputPerMTok: 0.07 },
  'deepseek-reasoner': { inputPerMTok: 0.55, outputPerMTok: 2.19, cachedInputPerMTok: 0.14 },
};

export const pricing: Pricing = PRICES[MODEL] ?? {
  inputPerMTok: 0.27,
  outputPerMTok: 1.1,
  cachedInputPerMTok: 0.07,
};

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

function apiKey(): string {
  const key = process.env['DEEPSEEK_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error('DEEPSEEK_API_KEY est absente de l’environnement');
  }
  return key;
}

function textOf(message: ModelMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      // Le repli vision n'a de sens que sur mobile ; le web passe par l'arbre
      // d'accessibilité. Échouer ici est plus honnête que d'ignorer l'image et
      // de laisser le modèle répondre à côté.
      throw new Error('deepseek-chat ne lit pas les images : fournisseur textuel uniquement');
    })
    .join('\n');
}

export default {
  name: MODEL,

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Le mode JSON de DeepSeek exige le mot « json » dans le prompt, et ne
    // garantit aucune forme : le schéma doit donc y figurer en toutes lettres.
    const system = [
      request.system,
      '',
      'Answer with a single json object, and nothing else — no prose, no code fence.',
      'It must conform to this JSON Schema:',
      JSON.stringify(request.responseSchema),
    ].join('\n');

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          ...request.messages.map((message) => ({
            role: message.role,
            content: textOf(message),
          })),
        ],
        max_tokens: request.maxOutputTokens ?? 4096,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`DeepSeek ${response.status} : ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
      };
    };

    const choice = body.choices?.[0];
    if (choice === undefined) throw new Error('réponse sans choix');
    if (choice.finish_reason === 'length') {
      // Un JSON tronqué casserait au parse avec un message illisible ; le dire
      // ici désigne le vrai remède, qui est d'augmenter maxOutputTokens.
      throw new Error('réponse tronquée : augmente maxOutputTokens');
    }

    const text = choice.message?.content;
    if (text === undefined || text === '') throw new Error('réponse sans contenu textuel');

    const meta = body.usage;
    const usage: ModelResponse['usage'] = {
      inputTokens: meta?.prompt_tokens ?? 0,
      outputTokens: meta?.completion_tokens ?? 0,
      cachedInputTokens: meta?.prompt_cache_hit_tokens ?? undefined,
    };

    return { output: JSON.parse(text) as unknown, usage };
  },
} satisfies ModelProvider;
