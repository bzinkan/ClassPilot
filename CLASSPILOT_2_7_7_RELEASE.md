# ClassPilot 2.7.7 Roll-Forward

ClassPilot 2.7.7 is the single-school roll-forward from the public 2.7.6
release. It keeps Waypoint and Flight Path enabled during the short
mixed-version period and advertises the informational capability
`domainPreservingRestrictionsV1` so SchoolPilot can use accurate teacher copy.

## Included fixes

- Waypoint and the effective teacher/school tab limit now compose. Allowed
  same-domain tabs no longer bypass the lower active limit.
- A sole compliant web tab is retained when protected Chrome pages make the
  numerical limit impossible to reach.
- Waypoint and Flight Path choose the active tab from Chrome's last-focused
  window, focus the selected window, verify the foreground result, and create
  at most one landing-page fallback if the selected tab or window disappears.
- Revisioned state, legacy commands, school settings, and newly-created tabs
  use the same restriction-aware tab-limit planner.
- No permissions, managed-policy schema, or storage formats changed.

## Release evidence

Before tagging 2.7.7, create the retrospective annotated `v2.7.6` tag at
commit `b92dc26b8acd18767bfdb5ad01d7247b4d72ad84`. The annotation must say that
the tag was created after publication and record the retained public-package
SHA-256:

`ab3b5ce3e1dc71832abf3785a3e154f273004fb9091f630a9fa63e25066e3069`

For 2.7.7:

1. Require all source gates and post-merge CI to pass.
2. Create annotated tag `v2.7.7` at that reviewed merge commit.
3. Package from a clean checkout of the tag with
   `./extension/package-extension.sh`.
4. Verify source/archive byte equality and retain
   `dist/ClassPilot-v2.7.7.zip` plus its generated SHA-256 record.
5. Test that exact package on at least two controlled Chromebooks using the
   production school configuration.
6. Submit to Chrome Web Store with deferred publishing. Submission alone does
   not update devices.
7. After review, repeat the controlled-device test and publish. The public
   Store update then rolls out automatically to the single managed school;
   offline devices update after reconnecting and checking for updates.

Monitor installed versions, capability heartbeats, service-worker errors,
Waypoint/tab-limit behavior, multi-window focus, and Flight Path through one
normal school day. If a serious regression requires a Store rollback, publish
the rollback under a higher accepted version such as `2.7.7.1`.
