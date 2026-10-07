# Contributing to Knowledge Vault

Thanks for helping. This guide covers building the app from source and working on it. For what the app does and how
to use it, see the [README](README.md).

## How the app is put together

| Part | Folder | What it is |
|---|---|---|
| **Shell** | `src-tauri/` | A [Tauri 2](https://tauri.app) app in Rust: the window, the tray, the app's page server, and the engine's lifecycle (start, supervise, restart, stop). |
| **Engine** | `sidecar/` | A Node program that runs a Powerhouse Switchboard with the Knowledge Vault package: the vaults' database (PGlite), the graph index, the workflow runtime that runs the pipeline, and a small control API the shell and the page use. |
| **Page** | `host/` | The React app in the window: the landing, settings, and the mounted Knowledge Vault app and Workflow Studio. It talks to the engine over GraphQL and the control API. |
| **Scripts** | `scripts/` | The development loop, packaging (staging the engine, fetching Node), checks and smoke tests. |

The installers bundle their own Node (24 LTS) for the engine, so users install nothing else.

The Knowledge Vault app itself — its document models, editors, the pipeline's workflow piece — comes from the
published package `@powerhousedao/knowledge-note`, pinned in `host/package.json` and `sidecar/package.json` and
resolved from the Powerhouse registry (`bunfig.toml` and `.npmrc` route the `@powerhousedao` scope to
`https://registry.vetra.io`). Updating it is a version bump plus `bun install`.

## Requirements

- [Bun](https://bun.sh) 1.3 or later (the package manager and script runner)
- Node 24 or later (the engine runs on Node)
- Rust (the version in `rust-toolchain.toml`) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  for your system

## Develop

```bash
bun install
bun run dev              # the engine on 4201, the page on 4200, and the app window
bun run dev -- --no-shell   # the same without the window: open http://127.0.0.1:4200 in a browser
```

Development uses its own data folder, `.dev-data/`, so it never touches an installed app's vaults.

Checks:

```bash
bun run tsc          # type check
bun run test         # unit tests
bun run e2e          # end-to-end tests against a real engine (Playwright)
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

Demo data for screenshots and manual testing (with the development loop running):

```bash
node scripts/seed-demo-vault.mjs --name "Research notes" --size large
node scripts/seed-demo-vault.mjs --name "Team wiki" --size small
```

### Working on the Knowledge Vault package at the same time

Point both dependencies at your checkout for the session —
`"@powerhousedao/knowledge-note": "file:../../bai-knowledge-note"` — run `bun install`, and after each rebuild of the
package clear Vite's cache (`rm -rf host/node_modules/.vite`). Switch back to a published version before committing:
installers and CI only build from published versions.

## Build an installer

```bash
bun run build:app     # the installer for this machine, in src-tauri/target/release/bundle/
bun run smoke:app     # starts the built app on a throwaway data folder and checks it comes up and stops cleanly
```

`build:app` checks that the version agrees across `package.json`, `Cargo.toml` and `tauri.conf.json`, builds the page
and the engine, stages the engine with production dependencies only, fetches the bundled Node (checksum-verified) and
runs `tauri build`.

**Linux builds to share** should come from `scripts/build-linux-docker.sh`, which builds inside Ubuntu 22.04 like the
release workflow: a build made on a newer distribution links against its newer C library and will not run on older
ones.

macOS and Windows installers are built by the release workflow on GitHub's macOS and Windows machines; there is no
cross-building from Linux.

## Releases

A release is made on purpose: bump the version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` (a version that already has a release is refused), commit, then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow builds Linux, macOS (Apple silicon) and Windows installers into a draft release,
checks them, and publishes the release only when every build succeeded. To test the builds without releasing, run it
by hand (**Actions › Release › Run workflow**, Publish unticked): the installers land in a draft release that stays
private. Pushes to
`main` and pull requests run the checks (`ci.yml`), including a Windows compile of the shell.

## License

By contributing you agree that your contributions are licensed under the
[GNU Affero General Public License v3.0](LICENSE).
