# Privacy Policy — TinkyVision + IsolatedTester

Effective date: September 11, 2026. Publisher: Luke Kist / TinkyBink, GitHub account AgewellEPM. This policy describes the local MCP software distributed from this repository. It does not replace the policies of your AI client, model provider, or applications you operate.

## Data processed

Tools can capture screen pixels, recognize text, enumerate application/window identities, read accessibility trees, receive input text and coordinates, and record tool actions, objectives, timing, and session evidence. Captures can include personal or confidential information visible in the selected screen or app. OS permission grants determine available capabilities.

## Use and sharing

The tools use this information to provide observation, automation, testing, and reports requested through an MCP client. Tool results are returned to that client. The client may send screenshots, OCR, accessibility text, or reports to its configured model provider. Direct MCP image tools explicitly include image bytes in their responses.

IsolatedTester's optional autonomous test agent can send objectives, screenshots, and test context to Anthropic or OpenAI using configured credentials; a Claude Code provider is also implemented. Those services process requests under their own terms and privacy policies. Interactions with third-party applications may cause those applications to transmit or store data under their own policies. Optional GhostBridge remote operations move observations, input, or requested files through the configured authenticated remote session.

The extensions do not require a TinkyBink cloud account or a publisher-hosted inference endpoint. This statement does not mean that using a hosted MCP client or an autonomous test provider is offline. The publisher receives material you deliberately submit through support channels; there is no requirement to submit captures for support.

## Local storage and retention

TinkyVision saves captures in its local cache or a caller-selected output path and writes an audit log under `~/Library/Logs/tinky-vision-mcp/`. Audit text redaction and rotation are implemented. By default, rotation occurs around 5 MB and retains five rotated logs; rotation is checked periodically, so these are not strict byte ceilings. Settings may change these values.

IsolatedTester stores captures and session metadata under `~/.isolated-tester/`; flipbook exports use `~/.kist/visual-flipbooks/`. Session videos, action records, evidence manifests, and exports may persist after a session stops. A 300-frame rolling history at 1 FPS overwrites its oldest frames while recording; it does not automatically delete independent exports, videos, or logs after five minutes.

Optional TinkyStream archives retain timestamped video segments. The archive does not automatically delete old segments; its configured disk reserve can pause further archival. Continuous TinkyStream services are not automatically installed by these extensions.

## Your controls and deletion

Choose the app/window or session you expose, grant or revoke macOS Screen Recording and Accessibility permissions, use TinkyVision read-only mode, deny or revoke control grants, and stop sessions/recordings when finished. After stopping the relevant tools, delete captures, logs, videos, and exports you no longer need from the documented storage locations and any custom output locations. Uninstalling an extension does not establish that independent evidence files or copies sent to another provider have been deleted.

Delete hosted conversations or contact the relevant provider under its own retention/deletion controls for data already transmitted there. Never include credentials or sensitive footage in public bug reports.

## Contact and updates

For privacy questions, use [the project's support channel](https://github.com/AgewellEPM/tinky-vision-mcp/issues) to request contact without posting sensitive details, or contact the publisher through [AgewellEPM](https://github.com/AgewellEPM). Policy changes are versioned in this repository. Review the policy associated with the release you install.
