# macOS test plan

Everything below has been built and tested on Linux, but **has never run on macOS**. This plan covers the first
session on a Mac: check that GitHub builds the macOS installers (so a tagged release will include them), run the app
from source and from the built installer, then work through the checklist, fixing what breaks. Windows is covered
by CI (see the end).

## 1. Build the macOS installers on GitHub (what a tagged release does)

A release runs when a version tag is pushed, and builds Linux, macOS (Apple silicon) and Windows. To check
the macOS builds **without publishing anything**, run the same workflow by hand:

1. On GitHub, open **Actions › Release › Run workflow**, keep **Publish** unticked, and choose **Run workflow**.
2. Wait for the four build jobs. Each one is a separate machine; a red job's log shows the failing step. The macOS
   jobs also run the smoke test (`node scripts/smoke-app.mjs`): the built app must start its engine, serve its page
   and stop cleanly.
3. The installers are attached to a **draft** release (Releases page, visible only to maintainers): download the
   `.dmg` (`aarch64`, Apple silicon) and install it as in step 3 below.

A manual run with Publish unticked never makes the release public; delete the draft afterwards. A real release is
`git tag v0.1.0 && git push origin v0.1.0` once everything here passes.

## 2. Set up the Mac to build from source

```bash
xcode-select --install                                     # Apple's command-line tools (compiler, linker)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust; rust-toolchain.toml installs 1.98.1 on first use
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"   # Bun, the version CI uses
brew install node                                          # Node 24 or later, for the engine in development

git clone https://github.com/liberuum/knowledge-vault-app.git
cd knowledge-vault-app
bun install
```

Open a new terminal after installing Rust and Bun so they are on the `PATH`.

## 3. Run it, then build and install it

**Development** — the engine starts on 4201, the page on 4200, then the window opens; data goes to `.dev-data/`
inside the repository:

```bash
bun run dev
```

The terminal shows the engine's output (`[sidecar] …`) and the shell's (`[shell] …`). The first run downloads the
macOS Node the app bundles (checksum-verified) and compiles the shell, which takes a few minutes.

**The installer** — the `.app` and `.dmg` for this Mac, then the same smoke test the release runs:

```bash
bun run build:app      # src-tauri/target/release/bundle/dmg/*.dmg and bundle/macos/Knowledge Vault.app
bun run smoke:app      # starts the built app on a throwaway data folder: engine ready, page served, clean stop
```

While `build:app` makes the `.dmg`, it mounts a temporary volume (`dmg.XXXXXX`) and opens a Finder window on it to
lay out the icons. Leave that window alone: dragging the app out of it copies an incomplete app (Finder error -43, or
an engine that fails with *Cannot find package*) and makes the build fail with *Resource busy*. `CI=true bun run
build:app` skips the Finder step, as the release workflow does.

Open the `.dmg` and drag **Knowledge Vault** to Applications. The app is ad-hoc signed, not notarised: the first time
you open it, macOS blocks it — go to **System Settings › Privacy & Security** and choose **Open Anyway**.

The installed app keeps its data in `~/Library/Application Support/io.github.liberuum.knowledge-vault-app/`
(`vault/logs/` has the engine's and the shell's logs). Close a development app before opening the installed one:
only one Knowledge Vault runs at a time.

## 4. Checklist

Work through these in the built app (step 3), not only in development: packaging is where platforms differ most.
Tick each one, and note what you saw when it fails.

### Start and stop

- [ ] **The app opens and the landing shows "Ready".** The engine is the bundled Node (`Contents/MacOS/kv-node`)
      running `Contents/Resources/sidecar/`. If it stays on "Starting the engine…", the engine log says why.
- [ ] **Closing the window keeps the app in the menu bar** (the tray icon), with Open, the engine's state and Quit.
- [ ] **Quit from the menu bar and Cmd+Q both stop the engine.** After quitting, nothing listens on 4201/4202
      (`lsof -i :4201`).
- [ ] **Opening the app a second time** brings the first window forward instead of starting a second app.
- [ ] **The window remembers its size and position** after a restart.
- [ ] **A crash recovers:** kill the engine (`pkill -f "Resources/sidecar"`); the app shows "Restarting the
      engine…" and comes back.

### Vaults and the pipeline

- [ ] **Create a vault**, open it, and go back to the landing; its tile shows its notes as a small map.
- [ ] **Settings › Models:** save an OpenRouter key (or a local model address) and press Validate.
- [ ] **Queue a source** with a few related points: within two minutes it has notes, links, a HUB named after the
      vault and a topic map. The processing label at the top of the vault opens the live run in Workflow Studio.
- [ ] **Search and chat** answer from the new notes.

### Files

- [ ] **Add a PDF as a source**, then **View original**: the PDF shows in the viewer (macOS's own PDF view).
- [ ] **Download** (next to the original, and in a document's toolbar): the Save dialog opens in Downloads; the
      file lands where you chose; the notice names the folder.
- [ ] **Choose files** in a vault's source intake opens the macOS file picker.
- [ ] **Text, Markdown and image originals** show inline in the viewer.
- [ ] **Settings › Conversion** says honestly what is available. The extra converter (Word, scanned PDFs) has no
      macOS build yet: the page should offer a conversion server instead, not an install button that fails.

### Identity and remote vaults

- [ ] **Settings › Identity › Sign in with Renown** opens the browser, and after signing the app shows your address.
- [ ] **Connect remote vault** with a shared vault you have access to; it opens and shows its notes.
- [ ] **Chat › Connect with OpenRouter** opens the browser and, after signing in, the chat is connected — the
      browser tab says you can close it.
- [ ] **Protect local vaults** (Settings › Vaults) restarts the engine in protected mode; vaults still open.

### Data and maintenance

- [ ] **Settings › Vaults › Back up now**, then **Restore** that backup.
- [ ] **Export** a vault: the files appear in the app's `exports/` folder (*Show* reveals it in Finder).
- [ ] **Settings › Diagnostics** shows the engine's state and log lines; *Copy* gives a report without your home path.

## 5. Where macOS is most likely to differ

Starting points if something above fails:

| Area | Code | Why it might differ on macOS |
|---|---|---|
| Finding its own leftover processes after a crash | `sidecar/src/process-identity.ts` | Uses `ps -o command=` on macOS (`/proc` on Linux). |
| The Save and Open dialogs | `src-tauri/src/lib.rs` (downloads), `download.rs` | macOS uses the native panels; on Linux the portal is forced with `GTK_USE_PORTAL`, which does nothing here. |
| Downloads finishing | `src-tauri/src/lib.rs` `DownloadEvent::Finished` | macOS reports no path when a download finishes; the app falls back to the path it chose. |
| Quit and the menu bar | `src-tauri/src/tray.rs`, `lib.rs` (`RunEvent::Exit`) | Cmd+Q arrives as an app exit, not a window close. |
| The bundled Node | `src-tauri/entitlements.plist`, `scripts/fetch-node.mjs` | Node is a separate binary inside the app; Gatekeeper and code signing treat it on its own. |
| The page's security policy | `src-tauri/src/host_server.rs` (`CSP`) | WKWebView applies it to the PDF frame; it must allow the app's own content. |
| The packaged engine | `scripts/stage-sidecar.mjs`, `scripts/lib/prune.mjs` | Strips other platforms' native files; a wrongly stripped macOS file breaks the engine at start. |

## 6. Windows

There is no Windows machine for hands-on testing, so Windows is checked by GitHub Actions:

- **Every push** compiles and lints the shell on Windows (`ci.yml`, job `windows-shell`).
- **A release run** (`release.yml`) builds the Windows installer (`.exe`, NSIS, per-user install).
- **Not yet checked anywhere:** that the installed app starts and its engine comes up on Windows. The smoke test
  (`scripts/smoke-app.mjs`) reads Linux and macOS process details and needs a Windows path before it can run there.
  Until then, someone with a Windows PC should install a release build and go through the checklist above.
