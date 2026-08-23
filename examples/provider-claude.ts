import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Pricing,
} from '../src/model/types.ts';

/**
 * Claude provider, ready to use.
 *
 *   export ANTHROPIC_API_KEY=…
 *   npm run qai -- resolve qa/journey.qai.yaml --base-url $URL \
 *     --provider ./examples/provider-claude.ts --max-cost 2
 *
 * This file is an **example**, not a QAI dependency: the published package
 * ships no provider SDK. Copy it, change the model, or rewrite it for yours.
 */

const MODEL = process.env['QAI_MODEL'] ?? 'claude-sonnet-5';

/** Price of the chosen model, in dollars per million tokens. */
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
      // Schema-constrained output is what QAI demands: it never reads prose,
      // so an off-schema response must fail here, not six steps later.
      output_config: { format: { type: 'json_schema', schema: request.responseSchema } },
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('the model refused the request');
    }

    const text = response.content.find((block) => block.type === 'text');
    if (text === undefined) throw new Error('response has no text content');

    const usage: ModelResponse['usage'] = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? undefined,
    };

    return { output: JSON.parse(text.text) as unknown, usage };
  },
} satisfies ModelProvider;
