# Security

NotaBene is local-first and collects no telemetry. Notes, attachments, versions,
settings, and credentials remain on the Mac unless the user explicitly exports
them or sends selected note content to a configured AI provider.

## Supported version

Security fixes are provided for the latest release.

## Reporting a vulnerability

Please use GitHub’s private vulnerability-reporting flow rather than a public
issue. Do not attach a real NotaBene database, note export, API key, or pairing
token. Include the affected version, macOS version, reproduction steps, and the
least-sensitive proof needed to demonstrate impact.

## Security boundaries

- API keys use macOS Keychain, with a `0600` app-data fallback.
- The MCP server binds to loopback, validates `Host`, requires a pairing token,
  exposes no permanent-delete tool, and sends writes through the versioned
  command layer.
- Imported libraries and model-generated structured content are schema-checked.
- The webview CSP denies objects and forms and restricts scripts to the app.
- Backups and exports have no representation for credentials.

Code signing, notarization, and signed auto-updates are intentionally deferred;
an unsigned build should not be represented as a trusted public download.
