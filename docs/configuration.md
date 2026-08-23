# The configuration file

`qai.config.json`, found by walking **upward** from the current directory —
like the rest of the Node toolchain, because a team runs its tests from
anywhere in the repo.

```json
{
  "scenarios": ["qa/"],
  "baseUrl": "http://localhost:3000",
  "states": "./qa/states.ts",
  "provider": "./qa/provider.ts",
  "workers": 4,
  "maxCost": 2,
  "assertTimeout": 5000,
  "artifacts": ".qai/artifacts",
  "strict": false
}
```

Then, from any directory:

```bash
qai run
```

**Command-line options always override the file** — override `--base-url` per
environment without duplicating the configuration.

## Rules

**Paths resolve relative to the file**, not the current directory. Otherwise,
running QAI from a subfolder would silently break the resolution of `states`
and `provider`.

**An unknown key is silently ignored.** `assertTimeout` only exists since
0.1.0: set in a project running an older version, it produces no error and no
effect. Check the version before concluding a setting does nothing.

**A file that exists but is invalid fails the command.** Ignoring it would run
the suite with settings nobody chose — a mistyped field is dropped
individually, but broken JSON stops everything.
