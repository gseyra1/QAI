import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Pricing,
} from '../src/model/types.ts';

/**
 * Fournisseur Gemini, prêt à l'emploi — et sans SDK : l'API REST suffit.
 *
 *   export GEMINI_API_KEY=…
 *   npm run qai -- resolve qa/parcours.qai.yaml --base-url $URL \
 *     --provider ./examples/provider-gemini.ts --max-cost 2
 *
 * Ce fichier est un **exemple**, pas une dépendance de QAI : le paquet publié
 * n'embarque aucun SDK de fournisseur. Copiez-le, changez le modèle, ou
 * réécrivez-le pour le vôtre.
 */

const MODEL = process.env['QAI_MODEL'] ?? 'gemini-3.6-flash';

/** Tarif du modèle choisi, en dollars par million de jetons (août 2026). */
const PRICES: Record<string, Pricing> = {
  'gemini-3.6-flash': { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedInputPerMTok: 0.075 },
  'gemini-3.5-flash': { inputPerMTok: 1.5, outputPerMTok: 9, cachedInputPerMTok: 0.15 },
  'gemini-3.1-pro-preview': { inputPerMTok: 2, outputPerMTok: 12, cachedInputPerMTok: 0.2 },
};

export const pricing: Pricing = PRICES[MODEL] ?? { inputPerMTok: 1.5, outputPerMTok: 9 };

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function apiKey(): string {
  const key = process.env['GEMINI_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error('GEMINI_API_KEY est absente de l’environnement');
  }
  return key;
}

function toGemini(message: ModelMessage): unknown {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.map((block) =>
      block.type === 'text'
        ? { text: block.text }
        : {
            inlineData: {
              mimeType: block.mediaType,
              data: Buffer.from(block.data).toString('base64'),
            },
          },
    ),
  };
}

export default {
  name: MODEL,

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      // La clé passe en en-tête, jamais dans l'URL : une URL finit dans des
      // journaux, un en-tête non.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.messages.map(toGemini),
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens ?? 8192,
          temperature: 0,
          // La sortie contrainte par schéma est ce que QAI exige : il ne lit
          // jamais de prose. `responseJsonSchema` accepte le JSON Schema
          // standard (oneOf, const…) là où `responseSchema` n'en tolère qu'un
          // sous-ensemble OpenAPI.
          responseMimeType: 'application/json',
          responseJsonSchema: request.responseSchema,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini ${response.status} : ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as {
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean }[] };
        finishReason?: string;
      }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };

    const candidate = body.candidates?.[0];
    if (candidate === undefined) throw new Error('réponse sans candidat');
    if (candidate.finishReason !== 'STOP') {
      throw new Error(`génération interrompue : ${candidate.finishReason ?? 'raison inconnue'}`);
    }

    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && part.text !== undefined)
      .map((part) => part.text)
      .join('');
    if (text === '') throw new Error('réponse sans contenu textuel');

    const meta = body.usageMetadata;
    const usage: ModelResponse['usage'] = {
      inputTokens: meta?.promptTokenCount ?? 0,
      // Les jetons de réflexion sont facturés comme de la sortie : les omettre
      // fausserait le plafond de dépense.
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      cachedInputTokens: meta?.cachedContentTokenCount ?? undefined,
    };

    return { output: JSON.parse(text) as unknown, usage };
  },
} satisfies ModelProvider;
