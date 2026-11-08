# Testing

Run commands from the repository root. Node.js 18+ is required. The application itself does not need Node.js or npm at runtime.

## Offline regression suite

```sh
npm ci
npm test
```

The current suite has **1,719 checks**. GitHub Actions runs it on Node 18, 22 and 24. It covers production-module behavior, provider request contracts, source evidence, task/decision context, cancellation and recovery, IndexedDB persistence, exports and adversarial inputs.

Cloud and local model responses used by the offline suite are mocked. `npm test` makes no authenticated provider calls and does not download a model or launch a GPU browser. `fake-indexeddb` supplies persistence tests; `playwright-core` is used only by the opt-in live local runner.

The 1,451-check quality suite expands 80 synthetic English scenarios across name and input-format variants, plus mocked pipeline contracts and state/scale checks. Those variants are not independent real-world conversations.

```sh
npm run test:quality
npm run audit:quality
npm run benchmark:quality
```

The [internal audit](quality/ENGINE_QUALITY.md) records the original baseline, fixes, timing measurements and limits.

## Live Gemini

Set `GEMINI_API_KEY` in ignored `.env.local` or the test process environment. Never paste a real key into chat or a public issue.

```sh
npm run audit:gemini                          # key-presence preflight only
npm run audit:gemini -- --run --limit 5        # five real requests
npm run audit:gemini -- --run --long --limit 5 # five longer fixtures
```

`--run` makes actual provider calls and consumes quota. Requests are serial; the runner stops on a transport/provider failure rather than repeatedly retrying it. Raw responses and corrected final results are recorded separately.

## Exact local WebLLM engine

Use installed Chrome with working hardware WebGPU. The runner uses a headless GPU-enabled browser and an isolated persistent profile, without interacting with the visible UI or your everyday browser profile.

```sh
npm run audit:local                          # headless GPU preflight only
npm run audit:local -- --run --limit 80       # real production worker and model
npm run audit:local -- --run --long --limit 5 # chatter/placement checks
```

First inference can download model/runtime files. The isolated browser profile caches model files under ignored `.live-tests/`. The runner's loopback server serves only explicitly allowed production modules, not environment files.

## Reading results

Reports under `.live-tests/` preserve expected findings, raw model selections, format issues, final pipeline mismatches and fallback notices. Raw model mismatches are diagnostics; final finding/summary mismatches produce a failing exit code. A pipeline pass can include a labelled rule fallback and does not imply a perfect model response.

The [live audit](quality/LIVE_ENGINE_AUDIT.md) records the 8 November 2026 local and Gemini runs, including initial failures and fixes. Results are bounded synthetic fixture checks, not estimates of general accuracy. Changes to the engine do not update older saved reports; reanalyze their transcripts to apply new policy.
