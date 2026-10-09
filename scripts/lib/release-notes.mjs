/** The release body (spec §11): what the build contains, from the manifests it was built from. */
export function releaseNotes({ app, stack, vaultPackage, node, whatsNew }) {
  return [
    `Knowledge Vault ${app} — the Powerhouse Knowledge Vault on your own computer.`,
    "",
    // What changed, in the users' words (docs/releases/<version>.md), when the release has one.
    ...(whatsNew?.trim() ? [whatsNew.trim(), ""] : []),
    "### Built from",
    `- Powerhouse stack **${stack}**`,
    `- @powerhousedao/knowledge-note **${vaultPackage}**`,
    `- Node **${node}** (bundled)`,
    "",
    "### Installing",
    "Pick the file named for your system: `…_Linux_x86-64`, `…_macOS_Apple-silicon` or `…_Windows_x64-setup`.",
    "- **Linux** (glibc 2.34+: Ubuntu 22.04, Debian 12, Fedora, RHEL 9 and newer): the `_Linux_x86-64.AppImage` runs as is (`chmod +x`, then open it); the `_Linux_x86-64.deb` installs with `sudo apt install ./<file>.deb`.",
    "- **Windows 10/11 (64-bit):** run the `_Windows_x64-setup.exe`. It is not signed yet: if SmartScreen warns you, choose **More info › Run anyway**.",
    "- **macOS 13.5+ (Apple silicon):** these builds are ad-hoc signed, not notarised, so macOS blocks the first launch. Open the `_macOS_Apple-silicon.dmg` and drag the app to Applications, then open it. When macOS says it *could not verify* the app, choose **Done** — not *Move to Bin*, which deletes it. Then open **System Settings › Privacy & Security**, scroll to *Security*, choose **Open Anyway** next to Knowledge Vault and confirm with your password. From then on it opens normally. (Or, in Terminal: `xattr -dr com.apple.quarantine \"/Applications/Knowledge Vault.app\"`.)",
    "",
    "Your vaults live in the app's data folder and are kept across updates; a backup is made before a new version opens them.",
  ].join("\n");
}

export function sizeLine(name, bytes) {
  return `| ${name} | ${Math.round(bytes / 1e6)} MB |`;
}

const INSTALLER = /\.(AppImage|deb|dmg)$/;
const SECTION = "\n\n### Installers\n";

/** The notes with one installers table (replacing any previous one, so a re-run never appends a second). */
export function withSizes(body, assets) {
  const base = body.includes(SECTION) ? body.slice(0, body.indexOf(SECTION)) : body.trimEnd();
  const rows = assets.filter((a) => INSTALLER.test(a.name)).map((a) => sizeLine(a.name, a.size));
  return `${base}${SECTION}| File | Size |\n|---|---|\n${rows.join("\n")}\n`;
}

/** What a .deb (from `dpkg-deb -c`) would install into /usr/bin. */
export function debBinaries(listing) {
  return listing
    .split("\n")
    .map((l) => /(?:^|\s)(?:\.\/)?usr\/bin\/([^/\s]+)$/.exec(l.trim())?.[1])
    .filter(Boolean);
}
