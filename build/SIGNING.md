# macOS code signing & notarization — **local** (cert never leaves your Mac)

Seamless macOS auto-update and removing the "unidentified developer" warning require
the app to be **signed with a Developer ID + notarized by Apple**. We do this
**locally on your Mac** — the certificate stays in your **Keychain** and **never goes
to GitHub** (no secrets uploaded).

> Windows/Linux already auto-update seamlessly, unsigned. This is macOS-only.
>
> The CI release (on a `v*` tag) builds macOS **unsigned (ad-hoc)**. To ship a signed
> macOS build, run the local command below and upload the signed `.dmg` to the
> Release (replacing the unsigned mac assets).

## 1. One-time — get the certificate into your Keychain

Requires the **Apple Developer Program** ($99/yr), as the **Account Holder**.

**Easiest — Xcode:** Xcode → **Settings → Accounts** → sign in → select your Team →
**Manage Certificates… → `+` → Developer ID Application**. The cert + private key land
in your Keychain.

**Or the website:** make a CSR (**Keychain Access → Certificate Assistant → Request a
Certificate From a Certificate Authority…** → _Saved to disk_), upload it at
[developer.apple.com](https://developer.apple.com/account) → **Certificates → `+` →
Developer ID Application**, download the `.cer`, double-click to install.

> Greyed out? You must be the **Account Holder** and accept any pending **Agreements**
> (developer.apple.com → Account → Agreements).

Confirm it's installed:

```bash
security find-identity -v -p codesigning   # should list "Developer ID Application: …"
```

## 2. One-time — notarization credentials

- **App-specific password**: [appleid.apple.com](https://appleid.apple.com) → _Sign-In
  and Security_ → **App-Specific Passwords** → generate (e.g. "orkestral-notarize").
- **Team ID**: developer.apple.com → **Membership** (10 chars, e.g. `AB12CD34EF`).
- **Apple ID**: your account email.

## 3. Build a signed + notarized macOS release (each release)

On your Mac, with the cert in your Keychain:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="AB12CD34EF"

npm run dist:mac:signed
```

This builds, **auto-discovers your Developer ID cert from the Keychain**, signs with
Hardened Runtime + the entitlements, and **notarizes** (the `afterSign` hook). The
signed `.dmg` / `.zip` land in `dist/`. (First notarization can take a few minutes —
it's printed in the log.)

## 4. Publish the signed mac build

Upload the signed mac assets to the GitHub Release of that tag, replacing the CI's
unsigned ones:

```bash
gh release upload v<version> \
  dist/Orkestral-*-arm64.dmg dist/Orkestral-*-arm64.dmg.blockmap \
  dist/Orkestral-*-arm64.zip dist/Orkestral-*-arm64.zip.blockmap \
  dist/latest-mac.yml --clobber
```

Now macOS users get a **signed app** (no Gatekeeper warning) and **seamless
auto-update**.

---

## Why not GitHub Secrets / CI signing?

You _can_ sign in CI by adding the cert (`.p12` base64) + Apple creds as **GitHub
Secrets** — they're encrypted, build-only, never exposed, and the public repo can't
read them (it's the standard way). But to keep the certificate **100% on your Mac**,
we sign **locally** instead. The CI release stays unsigned; you replace the mac assets
with the signed ones.

## How it's wired (reference)

- `build/entitlements.mac.plist` — Hardened Runtime entitlements for Electron +
  node-llama-cpp.
- `build/notarize.cjs` — `afterSign` hook; notarizes **only** when `APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` are set (skips silently otherwise, so
  the CI and the plain `dist:mac` build are unaffected).
- `package.json` → **`dist:mac:signed`** enables `hardenedRuntime` + entitlements via
  `-c` flags; the signing identity comes from your Keychain.
- `.github/workflows/release.yml` — CI stays unsigned (`CSC_IDENTITY_AUTO_DISCOVERY:
false`); no cert, no secrets on GitHub.
