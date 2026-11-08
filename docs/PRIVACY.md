# Data handling and privacy

CatchUp processes conversations in the browser, with optional direct requests to a cloud provider. It has no account system or application backend.

## Processing modes

| Mode | Transcript handling | Network activity |
| --- | --- | --- |
| Instant Rules | Parsed and analyzed on your device | No analysis-provider request is needed once the app is loaded. |
| Local Private | Parsed and analyzed in the browser, with model inference on the GPU | Runtime and model files are downloaded. The transcript is not sent to an inference provider by this mode. |
| Cloud Turbo | Sent directly from your browser to the selected provider | The transcript and provider authentication are used in the selected API request. Provider terms, retention and quotas apply. |

The hosted page loads external fonts, and the hosting service handles ordinary web requests. Local inference is not a promise that the entire site is network-free.

## Browser storage

- **Saved catch-ups:** IndexedDB stores transcripts, findings, titles, history metadata and task progress.
- **API keys and preferences:** stored separately in origin-scoped `localStorage`, readable by scripts running on the same origin.
- **Local model cache:** browser-managed storage can retain downloaded model assets for reuse.

Saved catch-ups exclude provider keys and processing settings. Browser storage is not encrypted by CatchUp and is not a cloud backup. Other users of the same browser profile may access it. A different browser or origin has a separate library; changing deployment domains does not migrate reports.

## Deletion and copies

Moving a catch-up to Trash is reversible. Permanent deletion removes its saved record after confirmation. Clearing site data can remove reports, preferences and cached model assets. Private browsing and browser storage policies can also affect persistence.

Downloaded Markdown and copied text are separate copies; deleting a saved catch-up does not delete those copies. Export a report when you need a backup outside browser storage.

## Developer credentials and test data

Live Gemini tests read a key from the process environment or ignored `.env.local`. Live reports and the isolated headless model profile are ignored under `.live-tests/`. No real credentials belong in source files, fixtures, screenshots, commits or issue reports.

A general-purpose static server can expose files in its served directory. Keep development servers on loopback and exclude secrets and Git metadata from any public static hosting. Deployment credentials and developer test keys are not required by the browser app itself.

For a suspected vulnerability, use the repository's private vulnerability reporting option if available. Do not publish a credential or private transcript in a public issue. Revoke an exposed key at its provider before investigating further.
