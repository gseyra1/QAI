# Plug in your own model

QAI depends on no provider SDK and mandates no model. The client implements a
one-method interface and injects it; nothing above it knows which model runs.

## The interface

```ts
export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

Three decisions make providers actually interchangeable.

**Output is structured, never prose.** Every request carries a
`responseSchema` and QAI expects a conforming object. It parses no free text.
Any model with constrained output works, without changing a line of code — and
when the model misses, the failure is a clean validation error, not erratic
downstream behavior.

**Token counting is mandatory.** `ModelResponse.usage` is not optional: cost
control is a survival constraint for the product (see the local measurement),
so a provider that cannot count its tokens cannot be plugged in. This is what
makes the spend cap enforceable.

**Images are just another content type.** A text-only provider covers all of
the web, where the accessibility tree carries the information. Vision only
becomes necessary for the mobile fallback.

No streaming: QAI needs a complete object, not tokens as they arrive.

## Three examples that work out of the box

[examples/provider-claude.ts](../examples/provider-claude.ts) is ready to use:

```bash
export ANTHROPIC_API_KEY=…
npm run qai -- resolve qa/parcours.qai.yaml --base-url $URL \
  --provider ./examples/provider-claude.ts --max-cost 2
```

[examples/provider-gemini.ts](../examples/provider-gemini.ts) does the same
with the Gemini API (`GEMINI_API_KEY`) — with no SDK at all: the REST API is
enough, which makes it the template to copy for an in-house provider. It
validated the first real end-to-end resolving run: 9 steps resolved, green
replay without a single model call, a renamed button repaired in one call, and
a refusal to "repair" a real regression.

[examples/provider-deepseek.ts](../examples/provider-deepseek.ts)
(`DEEPSEEK_API_KEY`) is the one that proves the contract does not rest on
constrained decoding. DeepSeek offers a JSON *mode* — "answer in JSON" —
not schema-constrained output: no guarantee of shape. The schema therefore
travels in the system message, and conformance is caught downstream — a
malformed answer is rejected and handed back to the model with its error, like
any other rejection. That is what makes QAI pluggable into any model able to
emit JSON, not only those with constrained output.

In all three cases `QAI_MODEL` selects the model and the pricing follows. These
are examples, not dependencies: the published package ships no SDK.

## Writing your own

```ts
import type { ModelProvider, ModelRequest, ModelResponse } from 'tilmiqai';

export class MyProvider implements ModelProvider {
  readonly name = 'my-model';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await callMyModel({
      system: request.system,
      messages: request.messages,
      schema: request.responseSchema,
      maxTokens: request.maxOutputTokens ?? 1024,
    });

    return {
      output: response.object,
      usage: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cachedInputTokens: response.cachedInputTokens,
      },
    };
  }
}
```

## Setting a spend cap

`BudgetedProvider` wraps any provider and cuts off at the first of the three
caps reached:

```ts
import { BudgetedProvider } from 'tilmiqai';

const provider = new BudgetedProvider(
  new MyProvider(),
  { inputPerMTok: 3, outputPerMTok: 15 },   // your model's pricing
  { maxCost: 2, maxCalls: 30 },             // per scenario
);
```

The check runs **before** each call, against the spend already recorded. A
call's cost is only known after the fact, so the cap can be exceeded by at
most one call — refusing to act until the cost is predictable would block the
product. `provider.spend` exposes the running total at any time, and the CLI
prints it at the end of the command ("model spend: …") whenever a cap is set.

## What reaches the provider, and what redaction misses

A provider is a third party. Every rejection sent back to it — like every
rejection written into a report — passes through `SecretRegistry`, which
replaces known secret values with `***`.

"Known" is the whole limit. QAI can only redact what it knows to be a secret,
and it knows that by origin: the value came from `{{env.NAME}}`. A token the
application exposes on its own, never routed through the environment, stays out
of reach.

Two symmetric blind spots follow from matching on substrings. Both are real,
and neither is fixable at this layer:

- **A value the application reformats is no longer recognised.** `1000` typed
  into a field and redisplayed as `1 000` no longer matches, and appears in
  clear.
- **A value of two characters or less is refused outright.** Redacting `ab`
  would erase that fragment throughout the report. The registry declines the
  value, and the run reports a warning saying it will appear as-is — silence
  would suggest a protection that does not exist.

How `{{env.NAME}}` is written and read: [state.md](state.md).

## Choosing a model

No mandated recommendation. Price gaps between models are real, but **they
matter less than the size of the tree you send** — that is where the bill is
decided. Measure yours with `npm run measure -- --url <your-app>`.
