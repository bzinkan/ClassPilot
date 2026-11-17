# ClassPilot 3.0.8 clickable message links

This Chromebook successor prepares **3.0.8**, minimum Chrome **120**, and retains
3.0.7's shared-login recovery and reviewed Classroom permissions. Preparation,
Store publication and managed-device adoption remain separate evidence.

## Behavior

HTTP(S) and www. addresses in student chat bubbles, announcement modals and the
popup inbox become links. A user activates a link with a click or keyboard; it
opens in a new tab with `noopener noreferrer`. Rendering does not fetch, preview
or automatically open destinations. Raw stored and transmitted messages stay
unchanged. HTML and non-web schemes remain literal text; credentialed URLs do
not become links. Whitespace and query/fragment contents are preserved. Explicit
quotes/brackets disambiguate surrounding punctuation; ambiguous terminal query
punctuation remains URL data.

A message grants no browsing permission. Focus, Flight Path and school blocks
continue applying to the destination, including Google Search. No permission,
capability, server command, authentication or chat lifecycle contract changes.
The shared packaged helper loads before content/popup renderers and through
content recovery injection. Missing enhancement code leaves readable plain text.

## Validation and artifact custody

Use Node 24+ and run `npm run check`, `npm test`, `npm run build`,
`npm run test:extension:chrome` and `npm run test:extension:windows:unit`.
`scripts/test-message-links.mjs` runs the shared literal parsing fixtures;
`scripts/test-extension-teacher-chat.mjs` uses native Chrome to test all message
surfaces, exact queries, literal markup, mouse/keyboard navigation, opener and
referrer isolation, and continued Google Search blocking from the extension
popup as well as page UI. Existing chat lifecycle checks remain in that suite.

Package the final clean, reviewed, tagged source using
`bash extension/package-extension.sh`, then run the complete
`npm run test:extension:package` chain against those exact bytes. Outputs are
`dist/ClassPilot-v3.0.8.zip` and its `.sha256` and verification records. A dirty
worktree package is an integration candidate. Preserve the canonical 3.0.7 ZIP,
tag and source; never overwrite a reviewed archive with different bytes.

Copy a final 3.0.8 artifact to the primary repository's `dist` only after checking
the destination is absent or identical, and verify the copied SHA-256. Keep
unrelated primary checkout work unchanged.

No Store upload or capability activation is authorized by this preparation.
Immediately before any separately authorized upload, verify the live version and
pending submission in the authenticated Developer Dashboard. Managed Chromebook
installation, link opening under school policy, and shared-device behavior still
require fleet acceptance; isolated desktop Chrome does not establish adoption.
