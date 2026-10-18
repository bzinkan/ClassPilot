# ClassPilot 3.0.1 sign-in gate theme release

This successor is based on 3.0.0 and is prepared as 3.0.1. Before uploading
the final verified `dist/ClassPilot-v3.0.1.zip`, recheck the live Store listing
and pending submissions and record the clean source commit and the ZIP SHA-256.
No Store submission or managed-device adoption is claimed by preparing this
release.

## Behavior

- The shared student sign-in gate may paint the school's dashboard theme. The
  worker reads an optional `theme` object from the existing
  `/api/classpilot/extension/login-config` response and keeps it only when
  shared sign-in is enabled. The shape is
  `{ preset, label, artwork, mark, brandFace }`; `brandFace` is
  `{ family, weight, url }` or `null`.
- The worker admits a theme only when `preset` is one of the eleven known
  presets (`halloween`, `thanksgiving`, `christmas`, `advent`, `valentines`,
  `st-patricks`, `easter`, `spring`, `summer`, `fall`, `winter`) and `artwork`
  is an `https:`/`http:` URL on the configured server origin with no
  credentials, query or fragment. A face is kept only when its font URL meets
  the same origin rule, its family is plain letters and its weight is 400 or
  700; otherwise the face is dropped and the artwork stays. Anything else
  resolves to `null` and the gate renders exactly as 3.0.0 did.
- The sanitized theme rides the existing shared sign-in presentation cache, so
  a restored gate after worker restart shows the same theme without a network
  round trip, and it is re-sanitized on restore.
- The frame re-checks the preset against its own list, writes the preset into
  `data-theme` on the panel, inserts a per-preset inline SVG mark beside the
  brand name from a fixed map, and applies the artwork and brand face only
  after the image and `FontFace` load succeed. Artwork reaches CSS only as a
  `url()` built from a parsed URL with each unsafe character percent-encoded.
  The side rail takes a per-preset tint; the form keeps its layout and sits in
  a frosted card over the artwork. `prefers-reduced-transparency` replaces the
  frosted card with an opaque one.
- A theme change alone re-renders the gate; the ready-form comparison includes
  the theme key so the same theme never causes a repaint.

The server protocol stays 3. No extension capability, permission, managed
policy, host permission or collected data is added. The theme is presentation
only: it grants no identity, presence or control authority, and a server that
omits `theme` keeps the plain gate.

## Verification and release gates

Run `npm run check`, `npm test`, `npm run test:extension:chrome`,
`bash extension/package-extension.sh` and `npm run test:extension:package`.
`server/__tests__/extension-sign-in-gate-theme.test.ts` runs the production
worker sanitizer against same-origin, foreign-origin, `javascript:`, `data:`,
credentialed, query and fragment artwork URLs and against malformed faces, and
pins the worker, frame and stylesheet hooks named above.

The manifest and package guard both require the requested 3.0.1 version.
Physical acceptance on a managed Chromebook: the plain gate with the server
theme disabled, the themed gate with a school theme active, a worker restart
showing the cached theme, and sign-in itself unchanged in both states.

Validation on 2026-10-17 used Node 24 on Windows: typecheck, the full unit
suite, the complete Chrome aggregate, packaging and the packaged-suite verify
passed. The source worker SHA-256 was `659948ebdab2b8d6d6a28f6b2b2212148c6d3ae18f547693f7ced2e536a297de`;
the local `dist/ClassPilot-v3.0.1.zip` SHA-256 was `81b48b511fd3efb530599ced7581e2e2a79ece84f93632db4dfe4c6973eb817d`.
These are local regression receipts, not Store or managed-device proof.
