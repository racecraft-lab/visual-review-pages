# Argos Peer Review Parity

This app is a static replacement for the review experience Mission Control used
to get through Argos.

Argos' public visual testing page describes review-speed features that matter to
PR reviewers: side-by-side and overlay views with synchronized zoom, a changes
highlighter, snapshot context, diff grouping, keyboard shortcuts, approval
reuse, review history, and GitHub check/status integration.

Static Pages cannot provide server-side approval history, permission-aware
approvals, or native GitHub required check conclusions by itself. Mission
Control therefore splits the replacement into two surfaces:

- CI and reg-viz/reg-actions produce the baseline/current/diff assets and keep
  required GitHub checks green or red.
- This static app makes the generated artifacts easy to inspect, triage,
  approve locally, and summarize back into the PR review.

Source reference: https://argos-ci.com/visual-testing

