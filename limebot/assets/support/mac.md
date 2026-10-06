---
aliases: darwin, m
emoji: 🍎
---

## Download

- **Apple Silicon (M1/M2/M3/M4):** `/dist/LimeyV1Installer-cli-macos-arm64`
- **Intel:** `/dist/LimeyV1Installer-cli-macos-amd64`

Grab them from the [install page](/install) or the GitHub releases page.

## Install

```sh
cd ~/Downloads
chmod +x LimeyV1Installer-cli-macos-arm64   # or -amd64
./LimeyV1Installer-cli-macos-arm64
```

Pick your Discord install, choose **Install Limey V1**, then restart Discord.

## "Can't be opened" / "Apple cannot check it for malicious software" / "damaged"

The installer is not code-signed (no paid Apple Developer license), so macOS Gatekeeper blocks apps and binaries you download from the internet. This is expected and safe to bypass **for this installer only**.

**Option 1 — remove the quarantine flag (recommended):**

```sh
xattr -d com.apple.quarantine LimeyV1Installer-cli-macos-arm64
```

(add `sudo` if it complains about permissions), then run it as above.

**Option 2 — right-click Open:** right-click (or Control-click) the binary in Finder and click **Open**, then confirm **Open** in the dialog.

**Option 3 — System Settings:** if macOS says the app "cannot be checked for malicious software" and gives no Open option, go to **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the blocked installer.

> If macOS says the file is **"damaged"**, that's the same quarantine flag — Option 1 fixes it.
>
> Re-running the installer after a Discord update or a Limey V1 update re-downloads the file, so you may need to repeat the `xattr` step.
