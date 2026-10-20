# Vault

A personal, local-first Markdown notes app with wikilinks, backlinks, search and private GitHub sync. The public app is hosted separately from your private notes repository.

## Device privacy

- Vault starts locked on every open or reload. Enter your password before any note titles, content, search results or backlinks appear.
- Notes, filenames, sync metadata and the last-opened note are encrypted together on this device with **AES-256-GCM**. The encryption key is derived using **PBKDF2-SHA-256, 600,000 iterations**, with a random device salt and a fresh nonce for every save.
- Unlock keys and cloud sessions stay in memory. They are never saved in localStorage, IndexedDB or the service worker cache.
- Remote HTTPS images stay blocked until you click **Load remote image**. Loading shares your IP address and viewing time with the image host; Vault sends no referrer. Permission applies only to that rendered image and is cleared when it is redrawn or Vault locks. Local attachments and inline image data keep working offline.
- Vault locks after **one hour of inactivity**, including time in the background. It checks elapsed time when returning to a suspended tab. Click **Lock**, or **Settings → Sign out**, to lock immediately.
- Locking saves pending edits as ciphertext, clears note text and credentials from the app, and cancels sync requests. A late response cannot reopen the vault.
- One tab per browser profile can edit at a time. Locking or signing out coordinates across open tabs.
- Saved notes can be unlocked offline with the local password. A new browser needs a successful cloud password login before it can download notes.

This protects device storage while Vault is locked. Your GitHub files remain ordinary Markdown in your private repository: **cloud notes are not end-to-end encrypted**. Browser extensions, compromised same-origin code, an unlocked device, and browser/password-manager features have their own access boundaries. Clearing browser data removes local copies, including unsynced edits. Choose a strong password; there is no password recovery for an unsynced encrypted copy.

## Features

- One Obsidian-style editor with live preview: notes look rendered, and Markdown symbols only show where you're editing. Click links to open them and task boxes to tick them. Ctrl/Cmd+E switches to the plain Markdown source and back
- Tasks: tick `- [ ]` boxes in a note, or open **Tasks** in the sidebar to see the open tasks from every note in the space, tick them there, or click one to jump to it
- Tables edit cell by cell like Obsidian: click a cell to edit it, Tab and Enter move between cells and add rows, the + buttons add rows and columns, right-click a cell to insert, delete or align rows and columns, and Escape, arrow down from the last row, or a click or tap below the table leaves it
- Code blocks show their language and a Copy button, are highlighted for common languages (```js, ```python, ```bash, ```sql and more), and stay editable in place
- `[[Wikilinks]]`, `[[Note|alias]]`, autocomplete and click-to-create
- Heading links: `[[Note#Heading]]` opens the note at that heading, `[[#Heading]]` jumps within the note, and typing `#` after a note name in `[[` suggests its headings
- Outline (≡): the note's headings, indented by level, with the one you're in highlighted. Click one to jump there
- Backlinks, full-text search and quick switcher
- Folders: the sidebar shows notes in a folder tree like Obsidian's, folders first, with collapsible subfolders. Type `folder/sub/name` as a note's name (or edit the title) to put it in a folder, or right-click a folder for **New note in this folder**. Opening a note opens the folders above it, and which folders are open is saved with your encrypted notes. Searching lists matches flat with their folder
- `#tags`, highlighted in the editor: click one, or pick it under **Tags** in the sidebar (with counts), to list its notes. Searching `#tag` also finds nested tags like `#tag/sub`, and typing `#` suggests tags you already use
- Spaces: separate sets of notes, each with its own links, search and backlinks
- Images: paste, drop or pick them (🖼); `![[image.png]]`, `![[image.png|300]]` and `![](attachments/image.png)` embeds
- Trash and note history: deleted notes stay in the trash for 30 days, and each note keeps its last 20 versions (🕘)
- Offline operation and installable PWA on phone and desktop
- Markdown files compatible with Obsidian; `.obsidian` and other dotfolders are ignored

- Daily notes: 📅 (Alt+D) opens today's note, `Daily/2026-10-17.md` in the current space, creating it from `Templates/Daily.md` if that note exists
- Templates: every note in `Templates/` is a template for **New note from template…** and **Insert template…** in the command palette. `{{title}}`, `{{date}}`, `{{time}}` and `{{date:dddd D MMMM YYYY}}` fill in (YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd, ddd, HH, H, mm, ss)
- Command palette (Ctrl/Cmd+P or ⋯): every action in one searchable list, recently used first

Shortcuts: Ctrl/Cmd+P commands · Alt+D today's note · Ctrl/Cmd+O switcher · Ctrl/Cmd+Shift+O spaces · Ctrl/Cmd+S sync · Ctrl/Cmd+E live preview/source · Ctrl/Cmd+Shift+F search · Alt+N new note

## Spaces

Spaces are separate sets of notes, like Obsidian vaults. Switch, create, rename or remove them with the space name at the top of the sidebar (Ctrl/Cmd+Shift+O).

- Each space is a top-level folder in your notes repo, such as `Work/`. **Main** holds every note outside those folders, so existing notes stay where they are.
- Links, backlinks, search, the quick switcher and autocomplete only see the current space. Vault reopens the space and note you last used.
- The list of spaces is stored in `.vault/spaces.json` in the repo, so every device sees the same spaces. Spaces changed on two devices are merged.
- Creating a space with the name of an existing folder in Main turns that folder into a space without moving any files.
- Renaming a space only changes its display name; the GitHub folder keeps its name. Removing a space turns it back into an ordinary folder in Main and deletes no notes.
- You can open any space's folder as its own Obsidian vault.

No Worker or Cloudflare changes are needed. A device still running an older Vault shows other spaces' notes as ordinary folders until it updates.

## Images

- Clicking an image link opens it in a viewer inside Vault; Escape or a click closes it. Images never open in a separate tab, so scripts inside an SVG can't run. SVGs you add on this device are also stripped of scripts, event handlers and other active content before they are saved.
- Paste or drop an image into the editor, or use 🖼 (on phones it can open the camera). Vault saves it to `attachments/` in the current space and inserts `![[name.png]]`. Pasted images are named like Obsidian's, `Pasted image 20261017125801.png`.
- Photos are scaled down to 2000px on the longest side. Large or scaled images are re-encoded: JPEG for photos, WebP for PNG/WebP (which may have transparency). GIF and SVG are kept as they are. The limit is 20 MB per image.
- Embeds resolve relative to the note, then the space root, then by file name, so moved notes keep their images. Type `![[` to autocomplete image names.
- Every device downloads all images (PNG, JPEG, GIF, WebP, AVIF, BMP, SVG) in its spaces, so they work offline. Images are stored encrypted on the device, one record per image, under the same password; names and paths live in the encrypted vault. Decrypted copies exist only in memory while unlocked.
- Images sync like notes: one commit per image, uploaded before the notes that embed them. If both sides changed the same image, this device's copy is kept and the other is saved beside it as a conflict copy. Deleting an image in GitHub deletes it here. Vault doesn't delete images when you remove an embed.


## Trash and history

- Deleting a note (🗑) moves it to the trash at the bottom of the sidebar. Notes deleted on another device land there too when this device syncs. Open the trash to read a deleted note, restore it under its old name (or beside a note that has taken the name), or delete it forever. Deleted notes are kept for 30 days.
- 🕘 shows a note's earlier versions. Vault keeps the text an edit replaces, at most once every five minutes per note, and the text a synced change from another device replaces. Restoring a version is an ordinary edit you can undo, and the text it replaces is kept as a version too. Each note keeps its last 20 versions; renaming a note keeps its history.
- The trash and history stay on this device, encrypted under the same password, one record per version like images. These local history records don't sync. **GitHub retains earlier synced contents in Git history**, including edited or deleted notes and attachments. Deleting a file does not erase its previous commits. Rotate any exposed credentials; removing sensitive history requires a separate repository-history cleanup.
- This release adds a storage area, so close older Vault tabs or windows when it asks.


### App

Host this repository with GitHub Pages (`main`, root), or another static HTTPS host. Include `index.html`, `app.js`, `editor.js`, `contextmenu.js`, `auth.js`, `secure-store.js`, `vendor/`, `manifest.webmanifest`, `icon.svg` and `sw.js`. There is no deployment build step; bundled libraries are committed. The app requires Web Crypto, IndexedDB and Web Locks in a current browser.

### Private notes repo

1. Create a **private** repository, initialized with a README so `main` exists.
2. Create a GitHub **fine-grained personal access token**, restricted to that repository, with **Contents: Read and write**. Expired tokens stop syncing.

### Cloudflare Worker

The Worker requires the `LOGIN_LIMITER` Durable Object binding and class migration in `wrangler.jsonc`. A plain dashboard code paste without this binding will refuse new cloud sign-ins. SQLite Durable Objects are supported on Cloudflare's Workers Free and Paid plans.

1. Install Node.js, then run `npx wrangler login` from a checkout of this repository.
2. In `wrangler.jsonc`, set `name` to your existing Worker's name (or your desired new name), and check `vars.REPO` and `vars.ALLOWED_ORIGIN`. Preserve any existing deployment configuration and append this class migration if you already use Durable Objects.
3. For an existing Worker, retain its current secrets. For a new Worker, set secrets with `npx wrangler secret put GH_TOKEN` and `npx wrangler secret put PASSWORD`. The supported settings are:

| Name | Type | Value |
| --- | --- | --- |
| `GH_TOKEN` | Secret | The GitHub fine-grained token |
| `PASSWORD` | Secret | A strong unique password; prefer one generated by a password manager |
| `REPO` | Text | `ccc2223/vault-files` (or your private notes repo) |
| `ALLOWED_ORIGIN` | Text | `https://ccc2223.github.io` (origin only, without `/vault/`) |
| `SESSION_HOURS` | Text, optional | Default and maximum `8`; smaller positive values are allowed |
| `SESSION_SECRET` | Secret, optional | Any random string. Change it to sign out every device without changing `PASSWORD` |

4. Run `npx wrangler deploy`. The checked-in configuration creates and binds `LoginLimiter` as `LOGIN_LIMITER`. It atomically reserves at most **10 sign-in attempts per IP per 15 minutes**, counting successful and malformed attempts too, before parsing a password. Concurrent requests share the same budget. Cloudflare's trusted connecting IP selects the budget; caller-supplied forwarding headers are ignored. Objects persist only a count and reset time; their names use a hash of the IP and repository. There is no shared global lockout. Users sharing one public IP share its limit. A 429 includes the remaining window in `Retry-After`.
5. Missing or unavailable protection returns **503**, rather than allowing unlimited guesses. Existing sessions and offline unlocking still work. Old optional `LIMITS` KV bindings are ignored and can be removed after deployment. For additional protection against distributed guessing, configure Cloudflare edge abuse controls or an independent identity provider; per-IP limits do not replace a strong password. Open Vault and enter the Worker's HTTPS URL and password.
6. Set `SYNC_URL` in `app.js` so new devices only need the password, and put the same URL in the `connect-src` list of the Content-Security-Policy in `index.html`. The policy blocks connections to any other server, so a Worker URL that isn't listed there can't be used. The URL is public; never put secrets in app source.

The Worker keeps the GitHub token server-side. Sessions expire within **eight hours** and the app discards them on lock/close. Old `SESSION_DAYS` settings are ignored; remove that variable when upgrading. Updating to this Worker version invalidates old sessions. Changing `PASSWORD`, `GH_TOKEN` or `REPO` also invalidates sessions. Sessions are stateless: sign-out clears this browser's credentials, while a separately copied token remains valid until expiry or a server-secret change.

## Upgrade existing devices

1. Deploy the updated Worker with `wrangler.jsonc` as described above, including its required `LOGIN_LIMITER` binding and class migration. Keep the current `GH_TOKEN`, `PASSWORD`, `REPO` and `ALLOWED_ORIGIN`; do not rotate passwords during initial migration.
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

If both sides changed a note, the local text is kept and each remote conflict is saved under a unique conflict filename. An open note you haven't edited updates in place when newer text is pulled. Renames and deletes propagate, except that deleting (or renaming away from) a note that was edited on another device since your last sync restores the remote edit instead of discarding it. Notes download a few at a time and are saved locally in one encrypted write per sync. Each changed note or image produces one GitHub commit; other attachment types (PDFs, audio) are not synced yet. Repository settings should continue pointing to the same notes repo and branch when reusing a device cache.

## Development and checks

```sh
npm ci
npm run vendor
npx playwright install chromium
npm test
```

Browser regression tests use Chromium, real IndexedDB/Web Crypto, and a mock sync server. Set `CHROMIUM_PATH` to a system Chromium executable if needed. Tests cover authenticated migration, encrypted storage, offline reload, wrong passwords, sign-out, reload locking, one-hour inactivity, tab coordination, interrupted writes, late responses, password rotation, and remote-image privacy. Worker tests cover session duration, old/tampered/expired sessions, revocation, origins, proxy restrictions, concurrent login admission, expiry, isolated IP budgets, and unavailable protection. The Node tests use a serialized storage substitute; deployment must also provision the actual Cloudflare binding. No real notes or credentials are used.

When changing app assets, bump the cache version in `sw.js`; its atomic install caches only the public app shell. Vendored library versions and licenses are recorded in `package.json`, `package-lock.json` and `vendor/`. `npm run vendor` also bundles the CodeMirror editor (`scripts/codemirror.mjs`) into `vendor/codemirror.min.js`.

