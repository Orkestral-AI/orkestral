# Security Policy

Orkestral is a **local-first** desktop application (Electron) that runs AI agents
capable of executing code and shell commands on your machine. We take the
security of the app and its users seriously and appreciate responsible
disclosure of vulnerabilities.

## Supported Versions

Security fixes are provided for the **latest released version** of Orkestral.
Please make sure you are running the most recent release before reporting an
issue, and update promptly when new releases are published.

| Version        | Supported              |
| -------------- | ---------------------- |
| Latest release | ✅ Yes                 |
| Older releases | ❌ No (please upgrade) |

## Reporting a Vulnerability

**Please report security vulnerabilities privately. Do NOT open a public
GitHub issue, discussion, or pull request for a security problem**, as that
could expose other users before a fix is available.

Instead, email us at:

**security@orkestral.app**

If you would like to encrypt your report, request our PGP key in an initial
(non-sensitive) email and we will provide it.

### What to include

To help us triage and reproduce the issue quickly, please include as much of
the following as you can:

- A clear description of the vulnerability and its potential impact.
- The Orkestral version, operating system, and environment where you observed it.
- Step-by-step reproduction instructions or a proof-of-concept.
- Any relevant logs, screenshots, stack traces, or sample configurations
  (with secrets redacted).
- Your assessment of severity and any suggested remediation, if available.

Please **do not** include real secrets, API keys, or sensitive customer data in
your report.

## Our Process & Coordinated Disclosure

- **Acknowledgement:** We aim to acknowledge your report within **72 hours**.
- **Triage:** We will assess severity and provide an initial response with next
  steps, typically within a few business days of acknowledgement.
- **Updates:** We will keep you informed of remediation progress and a target
  timeline for a fix.
- **Disclosure:** We follow **coordinated disclosure**. We ask that you give us
  a reasonable period to release a fix before any public disclosure, and we will
  work with you on timing. With your permission, we are happy to credit you for
  the discovery once the issue is resolved.

## Security Model

Orkestral is designed around a local-first trust boundary. A few properties are
important to understand when assessing the app's security posture:

- **Local code execution is by design.** Orkestral runs AI agents that can read
  and write files and execute code and shell commands **on the user's own
  machine, with the user's own privileges**. This is core functionality, not a
  vulnerability in itself. The primary attack surface is therefore anything that
  could cause the app to execute unintended actions — for example, prompt
  injection from untrusted content, malicious tool/agent configurations, or
  unsafe handling of agent-generated commands. Reports that demonstrate a way to
  bypass user intent, confirmation, or sandboxing controls are in scope and very
  welcome.
- **Your code stays local.** Orkestral does not send your source code to the
  cloud. Code remains on your machine; only the data you explicitly direct an
  agent or model provider to use leaves the device.
- **Secret handling.** Tool secrets (such as API keys) are encrypted at rest
  using Electron's
  [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage),
  which is backed by the operating system's keychain/credential store
  (Keychain on macOS, DPAPI on Windows, and the platform secret service on
  Linux). Secrets are never exposed to the renderer process or to remote
  servers operated by Orkestral. Because `safeStorage` derives its protection
  from the OS user account, the confidentiality of stored secrets ultimately
  depends on the security of the user's machine and login session.

If you discover a way to defeat any of these protections — exfiltrate code,
recover secrets, escalate privileges, or trigger code execution outside the
intended user-confirmation flow — please report it via the private channel
above.

---

Thank you for helping keep Orkestral and its users safe.
