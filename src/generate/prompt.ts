export const SYSTEM_PROMPT = `You translate a user's intent into machine gestures on an interface.

You are given the tree of the current screen, indented, where each line is:
  <role> "<accessible name>" [state] #test-id

You return the actions that carry out the intent, and where requested the
captures and assertions.

Targeting rules, no exceptions:
- A target is described by its role and its accessible name, never by a CSS
  selector or an XPath. That is what makes the test replayable on mobile.
- The name must match the one in the tree exactly. If the exact name is
  unstable (it contains a counter, a date, an amount), use
  { "contains": "..." } on the stable part.
- The test will be REPLAYED on other data: a name that comes from the page's
  data — order number, item name, price, generated code — will change on the
  next replay. Target the structure (role, "within", "nth") or the stable part
  of the name with { "contains": "..." }, never the data itself.
- "The first in the list" translates to a position — "nth": 0 in the list's
  "within" — not to the name of the element that happens to be first today.
- To open a page whose path is known, prefer "navigate" to a click: less
  fragile than a link whose label can change.
- If several elements match, disambiguate with "within" (the container) by
  preference, otherwise with "nth". An ambiguous target is refused: the
  engine is not allowed to choose in your place.
- When the targeted line carries #id, add "fallback": { "testId":
  "id" } — that is the safety net if the label changes. Otherwise, no
  fallback.

Rules for captures:
- A capture's target is located by its structure, NEVER by the value it
  extracts: targeting the text "129,00 €" to capture a price breaks at the
  first price change.
- An amount, a total, a quantity are captured with "extract": "number",
  not "text": that is what makes them comparable.

Rules for assertions:
- The key is the exact text of the assertion, copied from the scenario.
- The assertion must be TRUE on the screen you are shown. We record a known
  good state: a false assertion here would be a false test.
- A value can reference a capture with {{name}}, including in the name of a
  target.
- When the assertion speaks of the address — a redirect, a denied access, a
  navigation — use "urlContains" (a stable fragment, e.g. "/login") or
  "urlEquals" (the whole URL, compared as-is). Neither takes a "target": they
  bear on no element at all.

Rules for typed values:
- When the intent designates a value by an environment variable ("sign in with
  QAI_USER and QAI_PASS"), return the template {{env.QAI_USER}}, never the
  value itself nor an invented one. The file produced is versioned: a secret
  copied into it stays there forever. The engine resolves these templates at
  the moment of acting.
- {{capture}} also works in a typed value, to reuse what was read at an
  earlier step.

Rule for native confirmations:
- A gesture that triggers a browser dialog (confirm, alert, prompt) must be
  PRECEDED by { "kind": "expectDialog", "response": "accept" }. The dialog
  blocks the page from the click onwards: there is no moment after it to
  answer. Without this action the dialog is dismissed, and the deletion, the
  confirmation or the exit never happens.

An intent often translates into several gestures: "fill in the address" or
"sign in" are several actions, in order — but all on the screen you are
shown: every target is verified against this screen before any execution.`;

export interface StepPromptInput {
  intent: string;
  tree: string;
  location: string;
  expectations: string[];
  /**
   * Nom → description écrite par l'auteur du scénario (« prix : le prix
   * affiché »). C'est la seule intention dont on dispose pour cadrer la
   * capture : ne transmettre que les noms forçait le modèle à deviner.
   */
  captures: Record<string, string>;
  availableCaptures: Record<string, string>;
}

function captureLines(captures: Record<string, string>): string[] {
  return Object.entries(captures).map(([name, description]) => `- ${name}: ${description}`);
}

export function stepMessage(input: StepPromptInput): string {
  const parts = [`Current screen (${input.location}):`, '', input.tree, '', `Intent: ${input.intent}`];

  if (Object.keys(input.captures).length > 0) {
    parts.push('', 'Captures to produce:', ...captureLines(input.captures));
  }
  if (input.expectations.length > 0) {
    parts.push('', 'Assertions to translate, copy them verbatim as keys:');
    for (const expectation of input.expectations) parts.push(`- ${expectation}`);
  }

  const available = Object.entries(input.availableCaptures);
  if (available.length > 0) {
    parts.push('', 'Captures already available, referenceable via {{name}}:');
    for (const [name, value] of available) parts.push(`- {{${name}}} = ${value}`);
  }

  return parts.join('\n');
}

/**
 * Le retour d'erreur est ce qui rend la boucle fiable : chaque proposition est
 * confrontée à l'application réelle, et l'échec revient au modèle formulé dans
 * le vocabulaire qu'il vient d'employer.
 */
export function retryMessage(errors: string[], tree?: string): string {
  const parts = ['Your proposal was rejected:'];
  for (const error of errors) parts.push(`- ${error}`);
  parts.push('', 'Fix it and propose again.');
  if (tree !== undefined) parts.push('', 'Current screen:', '', tree);
  return parts.join('\n');
}

export function checksMessage(input: {
  tree: string;
  /** Sans elle, une assertion d'URL serait à deviner. */
  location: string;
  expectations: string[];
  captures: Record<string, string>;
  availableCaptures: Record<string, string>;
}): string {
  const parts = [
    `The actions have been executed. Here is the resulting screen (${input.location}):`,
    '',
    input.tree,
    '',
  ];

  if (Object.keys(input.captures).length > 0) {
    parts.push('Captures to produce from this screen:', ...captureLines(input.captures));
  }
  if (input.expectations.length > 0) {
    parts.push('', 'Assertions to translate, true on this screen:');
    for (const expectation of input.expectations) parts.push(`- ${expectation}`);
  }
  const available = Object.entries(input.availableCaptures);
  if (available.length > 0) {
    parts.push('', 'Available captures:');
    for (const [name, value] of available) parts.push(`- {{${name}}} = ${value}`);
  }
  return parts.join('\n');
}
