# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository (*Security* → *Report a vulnerability*), or email
mouaad.gseyra@gmail.com.

Expect an acknowledgement within 72 hours and a fix or mitigation plan within
14 days for anything rated high or critical.

## Supported versions

Only the latest published version of `tilmiqai` receives fixes.

## Supply-chain posture

QAI is a developer tool that runs in CI with access to your source tree, so its
own dependency chain is part of your attack surface. What we do about it:

- **Install scripts are disabled** everywhere — `.npmrc`, CI and the composite
  action. Lifecycle hooks are the entry vector of npm worms; nothing in this
  project needs them. Playwright downloads browsers through an explicit
  command, never a hook.
- **GitHub Actions are pinned to commit SHAs**, not mutable tags. A tag can be
  repointed at hostile code without anything changing here.
- **CI runs with read-only permissions** and a blocking `npm audit`.
- **Registry signatures are verified** on every CI install.
- **No vendor SDK is bundled.** The published package has two runtime
  dependencies. Your model provider — and therefore your API key — stays in
  your own code.

## What QAI does with your data

QAI drives a browser against a URL you supply and, when you enable tiers 2 or
3, sends the resulting accessibility tree to the model **you** configured.
It has no telemetry, no network calls of its own, and no credentials of its own.
