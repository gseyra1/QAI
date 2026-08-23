import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Pricing,
} from '../src/model/types.ts';

/**
 * Gemini provider, ready to use — and SDK-free: the REST API is enough.
 *
 *   export GEMINI_API_KEY=…
 *   npm run qai -- resolve qa/journey.qai.yaml --base-url $URL \
 *     --provider ./examples/provider-gemini.ts --max-cost 2
 *
 * This file is an **example**, not a QAI dependency: the published package
 * ships no provider SDK. Copy it, change the model, or rewrite it for yours.
 */

const MODEL = process.env['QAI_MODEL'] ?? 'gemini-3.6-flash';

/** Price of the chosen model, in dollars per million tokens (August 2026). */
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
    throw new Error('GEMINI_API_KEY is missing from the environment');
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
      // The key goes in a header, never in the URL: a URL ends up in logs,
      // a header does not.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.messages.map(toGemini),
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens ?? 8192,
          temperature: 0,
          // Schema-constrained output is what QAI demands: it never reads
          // prose. `responseJsonSchema` accepts standard JSON Schema
          // (oneOf, const…) where `responseSchema` only tolerates an
          // OpenAPI subset.
          responseMimeType: 'application/json',
          responseJsonSchema: request.responseSchema,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini ${response.status}: ${detail.slice(0, 300)}`);
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
    if (candidate === undefined) throw new Error('response has no candidate');
    if (candidate.finishReason !== 'STOP') {
      throw new Error(`generation interrupted: ${candidate.finishReason ?? 'unknown reason'}`);
    }

    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && part.text !== undefined)
      .map((part) => part.text)
      .join('');
    if (text === '') throw new Error('response has no text content');

    const meta = body.usageMetadata;
    const usage: ModelResponse['usage'] = {
      inputTokens: meta?.promptTokenCount ?? 0,
      // Thinking tokens are billed as output: omitting them would skew
      // the spend cap.
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      cachedInputTokens: meta?.cachedContentTokenCount ?? undefined,
    };

    return { output: JSON.parse(text) as unknown, usage };
  },
} satisfies ModelProvider;
