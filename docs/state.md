# A journey's starting state

A scenario does not build its context with clicks: it **declares** it.

```yaml
given:
  state: client-connecte
  fixtures: [catalogue-standard]
```

Logging in through the form at the start of every journey would be slow, fragile, and would test the login page fifty times instead of the journey itself.

## You provide the translation

QAI knows nothing about your authentication or test data. You implement `StateProvider` — one method — and QAI installs the result in the browser before the first step.

```ts
export default {
  async prepare(request: StateRequest): Promise<PreparedState> {
    if (request.given.state === 'client-connecte') {
      const { token } = await creerSessionDeTest(request.baseUrl);
      return { cookies: [{ name: 'session', value: token }] };
    }
    return {};
  },
} satisfies StateProvider;
```

```bash
npm run qai -- run qa/ --base-url $URL --states ./qa/states.ts
```

Start from [examples/states-exemple.ts](../examples/states-exemple.ts).

## What you can return

| Field | Effect on web | Planned mobile equivalent |
|---|---|---|
| `cookies` | set on the browser context | webview storage |
| `cookies[].secure` · `.sameSite` | attributes of the cookie | carried by the webview |
| `storage` | written to `localStorage`, before and after navigation | application preferences |
| `entry` | forced entry point | deep link |

This is why the contract's top level says **prepared state**, not "cookies": the vocabulary must stay expressible on mobile.

## Cross-site sessions

If the app under test and its API are not same-site — a front on `localhost:3000` against a deployed API, the common development case — the session only installs with both attributes:

```ts
return {
  cookies: [{
    name: 'session', value: token,
    domain: '.exemple.com', path: '/',
    secure: true, sameSite: 'None',
  }],
};
```

Omit `sameSite` and the browser defaults the cookie to `Lax`, then refuses to send it on requests to the API. Nothing signals this: the journey starts anonymous and fails several steps later, on an unrelated assertion. A `SameSite=None` cookie must also be `Secure` — a browser requirement.

Both fields are **omitted** from the call when you leave them unset: the browser then applies its own defaults.

## Two rules

**An unknown named state must throw**, not return an empty state. A journey that believes it is logged in but is not fails incomprehensibly six steps later.

**State is reinstalled for every journey.** Each scenario gets a fresh browser, so nothing leaks between them — a test verifies this explicitly.

## Fixtures

`given.fixtures` is passed as-is to your `prepare`: answer it with a call to your seeding API. QAI does not manage your test data; it only tells you which data the scenario requests.
