# Vault

A personal, local-first Markdown notes app with wikilinks, backlinks, search and private GitHub sync. The public app is hosted separately from your private notes repository.

## Device privacy

- Vault starts locked on every open or reload. Enter your password before any note titles, content, search results or backlinks appear.
- Notes, filenames, sync metadata and the last-opened note are encrypted together on this device with **AES-256-GCM**. The encryption key is derived using **PBKDF2-SHA-256, 600,000 iterations**, with a random device salt and a fresh nonce for every save.
- Unlock keys and cloud sessions stay in memory. They are never saved in localStorage, IndexedDB or the service worker cache.
- Vault locks after **one hour of inactivity**, including time in the background. It checks elapsed time when returning to a suspended tab. Click **Lock**, or **Settings → Sign out**, to lock immediately.
- Locking saves pending edits as ciphertext, clears note text and credentials from the app, and cancels sync requests. A late response cannot reopen the vault.
- One tab per browser profile can edit at a time. Locking or signing out coordinates across open tabs.
- Saved notes can be unlocked offline with the local password. A new browser needs a successful cloud password login before it can download notes.

This protects device storage while Vault is locked. Your GitHub files remain ordinary Markdown in your private repository: **cloud notes are not end-to-end encrypted**. Browser extensions, compromised same-origin code, an unlocked device, and browser/password-manager features have their own access boundaries. Clearing browser data removes local copies, including unsynced edits. Choose a strong password; there is no password recovery for an unsynced encrypted copy.

## Features

- Markdown editor and live preview: Edit / Split / View
- `[[Wikilinks]]`, `[[Note|alias]]`, autocomplete and click-to-create
- Backlinks, full-text search, quick switcher and folders via `folder/name`
- Spaces: separate sets of notes, each with its own links, search and backlinks
- Import a folder or Obsidian vault as a new space, unchanged and in one commit
- Offline operation and installable PWA on phone and desktop
- Markdown files compatible with Obsidian; `.obsidian` and other dotfolders are ignored

Shortcuts: Ctrl/Cmd+O switcher · Ctrl/Cmd+Shift+O spaces · Ctrl/Cmd+S sync · Ctrl/Cmd+E edit/view · Ctrl/Cmd+Shift+F search · Alt+N new note

## Spaces

Spaces are separate sets of notes, like Obsidian vaults. Switch, create, rename or remove them with the space name at the top of the sidebar (Ctrl/Cmd+Shift+O).

- Each space is a top-level folder in your notes repo, such as `Work/`. **Main** holds every note outside those folders, so existing notes stay where they are.
- Links, backlinks, search, the quick switcher and autocomplete only see the current space. Vault reopens the space and note you last used.
- The list of spaces is stored in `.vault/spaces.json` in the repo, so every device sees the same spaces. Spaces changed on two devices are merged.
- Creating a space with the name of an existing folder in Main turns that folder into a space without moving any files.
- Renaming a space only changes its display name; the GitHub folder keeps its name. Removing a space turns it back into an ordinary folder in Main and deletes no notes.
- You can open any space's folder as its own Obsidian vault.

No Worker or Cloudflare changes are needed. A device still running an older Vault shows other spaces' notes as ordinary folders until it updates.

## Import a folder or Obsidian vault

On a desktop browser, open the space menu → **Import folder…**, or drop a folder onto the window. The folder becomes a new space with the same name; you can change the name before importing. Importing needs a signed-in, online device and the current `worker.js` (redeploy older Workers first).

- Every file is added **unchanged** under a new top-level folder in your notes repo, in **one commit**, so that folder still opens as an Obsidian vault. This includes attachments such as images, PDFs and canvases.
- Hidden files and folders (`.obsidian/`, `.trash/`, `.git/`, `.DS_Store`), `Thumbs.db` and `desktop.ini` are skipped. Files over 25 MB are skipped and listed. Imports over 500 MB ask for confirmation.
- A space, folder in Main or folder in the repo with the same name blocks the import, so choose another name. Nothing is merged or overwritten.
- Notes appear right away. Attachments are stored in GitHub but are not shown in Vault yet (see `docs/import-plan.md`).
- GitHub limits how fast files can be created. Markdown and other text files are sent inline and don't count, but large numbers of images upload at about one per second, and Vault waits automatically when GitHub asks it to. If an import fails or is cancelled, **Retry** reuses the files that were already uploaded. Locking cancels an import.

## Deploy

### App

Host this repository with GitHub Pages (`main`, root), or another static HTTPS host. Include `index.html`, `app.js`, `auth.js`, `secure-store.js`, `vendor/`, `manifest.webmanifest`, `icon.svg` and `sw.js`. There is no deployment build step; bundled libraries are committed. The app requires Web Crypto, IndexedDB and Web Locks in a current browser.

### Private notes repo

1. Create a **private** repository, initialized with a README so `main` exists.
2. Create a GitHub **fine-grained personal access token**, restricted to that repository, with **Contents: Read and write**. Expired tokens stop syncing.

### Cloudflare Worker

1. Cloudflare → Workers & Pages → Create → **Start with Hello World** → name and deploy the Worker.
2. Click **Edit code**, replace the starter code with this repository's `worker.js`, and deploy. The static-file upload flow does not deploy a Worker backend.
3. Under **Settings → Variables and Secrets**, add:

| Name | Type | Value |
| --- | --- | --- |
| `GH_TOKEN` | Secret | The GitHub fine-grained token |
| `PASSWORD` | Secret | A long password of your choice |
| `REPO` | Text | `ccc2223/vault-files` (or your private notes repo) |
| `ALLOWED_ORIGIN` | Text | `https://ccc2223.github.io` (origin only, without `/vault/`) |
| `SESSION_HOURS` | Text, optional | Default and maximum `8`; smaller positive values are allowed |

4. Save/deploy the settings. Open Vault and enter the Worker's HTTPS URL and password.
5. Optionally set `SYNC_URL` in `app.js` so new devices only need the password. The URL is public; never put secrets in app source.

The Worker keeps the GitHub token server-side. Besides reading and writing files, it allows the Git Data requests that folder imports use (creating blobs, trees and commits, and updating the branch), and it accepts only fast-forward branch updates, so a session can add commits but never rewrite history. Sessions expire within **eight hours** and the app discards them on lock/close. Old `SESSION_DAYS` settings are ignored; remove that variable when upgrading. Updating to this Worker version invalidates old sessions. Changing `PASSWORD`, `GH_TOKEN` or `REPO` also invalidates sessions. Sessions are stateless: sign-out clears this browser's credentials, while a separately copied token remains valid until expiry or a server-secret change.

## Upgrade existing devices

1. Deploy the updated Worker code. Folder imports need this version. Keep the current `GH_TOKEN`, `PASSWORD`, `REPO` and `ALLOWED_ORIGIN`; do not rotate passwords during initial migration.
2. Close all older Vault tabs or installed windows on each device, then reopen/reload the app. A cached old app may require another reload after its service worker updates. If the upgrade says it is blocked, close older Vault windows. Do not clear browser data.
3. Enter the existing Cloudflare password and Worker URL. Old saved tokens/sessions are discarded instead of reused.
4. Migration encrypts **all existing notes and unsynced edits**, decrypts and verifies the ciphertext, then atomically commits it and clears the old plaintext records. No notes are displayed before migration succeeds.
5. If storage fails or the upgrade is interrupted, it keeps the old data or the fully committed encrypted vault. Retry; never delete browser data as a troubleshooting step before recovering unsynced edits.

If saving fails during locking, notes disappear from the screen and sync credentials are cleared. Keep the tab open and use **Retry saving and lock**. The app retains the unsaved in-memory copy until persistence succeeds, so locking cannot finish or release its key until then.

## Change the password

1. First update `PASSWORD` in Cloudflare and deploy.
2. On each previously used device, unlock with its **old local password**. Local unlocking still works even when the server rejects the old password.
3. Open **Settings → Update local password**. Enter the old local password and the new Cloudflare password.
4. Vault verifies the new cloud password and the old local password, saves pending edits, then verifies and atomically commits the re-encrypted notes.
5. Future unlocks on that device use the new password. Repeat on every device with existing local data.

A failed change keeps the existing encrypted vault. Changing a server password cannot remotely revoke an offline copy encrypted with an old password. If the old local password is lost, already-synced notes remain recoverable from GitHub; unsynced encrypted data cannot be recovered without it. The app never silently wipes notes on failed login or recovery.

## Sync

Pull then push on opening, on Ctrl/Cmd+S, about 15 seconds after edits, and on returning to an unlocked tab. Settings lets you sign in again after session expiry. Direct-token sign-in was removed so every device uses the password flow.

If both sides changed a note, the local text is kept and each remote conflict is saved under a unique conflict filename. An open note you haven't edited updates in place when newer text is pulled. Renames and deletes propagate, except that deleting (or renaming away from) a note that was edited on another device since your last sync restores the remote edit instead of discarding it. Notes download a few at a time and are saved locally in one encrypted write per sync. Each changed note produces one GitHub commit; images and attachments are not supported yet. Repository settings should continue pointing to the same notes repo and branch when reusing a device cache.

## Development and checks

```sh
npm ci
npm run vendor
npx playwright install chromium
npm test
```

Browser regression tests use Chromium, real IndexedDB/Web Crypto, and a mock sync server. Set `CHROMIUM_PATH` to a system Chromium executable if needed. Tests cover authenticated migration, encrypted storage, offline reload, wrong passwords, sign-out, reload locking, one-hour inactivity, tab coordination, interrupted writes, late responses and password rotation. Worker tests cover session duration, old/tampered/expired sessions, revocation, origins and proxy restrictions. No real notes or credentials are used.

When changing app assets, bump the cache version in `sw.js`; its atomic install caches only the public app shell. Vendored library versions and licenses are recorded in `package.json`, `package-lock.json` and `vendor/`.
