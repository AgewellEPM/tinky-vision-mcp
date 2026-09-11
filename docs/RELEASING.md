# Release and submission

The product comprises two independent stdio MCP servers distributed as companion MCPB bundles. Native helpers are built from the staged source and signed with the publisher's available Developer ID. Manifests, artifacts and checksums are versioned. The artifact directory must contain only application source, dependencies, native binaries, documentation, icons and license notices; never copy live logs, captures, credentials or VM disks into it.

Use `mcpb validate` and `mcpb pack` for the manifests in `packaging/`. Bind the scoped helper integrity manifest after native signing. Run the Node protocol tests, scoped native tests and selected IsolatedTester protocol tests; record the limits of those checks. Publish the exact resulting files and SHA256SUMS to the versioned GitHub release.

Anthropic: submit through the desktop-extension form linked from https://claude.com/docs/connectors/building/submission. A Google sign-in is currently required. Include the release URL, README, privacy policy, icon, author credit and reviewer guide. Do not mark the submission completed until the form returns a confirmation.

MCP Registry: use each generated server descriptor's MCPB release URL and SHA-256. Authenticate with the official publisher, publish the descriptors, and verify both names through the public Registry API. Registry publication and Anthropic acceptance are separate statuses.
