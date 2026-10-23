# Vault

Private Markdown notes that live in your browser, are encrypted before they leave it, and sync through a small Cloudflare Worker into a private GitHub repository.

Vault is an installable web app (PWA) with an Obsidian-style editor: live preview, `[[wikilinks]]`, backlinks, tags, tasks, tables, images, daily notes and templates. It works offline, and nothing readable is ever stored on the server or in GitHub.

> **Security note:** the encryption is a custom protocol built from Web Crypto primitives. It has not been independently audited. See [SECURITY.md](SECURITY.md) for the full design and its limits.

## How it works

```
 Browser (static app)                 Cloudflare Worker              GitHub (private repo)
 ────────────────────                 ─────────────────              ─────────────────────
 password → keys (PBKDF2)             keyless transport              e2ee/head.json
 encrypt / decrypt (AES-GCM)  ─────►  validates, rate-limits  ─────► e2ee/objects/<id>/<rev>.enc
 IndexedDB cache (encrypted)          never sees plaintext           (ciphertext only)
```

- **The browser is the only place plaintext exists.** Notes, file names, folder names and image bytes are encrypted on your device.
- **The Worker holds no key and no password.** It checks request shapes, sizes and key-epoch transitions, rate-limits sign-in, and writes opaque blobs to GitHub with its own repository token.
- **GitHub is a dumb object store.** The repository contains a public header (`e2ee/head.json`) and immutable encrypted objects. Git history keeps older encrypted revisions.
- **One password** unlocks the device. A separate random access secret, wrapped inside the vault keys, is what authenticates to the Worker, so the server never receives anything derived from your password.

## Features

**Editing**
- Live-preview Markdown on CodeMirror 6: syntax is hidden except where you are editing. `Ctrl/Cmd+E` switches to plain source.
- GitHub-flavoured Markdown with `[[wikilinks]]`, `[[Note#Heading|alias]]`, `[[#Heading]]`, and nested `#tags/like/this`.
- Tables edited cell by cell, with an insert-table grid picker.
- Fenced code blocks with syntax highlighting for about 30 languages and a copy button.
- Task lists (`- [ ]`) with a cross-note Tasks view that ticks items in place.
- `[[` and `#` autocomplete, an outline panel, and a right-click or long-press context menu.

**Organising**
- Folder tree, full-text search (including `#tag` search), a quick switcher and a command palette.
- Backlinks under each note. Renaming a note rewrites links to it in other notes.
- **Spaces:** separate sets of notes, each a top-level folder, with names stored encrypted.
- **Daily notes:** `Daily/YYYY-MM-DD`, created from `Templates/Daily` if present.
- **Templates:** any note in `Templates/`, with `{{title}}`, `{{date}}`, `{{time}}` and `{{date:YYYY-MM-DD HH:mm}}`.

**Images**
- Paste, drop or pick images; they are saved under `attachments/` in the note's space.
- Large photos are downscaled to 2000 px. SVGs are sanitised. Resize in the editor or write `![[photo.png|300x200]]`.
- Remote (web) images never load until you click them, because loading reveals your IP address.

**Safety nets**
- Each note keeps its last 20 earlier versions (at most one per five minutes). Deleted notes stay in the Trash for 30 days. Both are kept encrypted **on the device only**.
- Sync conflicts never overwrite text: the other copy is saved as `Note (conflict YYYY-MM-DD).md`.
- Works offline from the encrypted local cache; syncs when you are back online.
- Auto-locks after one hour of inactivity, on page hide, and across tabs. Only one tab can have the vault open at a time.
- Locking hides notes immediately, saves encrypted changes, clears keys and decrypted UI state, then reloads the page. If saving fails, Vault shows **Lock incomplete** and keeps edits in memory for retry; keep the tab open until saving succeeds.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+P` | Command palette |
| `Ctrl/Cmd+O` | Quick switcher (open or create a note) |
| `Ctrl/Cmd+Shift+O` | Switch space |
| `Ctrl/Cmd+Shift+F` | Search notes |
| `Ctrl/Cmd+S` | Sync now |
| `Ctrl/Cmd+E` | Toggle live preview and source |
| `Alt+N` | New note |
| `Alt+D` | Today's note |

## Security model in brief

| | |
| --- | --- |
| Password | 15–256 characters; unlocks a key bundle wrapped with PBKDF2-HMAC-SHA-256 (600,000 iterations) and AES-256-GCM |
| Recovery | A `VK1.…` recovery key is generated at setup and on every password change. Without the password or recovery key, data cannot be recovered |
| Objects | One AES-GCM key per object revision, derived with HKDF from the master key and bound to vault, epoch, kind, object and revision |
| Sessions | HMAC-signed, at most 8 hours, bound to the vault and key epoch |
| Rate limiting | 10 sign-in attempts per IP per 15 minutes, enforced by a Durable Object. Bootstrap requests have a separate budget |
| Browser | Strict CSP (scripts and network only to the app origin and the Worker), DOMPurify on rendered HTML, dependencies bundled in `vendor/` |
| Limits | Notes 5 MiB, files 20 MiB, manifest 4 MiB and 20,000 entries |

Not provided: multi-user sharing, migration of existing vaults, Obsidian sync, remote erasure, or protection from malware on a device you have unlocked. Ciphertext sizes, timing, IP addresses and Git authors remain visible to the server and GitHub.

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.html` | App shell, styles and the Content Security Policy |
| `app.js` | Notes, search, tags, spaces, history, templates, commands and the sync engine |
| `editor.js` | Live-preview editor on CodeMirror 6 |
| `auth.js` | Unlock, lock, setup, password change, recovery and idle timeout |
| `e2ee.js` | Cloud protocol v1: key derivation, wrapping, record encryption and validation (shared with the Worker) |
| `cloud-sync.js` | Ciphertext-only client for the Worker: load, upload, publish and rotate |
| `secure-store.js` | Encrypted IndexedDB device cache |
| `contextmenu.js`, `tablepicker.js` | Context menu and table-size picker |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline app shell and PWA metadata |
| `worker.js`, `wrangler.jsonc` | Cloudflare Worker and its `LoginLimiter` Durable Object |
| `scripts/` | `provision.mjs` (secrets, deploy, setup link) and `vendor.cjs` / `codemirror.mjs` (vendored builds) |
| `vendor/` | Bundled `marked`, DOMPurify and CodeMirror, with licences |
| `tests/` | Protocol, Worker, provisioning, service worker and browser tests |
| `.github/workflows/` | Worker deployment and test pipelines |

## Setting up your own copy

You need a Cloudflare account, a private GitHub repository for the encrypted data, and somewhere to host the static files (GitHub Pages works and is what the defaults assume).

1. **Fork or clone this repository** and host its files as a static site, for example with GitHub Pages.
2. **Create the storage repository**, private and empty (the shipped config uses `ccc2223/vault-files`).
3. **Edit the configuration** to match your setup:
   - `wrangler.jsonc` → `vars.REPO`, `vars.BRANCH` and `vars.ALLOWED_ORIGIN` (the origin that serves the app, with no path).
   - `index.html` → the `connect-src` host in the Content Security Policy.
   - `app.js` → `SYNC_URL`.
   - If you use the deploy workflow, the Worker URL in `.github/workflows/deploy-worker.yml`.
4. **Give the Worker a GitHub token.** Create a fine-grained token with *Contents: read and write* on the storage repository only, then run `wrangler secret put GH_TOKEN`.
5. **Provision and deploy** from a machine logged in to Cloudflare, with `wrangler` installed:

   ```sh
   npm run provision -- --worker-url https://YOUR-WORKER.workers.dev --app-url https://YOU.github.io/vault/
   ```

   This sets the `SESSION_SECRET` and `SETUP_TOKEN` secrets, deploys the Worker, and prints a one-time setup link.
6. **Open the setup link.** Choose a password, save the recovery key when prompted, and the encrypted vault is created. The link stops working once the vault exists.

### Deploying from GitHub Actions

The **Deploy Vault Worker** workflow (manual, `main` only) runs the same provisioning in CI. Add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Because CI logs may be public, the setup link is **never printed in plaintext**: it is encrypted to the RSA public key in `.github/vault-deploy-handoff-public.pem` (3072 bits or more) and printed as `VAULT_ENCRYPTED_SETUP=…`. Only the holder of the matching private key can decrypt it. Replace that key with your own before using the workflow.

## Development

There is no build step for the app itself; it is plain scripts served as static files. Use Node 22.

```sh
npm ci
npm run vendor        # rebuild vendor/ from node_modules (marked, DOMPurify, CodeMirror)

npm run test:unit     # crypto, Worker, cloud sync and provisioning tests
npm run test:browser  # Playwright tests: app, editor, context menu, service worker
npm run test:runtime  # Durable Object limiter on the real Workers runtime (needs wrangler)
npm test              # unit + browser
```

Browser tests use Chromium by default; set `VAULT_BROWSER=firefox` or `webkit` to switch (CI runs all three). Install browsers first with `npx playwright install --with-deps <browser>`.

When you change any file listed in `CORE` in `sw.js`, bump the `CACHE` name there so installed copies pick up the new version.

## Further reading

- [SECURITY.md](SECURITY.md): the encrypted vault protocol, storage layout, API, rotation, recovery and trust limits.
- Third-party licences are in `vendor/`.
