# Live engine audit — 8 November 2026

This follow-up uses real model responses, separately from the deterministic and mocked checks in [ENGINE_QUALITY.md](ENGINE_QUALITY.md). All transcripts are synthetic English fixtures. These are regression checks, not a general accuracy estimate.

## Exact local engine

Ran the production WebLLM worker, WebLLM 0.2.87 and `Llama-3.2-1B-Instruct-q4f16_1-MLC`, in installed Chrome with headless GPU enabled. WebGPU reported Intel `xe-lpg`. No visible browser, UI actions, user browser profile, or cloud credentials were used. The isolated profile caches the model under ignored `.live-tests/`.

The initial 80 short cases passed final finding checks, but raw selections included greetings and thanks. Five additional 20-message chats placed two tasks, one decision and one pending blocker among unrelated chatter. Before the new candidate filter, only **1/5** long briefings covered all four facts. The model often chose arbitrary chatter IDs.

Fixes:

- Select local candidates from detected findings and their confirmations, retaining original message IDs and full source text.
- Filter standalone greetings, thanks and acknowledgements from final summaries.
- Check briefing coverage against detected finding sources/categories. Incomplete selections produce a labelled Instant Rules briefing. This safeguard applies to cloud mode too.
- Include personal attention findings in rule briefings and improve cloud instructions for requests, conditional offers and unresolved blockers.

The revised short run passed **80/80** final checks, with no runtime or JSON-format failures. Thirteen raw filler selections were removed, and one briefing used the labelled rule fallback. Median case time was 835 ms with the model already cached (not a cold-download benchmark).

The revised long run passed **5/5** final checks. Four cases used complete model selections; one omitted a finding and correctly used the labelled rule briefing. Median case time was 1,232 ms. This is a pipeline pass, not proof that the model itself always selects correctly. Filtering candidates also means local selection depends on rule detection and cannot discover facts excluded by that detector.

## Live Gemini

Used the production `gemini-3.5-flash-lite` configuration with an ignored local credential. Three requests completed. Raw errors included an unaccepted request missing from open questions, a pending-access blocker omitted, and a conditional offer substituted for the original request. One summary selected only a greeting. Canonical rules repaired finding categories, but that greeting exposed a briefing weakness.

The fourth request returned HTTP 503. One bounded rerun after prompt changes also returned HTTP 503; testing stopped. Offline replay of the three recorded successful responses through the revised pipeline passed finding and summary checks, with two explicitly labelled rule briefings. Replay does not measure the revised model response.

On the subsequent live retry, the revised prompt and production pipeline completed **5/5 short cases and 5/5 long cases**, with no transport errors, final finding mismatches, filler summaries, or malformed JSON. All ten briefings used model selections without a rule-briefing fallback. In one short case, the raw model omitted the requested action when faced with a conditional acceptance; the canonical rules restored it. The other nine raw finding sets matched their fixture sources and owners. These results verify the tested pipeline behavior, not perfect model accuracy. The five long cases reuse the same facts at different positions among chatter.

## Repeat internally

Install development tools with `npm ci`. Node 18+ is supported. The app gains no browser runtime dependency; `playwright-core` is used only by the development runner. Installed Chrome and working hardware WebGPU are needed for the exact local engine.

```powershell
npm run audit:gemini                         # credential-presence preflight only
npm run audit:local                          # headless GPU preflight, no model inference
npm run audit:gemini -- --run --limit 5       # real provider requests and quota usage
npm run audit:gemini -- --run --long --limit 5 # longer Gemini fixtures
npm run audit:local -- --run --limit 80       # real production local inference
npm run audit:local -- --run --long --limit 5 # chatter/placement checks
npm test                                    # offline regression suite
```

Set `GEMINI_API_KEY` in ignored `.env.local` or the test environment; do not paste credentials into chat. Reports retain raw responses and corrected final outputs separately under ignored `.live-tests/`. The runners stop on transport failures; raw-model mismatches are diagnostic, while final pipeline mismatches produce a failing exit code. Default execution does not make provider calls or load the local model. The local HTTP server serves only explicitly listed production modules, not environment files.

The offline suite passes **1,719 checks**, including fourteen new harness, filler, source-ID and coverage tests. It passed again after the successful Gemini retry. No UI layout was changed. The preceding quality audit was pushed as `b67a920`; this follow-up contains the live runners and the fixes their results motivated.
