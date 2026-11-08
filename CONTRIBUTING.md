# Contributing to CatchUp

CatchUp is a personal project maintained by [Vernit](https://github.com/guptavernit2-afk). Bug reports and focused improvements are welcome.

## Before making a change

Read the [README](README.md) and [architecture guide](docs/ARCHITECTURE.md). Discuss substantial features or UI redesigns in an issue before implementing them. Keep changes focused, use native browser modules, and avoid runtime dependencies unless there is a clear need.

## Local development

Use the local serving instructions in the README. For development checks:

```sh
npm ci
npm test
```

For engine changes, add a minimal synthetic transcript with independently written expected owners, statuses and source messages. Test the production pipeline and keep mocked responses distinct from actual live-model results. Live checks are opt-in; see [the testing guide](docs/TESTING.md).

For UI changes, verify normal, empty, error and loading states, keyboard access and narrow layouts. Preserve source context and safe text rendering. Do not commit API keys, private transcripts, model caches or generated live reports.

## Reporting a bug

Include reproduction steps, expected and actual behavior, browser/OS, processing mode and a small anonymized transcript if relevant. Remove API keys, personal messages and identifying details. Check the existing issues before opening a duplicate.

## Pull requests

Explain the problem, resulting behavior and checks performed. Note any practical limitations or migration effects. Ensure `npm test` passes and documentation reflects the final behavior. Follow the repository's existing formatting rather than introducing a broad unrelated reformat.
