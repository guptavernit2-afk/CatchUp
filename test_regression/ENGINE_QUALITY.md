# Internal engine quality audit — 8 November 2026

All work was run directly in Node against production modules. No browser was
opened and no transcript or credential was sent to an external provider.

## What was compared

The baseline is the committed engine at `acd6aa4`. Expected findings were written
from the meaning of synthetic conversations, independently of engine output.
The initial set had 60 scenarios; 20 follow-up scenarios were written before
running the second evaluation. Both sets are now regression fixtures, not a
remaining blind validation set.

The final before/after comparison uses the **same 80 scenarios**, each in four
forms: plain transcript, smart apostrophes, Android WhatsApp, and iOS WhatsApp.
A scenario passes only when expected task owners/statuses, decision sources,
unresolved-question sources, and applicable attention/summary/context checks
agree. These are strict fixture checks, not a statistical accuracy estimate.

| Same corpus | Committed baseline | Revised engine |
| --- | ---: | ---: |
| Independent scenarios passing | 36 / 80 | 80 / 80 |
| Scenario/format checks passing | 144 / 320 | 320 / 320 |

The automated quality suite additionally tests four participant-name sets,
including full names, Unicode, hyphens, and curly apostrophes: **1,280** checks.
Another **160** checks inject mocked local/cloud responses through the real
parser, source validator and merge logic, including invented owners/source IDs.
Those verify classification consistency and evidence handling, **not actual
model inference or the relevance of a model's selected summary messages**.
Eleven extra checks cover completion/withdrawal safety, briefing overflow, and
preservation of 1,000 independent tasks. Total: **1,451 new quality checks**,
and **1,705 tests** including the existing suites.

## Concrete mistakes found and fixed

| Actual conversation | Before | After |
| --- | --- | --- |
| “I will be there at 5 PM.” | Confirmed task | Attendance; no deliverable invented |
| “I can't deploy. I will update the runbook.” | Promise lost because of the other sentence's negation | Runbook task retained |
| “I will write the notes. I will send the invoice.” | Combined into one task | Both tasks retained |
| Bob is asked to review a checklist; Carol says “Sure.” | Request shown as still requested, but its question disappears | Request and unresolved question remain consistent |
| Bob says “I'll review it if I have time.” | Conditional acceptance can confirm the request | Remains requested |
| “Where is the checklist?” / “The checklist is important.” | Keyword overlap closes the question | Question remains open |
| “Where is the checklist?” / “It is in Drive.” | Direct pronoun answer missed | Unambiguous adjacent location answer recognized |
| Two questions, only one answered | Entire message can disappear from open questions | Unanswered part keeps the message open |
| “The decision document is in Drive.” | Reported as a decision | Informational message |
| Decision followed by an unrelated pending item in another sentence | Real decision suppressed | Decision and blocker retained separately |
| “We decided X. We decided Y.” | One choice overwrites the other | Both choices retained with exact quotes |
| “I will send the invoice.” / “Actually, I will not send the invoice anymore.” | Withdrawn work remains active | Matching explicit withdrawal removes it |
| A named request / assignee replies “Done.” | Completion missed | Confirmed and completed, linked to the reply |
| Two tasks owned by the same person | Briefing silently mentions only their first task | Both appear within the briefing limit; larger lists show omitted counts |
| API word inside a URL or credentials question | Invented “tech stack selection” topic | Briefing uses extracted facts rather than guessed topic labels |

AI briefing fragments are expanded back to the complete source message so a
selected substring cannot drop a negation or condition; repeated selections
of the same message are deduplicated.

Matching uses normalized punctuation, but displayed quotes and sender names
retain the source wording. All finding and acceptance quotes are checked against
their actual source messages. Cloud-supplied attention/questions now use the same
canonical wording as rules. Merged findings retain conversation order even when
the model supplies only a subset.

## Efficiency

On this machine, parsing + Instant Rules + briefing generation produced these
median timings over five measured runs after one warm-up:

| Synthetic workload | Before | After |
| --- | ---: | ---: |
| 200 independent tasks | 0.79 ms | 1.37 ms |
| 1,000 independent tasks | 2.38 ms | 3.85 ms |
| 1,000 unanswered location questions | 33.66 ms | 53.29 ms |

The revised engine performs additional context checks; it is not faster than the
baseline on these workloads. Task state changes are indexed by owner to avoid
scanning ordinary later messages for every task. These measurements exclude UI,
model loading, GPU inference and network latency, and are not latency guarantees.

## Reproduce

```sh
npm ci
npm test
npm run test:quality
npm run audit:quality
npm run benchmark:quality
```

To retain full expected-versus-actual failures in a machine-readable report:

```sh
node test_regression/quality-audit.mjs --output quality-results.json
```

## Practical limits

- The examples are synthetic English conversations. Unicode participant names
  do not imply support for understanding every language.
- Live Gemini and real GPU-model outputs were not tested in this audit. No
  browser-owned API keys were extracted. Actual model summary selection needs a
  separate live evaluation before making claims about its quality.
- Open-ended paraphrases, sarcasm, implicit assignments, ambiguous pronouns,
  and complex revisions can still be missed. Passing these fixtures does not
  prove an unseen conversation will be interpreted correctly.
- The briefing is deliberately bounded and source-based; it labels omitted
  items instead of implying that every finding is shown.
- Existing saved reports retain their stored findings. Reanalyze a transcript
  to apply the revised extraction policy.
