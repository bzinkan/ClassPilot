# ClassPilot 3.0.9 Classroom website Focus

This Chromebook successor prepares **3.0.9**, minimum Chrome **120**, retaining
3.0.8's message links and the shared-login fixes. Preparation, Store publication
and managed-device adoption remain separate evidence.

## Behavior

Ordinary **Entire website** Focus on `classroom.google.com` permits Classroom
and the fixed Google work domains `docs.google.com`, `drive.google.com`,
`sheets.google.com`, `slides.google.com`, `forms.google.com` and `forms.gle`.
This matches an ordinary Classroom Flight Path. It permits all files the
student's Google account can access in those apps, including links from any of
their Classroom courses. It does not grant Google account/file permissions.

Google Search (`google.com` / `www.google.com`), Gmail and unrelated websites
remain outside this bundle. School/teacher block precedence remains in force.
An external assignment website needs its own Flight Path entry or the separate
reviewed assignment-access feature. No Classroom API connector, assignment
import or new capability activation is required for this fixed website bundle.

Specific-resource and Section Focus remain narrow; a Classroom assignment URL
using **This resource only** does not acquire these whole websites. Current-page
website Focus, navigation checks, DNR, reconciliation and trusted restore share
the same effective scope. Stop Focus retains its existing cleanup/restoration.

## Validation and custody

Run the targeted native Chrome/matcher checks for ordinary Classroom website
Focus and precise boundaries, then the relevant source, type, unit, compatibility
and package gates. Record exact commands, browser and outcomes separately;
isolated desktop Chrome does not prove managed ChromeOS adoption.

Package final clean reviewed/tagged source with
`bash extension/package-extension.sh` and run the complete
`npm run test:extension:package` against those bytes. Preserve
`dist/ClassPilot-v3.0.9.zip`, its SHA-256 and validation records. Copy to the
primary repository's `dist` only if the destination is absent or identical,
and verify the copied hash. Preserve canonical 3.0.7 and 3.0.8 artifacts.

The owner authorized merge, API/web deployment and package preparation. Store
upload/publication is separate; immediately before any separately authorized
upload, recheck the live version and pending submission in the authenticated
Developer Dashboard. Installation of 3.0.9 is required for this Focus correction;
deploying SchoolPilot alone cannot alter an installed 3.0.7/3.0.8 matcher.
