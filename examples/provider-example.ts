import type { ModelProvider, ModelRequest, ModelResponse, Pricing } from '../src/model/types.ts';

/**
 * Model provider skeleton.
 *
 * Copy this file, replace `callYourModel` with the call to your model,
 * then run:
 *
 *   npm run qai -- resolve my-journey.qai.yaml \
 *     --base-url http://localhost:3000 \
 *     --provider ./my-provider.ts \
 *     --max-cost 2
 *
 * Two obligations, and only one truly binding:
 *
 * 1. Return an **object conforming to `request.responseSchema`**, never text.
 *    If your model offers a "structured output" or "tool call" mode, pass it
 *    the schema as-is — that is what makes models interchangeable. Failing
 *    that, ask for JSON in the prompt and validate before returning.
 * 2. Fill in `usage`. Without a token count, no cap is possible, and cost
 *    control is a survival constraint of the product.
 */
export default {
  name: 'my-model',

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await callYourModel({
      system: request.system,
      messages: request.messages,
      schema: request.responseSchema,
      maxTokens: request.maxOutputTokens ?? 2048,
    });

    return {
      output: response.object,
      usage: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cachedInputTokens: response.cachedTokens,
      },
    };
  },
} satisfies ModelProvider;

/** Your model's price, in currency units per million tokens. */
export const pricing: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

declare function callYourModel(options: {
  system: string;
  messages: ModelRequest['messages'];
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<{
  object: unknown;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}>;
