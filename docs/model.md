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
control is a survival constraint for the product, so a provider that cannot count its tokens cannot be plugged in. This is what
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

The module passed to `--provider` default-exports a provider instance
(`export default new MyProvider()`), and exports `pricing` when `--max-cost`
is used. It is loaded as **ESM**: name it `.mts` or `.mjs`, or
set `"type": "module"` in its `package.json`. A `.ts`/`.mts` module needs
Node ≥ 22.18.

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

A provider is a third party. Everything sent to it, on generation and on
repair, passes through `SecretRegistry` at one single point: the screen tree,
the current address, capture values, rejections. Known secret values become
`[secret]`. The model writes `{{env.NAME}}` or `{{capture}}`, and QAI substitutes
the value locally. Screenshots are never sent.

The same registry masks reports, which end up in CI logs.

What the scenario's author wrote goes as written: an expectation that names a
value must come back word for word, and it is already versioned in clear. The
same value stays masked everywhere else, on the screen and in the address, except
where a screen repeats the author's whole sentence. An expectation that is just
`alice@acme.test` is therefore left in clear everywhere.

A proposal that copies `[secret]` is refused, in a typed value, a name or an
address: it would pass generation on a value that does not exist. `{{env.NAME}}`
works in typed values only, so a step that must `navigate` to an address holding
a secret cannot be resolved that way: go through the form that builds it.

"Known" is the whole limit. QAI can only redact what it knows to be a secret,
and it knows that by origin:

- **Before the first screen**, on generation and on replay: a variable an intent
  or an expectation names in capitals with an underscore (`sign in with QAI_PASS`;
  `CI` or `DEBUG` read as words), and any `{{env.NAME}}` they write. Replay also
  learns every `{{env.NAME}}` of the resolution.
- **On the way**: any `{{env.NAME}}` an accepted proposal uses, and what is read
  from a node showing a secret (`extract: number` drops the zeros of `00738291`).
- **Across journeys**: within one command, a value learned by a journey stays
  masked in the next ones, in the order they ran.

A token the application exposes on its own, never routed through the
environment, stays out of reach. So does anything the screen shows of its own
accord, such as a customer's name in test data: use data you can send to your
provider, or a provider you host.

The registry searches the text as it stands and as it reads once decoded, up to
three URL encodings and JSON escapes, with spaces reduced the way observation
reduces them. `p@ss` is found in `p%40ss`, in `p%2540ss` and in a JSON inside an
address. Three blind spots remain, and none is fixable at this layer:

- **A value the application reformats is no longer recognised.** `1000` typed
  into a field and redisplayed as `1,000` no longer matches, and appears in
  clear. The same goes for a value the browser rewrites, such as `a/../b` in a
  path, or a long one Chromium shortens in a console preview.
- **A value split across several elements is not recognised**, because the tree
  separates them: a key shown one line per `<div>`, a phrase one word per `<li>`,
  a token in two `<span>`. Each element goes in clear. Do not display such a value
  to a page under test with a third-party provider.
- **A value of two characters or less is refused outright.** Redacting `ab`
  would erase that fragment throughout the report. The registry declines the
  value, and the run reports a warning saying it will appear as-is — silence
  would suggest a protection that does not exist.

How `{{env.NAME}}` is written and read: [state.md](state.md).

## Choosing a model

No mandated recommendation. Price gaps between models are real, but **they
matter less than the size of the tree you send** — that is where the bill is
decided. To measure yours, clone the QAI repository (the script is not in
the npm package) and run `npm run measure -- --url <your-app>`.
