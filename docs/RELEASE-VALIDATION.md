# Release validation — 2026-09-11

Early-access package release: TinkyVision 0.2.0 and IsolatedTester 1.2.1, Apple silicon/macOS 14+.

| Check | Result |
|---|---|
| TinkyVision native release build | Passed |
| IsolatedTester native release build | Passed; existing Swift concurrency warnings remain |
| TinkyVision Node tests | 59 passed, 0 failures before the final read-only environment test |
| Final targeted MCPB setting, catalog and image-delivery checks | 3 passed, 0 failures |
| TinkyVision scoped native tests | 15 passed, 0 failures |
| Selected IsolatedTester protocol, OCR, ASCII, evidence and policy tests | 49 executed, 1 optional demonstration skipped, 0 failures |
| Manifest schema and icon checks | Both passed |
| Final native signatures | All three verified outside the restricted shell sandbox |
| Final MCPB archives | CRCs and paths checked; extracted IsolatedTester catalog and TinkyVision helper integrity checked |

Node protocol tests use fixture helpers. The image test verifies MCP PNG bytes and rejects invalid image data. The IsolatedTester tests do not launch an app or VM; the optional ASCII demonstration needs a manually supplied image and was skipped. These checks do not establish that every exposed tool works on a fresh customer machine.

The installed IsolatedTester setup check reported macOS permissions granted and zero sessions; TinkyVision reported Accessibility permission granted. An isolated Safari session was created for the Anthropic form. Input was refused by the installed self-protection guard, so navigation and submission did not proceed. The session was stopped and Safari/guest process cleanup was verified. No alternative browser automation was used.

Clean-install Claude Desktop acceptance, a complete live per-tool exercise, and notarization remain unverified. Native release files are signed with the available Developer ID; the MCPB archives are not independently signed with an MCPB signing certificate. This is an early-access release, not an Anthropic verification or production-readiness claim.
