# CatchUp

**Catch up on what matters.**

[![Tests](https://github.com/guptavernit2-afk/CatchUp/actions/workflows/tests.yml/badge.svg)](https://github.com/guptavernit2-afk/CatchUp/actions/workflows/tests.yml)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES_modules-f7df1e?logo=javascript&logoColor=000)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![WebGPU](https://img.shields.io/badge/Local_AI-WebGPU-6366f1)](docs/ARCHITECTURE.md)

CatchUp turns long conversations into a source-linked briefing: what was decided, what needs attention, and what remains unanswered. Task tracking supports the catch-up, so you can understand the conversation first and follow through afterward.

A personal project built and maintained by [Vernit](https://github.com/guptavernit2-afk).

[**Try CatchUp**](https://pals-mu.vercel.app/) · [Getting started](#run-locally) · [Documentation](docs/README.md) · [Report an issue](https://github.com/guptavernit2-afk/CatchUp/issues)

## What you can do

- **Get a quick briefing.** Review important messages, decisions, unresolved questions and blockers in one workspace.
- **Keep the evidence.** Findings retain source quotes and message references; accepted tasks and contextual decisions include supporting messages where available.
- **Follow up on tasks.** See owners and requested or confirmed status, then mark work complete.
- **Personalize attention.** Enter your name to highlight relevant mentions and requests.
- **Save catch-ups.** Add titles, search your library, reopen recent reports, rename them, and use Trash to restore or permanently delete saved reports.
- **Share a report.** Copy Markdown or download a `.md` file, including task progress.
- **Choose processing.** Use local AI, instant rules, or your own cloud API provider.

## Processing options

| Mode | How it works | What you need |
| --- | --- | --- |
| **Local Private** | WebLLM runs Llama 3.2 1B in a browser worker. The model selects briefing messages; rules supply canonical findings. Conversation text is processed on your device. | A working WebGPU browser and compatible GPU. First use downloads the model. |
| **Instant Rules** | JavaScript extracts findings and builds a deterministic briefing on your device. | No model or API key. Once the app is loaded, analysis requires no provider request. |
| **Cloud Turbo** | Your browser sends the transcript directly to Gemini, Groq, OpenAI, or a compatible custom endpoint. Results pass through source validation and rule checks. | Your provider API key, model access, network connection and available quota. |

Model output is checked against source messages. If selections fail to cover detected findings, CatchUp uses a clearly labelled Instant Rules briefing. This improves consistency; it does not guarantee that every conversation is interpreted correctly.

## Run locally

CatchUp is a static application using HTML, CSS and JavaScript modules. There is no frontend build step or application backend.

```sh
git clone https://github.com/guptavernit2-afk/CatchUp.git
cd CatchUp
python -m http.server 8000 --bind 127.0.0.1
```

Open **http://127.0.0.1:8000**. Use a local HTTP server rather than opening `index.html` directly. Python 3 is only needed for the example server; any suitable static server can run the application. WebGPU requires a secure context, such as HTTPS or loopback, and working browser/GPU support.

The example server is for local development. Do not expose a checkout containing developer credentials or `.git` through a public static server.

### First catch-up

1. Choose a processing mode. Start with **Instant Rules** to try CatchUp without a download or API key.
2. Paste a transcript, drop a `.txt` or `.md` file, or choose **Load sample**.
3. Optionally enter your name, then analyze.
4. Review the briefing and category tabs. Check source quotes when context matters.
5. Save the catch-up with a title, or export Markdown.

Supported input includes `Name: message`, timestamped messages and common iOS/Android WhatsApp text exports. Other export formats may need reformatting.

## Saved reports and privacy

Saved catch-ups live in **IndexedDB in the current browser**, with recent history in the sidebar. Task edits need **Save changes** to persist. Trash is reversible until you confirm permanent deletion.

Cloud keys and settings are stored separately in browser `localStorage`; they are excluded from saved-report records. Browser storage is not an encrypted vault or account backup. Other people using the same browser profile can access its data, and clearing site data can remove saved reports. Download Markdown for a separate copy.

Local AI downloads runtime/model files, and the page loads external fonts. Local processing does not mean the entire application makes no network requests. Cloud mode sends the transcript to your selected provider. See [data handling and privacy](docs/PRIVACY.md) for details.

## Verification

The offline regression suite contains **1,719 checks** covering parsing, finding policy, evidence, worker recovery, saved-report persistence, exports and adversarial inputs.

```sh
# Node.js 18+ is required for development tools.
npm ci
npm test
```

GitHub Actions runs the offline suite on Node 18, 22 and 24. It does not require API keys or download a model.

Live verification on **8 November 2026** checked the exact local WebLLM engine on **80 short chats and five longer chats**, plus Gemini on **five short and five longer chats**. All final-output fixture checks passed. Some local briefings needed the labelled rule fallback; one raw Gemini task omission was corrected by the rules. These are synthetic regression results, not a general accuracy score.

[Testing guide](docs/TESTING.md) · [Internal quality audit](docs/quality/ENGINE_QUALITY.md) · [Live engine audit](docs/quality/LIVE_ENGINE_AUDIT.md)

## Repository structure

```text
CatchUp/
├── index.html / style.css       # Workspace markup and styles
├── app.js / sidebar.js          # UI and navigation controllers
├── library-ui.js                # Saved catch-up library UI
├── engine.js                    # Parsing and analysis orchestration
├── heuristics.js / evidence.js  # Canonical findings and source validation
├── local-runtime.js             # Worker lifecycle, cancellation and deadlines
├── local-worker.js              # WebLLM worker
├── saved-catchups.js / report.js # Persistence and Markdown export
├── docs/                        # Architecture, privacy, testing and audits
├── test_regression/             # Fixtures, regression suites and live runners
├── .github/                     # CI and contribution templates
└── vercel.json                  # Deployment security headers
```

## Current scope

CatchUp is a browser-based personal workspace. It has no account system, cloud sync, shared workspaces or automatic chat-service integration. Saved reports stay in the browser where you created them.

Extraction is conservative and primarily tested on English conversations. Implicit assignments, sarcasm, ambiguous pronouns, complex revisions and other languages can be missed. Local AI accepts up to 200 messages or 12,000 serialized characters. A briefing is bounded; use the category lists and source evidence for the full picture.

The current version is a working baseline for personal use and continued iteration. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and issue-reporting guidance.
