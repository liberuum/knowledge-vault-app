# Release signing

What a release carries, and how to check it. Linux files are signed with the project's **release key**
(a GPG key held as a repository secret); Windows and macOS are not code-signed yet (see the end).

| File | What proves it | How to check |
|---|---|---|
| Every file | `SHA256SUMS` lists each file's SHA-256; `SHA256SUMS.asc` is its signature with the release key | `gpg --verify SHA256SUMS.asc SHA256SUMS`, then `sha256sum --check --ignore-missing SHA256SUMS` |
| `…_Linux_x86-64.AppImage` | The same release key's signature, embedded in the AppImage | `./Knowledge-Vault_<version>_Linux_x86-64.AppImage --appimage-signature` |
| `…_Linux_x86-64.AppImage`, `…_Linux_x86-64.deb` | GitHub build provenance: built by this repository's release workflow from the tagged commit | `gh attestation verify <file> --repo liberuum/knowledge-vault-app` |

A release made before the release key existed has `SHA256SUMS` and the build provenance only.

## Checking a download

1. Import the release key and compare its fingerprint with the one below:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/liberuum/knowledge-vault-app/main/docs/release-signing-key.asc | gpg --import
   gpg --fingerprint "Knowledge Vault releases (liberuum)"
   ```

   **Release key fingerprint:** _not published yet_

2. Download `SHA256SUMS` and `SHA256SUMS.asc` from the same release, next to the file you downloaded.
3. `gpg --verify SHA256SUMS.asc SHA256SUMS` must say **Good signature from "Knowledge Vault releases
   (liberuum)"**. A warning that the key "is not certified with a trusted signature" only means you have not
   signed the key yourself; the fingerprint check in step 1 is what matters.
4. `sha256sum --check --ignore-missing SHA256SUMS` must say **OK** for your file.

With a checkout of this repository and Node, `node scripts/verify-appimage.mjs <file.AppImage> <fingerprint>`
verifies the AppImage's embedded signature itself: what it signs is the SHA-256 of the file with its two
signature sections zeroed.

With the [GitHub CLI](https://cli.github.com) you can also check where a Linux file was built:
`gh attestation verify Knowledge-Vault_<version>_Linux_x86-64.AppImage --repo liberuum/knowledge-vault-app`.

## Setting up the release key (maintainer, once)

Until the secret below exists, releases build unsigned, as they always have; the next release after it
signs. Run these on your own machine — the private key never needs to leave it except into the secret.

```sh
# 1. The key: ed25519, signing only, valid three years. Choose a passphrase and keep it with the backup.
gpg --quick-gen-key "Knowledge Vault releases (liberuum)" ed25519 sign 3y
FPR=$(gpg --batch --with-colons --list-secret-keys "Knowledge Vault releases (liberuum)" | awk -F: '$1 == "fpr" { print $10; exit }')
echo "$FPR"

# 2. The public key into the repository; put "$FPR" (spaced in groups of four) in this file's step 1
gpg --armor --export "$FPR" > docs/release-signing-key.asc

# 3. The private key and its passphrase as repository secrets (the release workflow reads both)
gpg --armor --export-secret-keys "$FPR" | gh secret set RELEASE_GPG_PRIVATE_KEY --repo liberuum/knowledge-vault-app
gh secret set RELEASE_GPG_PASSPHRASE --repo liberuum/knowledge-vault-app   # prompts for the passphrase

# 4. A backup, kept offline with the revocation certificate gpg wrote to ~/.gnupg/openpgp-revocs.d/$FPR.rev
gpg --armor --export-secret-keys "$FPR" > knowledge-vault-release-key.private.asc
```

Then commit `docs/release-signing-key.asc` and the fingerprint. Before the key expires, extend it
(`gpg --quick-set-expire "$FPR" 3y`), export the public key again and update the secret. If the key is
ever exposed: publish its revocation certificate, make a new key, and replace both secrets and the files here.

How the workflow uses it (`.github/workflows/release.yml`): the Linux build imports the key and sets
`LDAI_SIGN`/`LDAI_SIGN_KEY`, so linuxdeploy signs the AppImage (and refuses to build an unsigned one); then
`node scripts/verify-appimage.mjs <file> <fingerprint>` verifies the embedded signature against the file and
requires the signer to be the release key. The publish job downloads every file of the draft release, writes
`SHA256SUMS`, signs it, verifies the signature and uploads both.

## What signing does not change

- **Software centres.** KDE Discover shows a downloaded `.deb` as "Unknown author" with an unknown license
  whatever the package carries; only an app from a catalog (Flathub, the Snap Store, an apt repository) shows
  its developer there.
- **The in-app update** checks that a download is one of this app's release files and has the expected size;
  it does not check the signature yet.
- **Windows and macOS** are not signed yet. Windows needs an Authenticode certificate (SmartScreen warns about
  an unknown publisher until then); macOS needs an Apple Developer ID and notarisation (Gatekeeper blocks the
  first launch until then — see the README).
