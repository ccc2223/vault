# Plan: import existing folders and Obsidian vaults

Import a folder from disk, such as an Obsidian vault, as a new **space**. Files reach GitHub byte for byte in **one commit**, so the space folder is still a valid Obsidian vault. Attachments are imported, synced, stored encrypted on every device and rendered when they are images. Obsidian note embeds, heading links and frontmatter render properly.

## Decisions

| Topic | Decision |
| --- | --- |
| Input | Desktop folder picker (`<input webkitdirectory>`) and dropping a folder onto the window. No zip or iOS path for now. |
| Destination | Always a new space named after the folder. The name can be edited before importing. |
| Name collisions | Blocked. If a space, a Main folder or a top-level repo folder already has the name (case-insensitive), the user must pick another name. Re-importing means importing under a new name. |
| GitHub write | One commit through the Git Data API (`trees` → `commits` → fast-forward `refs`). Requires a Worker update. |
| File content | Byte for byte. Imported notes are never rewritten; the app learns Obsidian's rules instead. |
| Connectivity | Online and signed in. Nothing is written locally until the commit has landed. |
| Limits | Files over 25 MB are skipped and reported. Imports over 500 MB need confirmation. |
| Skipped files | Anything under a dot segment (`.obsidian/`, `.trash/`, `.git/`, `.DS_Store`), plus `Thumbs.db` and `desktop.ini`. |
| Attachments | Every non-Markdown file is imported. Sync pulls attachments repo-wide (read-only; the app does not create or edit them yet). |
| Attachment storage | A separate encrypted IndexedDB store, one record per file, so editing a note never re-encrypts images. |
| Attachment download | Eager: notes first, then attachments in the background, so everything works offline afterwards. |
| Rendering | Inline images, `![[Note]]` note embeds, `[[Note#Heading]]` links, hidden frontmatter. |

## Phase 1: Worker and single-commit import

### Worker (`worker.js`)

Allow exactly the routes the import needs, and nothing broader:

| Method | Route | Use |
| --- | --- | --- |
| GET | `git/trees/*`, `git/blobs/*`, `contents/*` | Unchanged |
| GET | `git/ref/heads/*`, `git/commits/*` | Read the branch head |
| POST | `git/blobs`, `git/trees`, `git/commits` | Build the import commit |
| PATCH | `git/refs/heads/*` | Fast-forward the branch. **`force: true` is rejected**, so a session can never rewrite history. |
| PUT, DELETE | `contents/*` | Unchanged |

The Worker also forwards `Retry-After` and `X-RateLimit-*` headers (exposed through CORS) so the app can wait out GitHub's secondary rate limits. `Access-Control-Allow-Methods` adds `PATCH`. Users must redeploy the Worker; an older Worker answers 403, and the app explains that.

### Scan

- Walk the picked or dropped folder. Drop uses `webkitGetAsEntry`, reading directories until `readEntries` returns an empty batch.
- Paths are relative to the picked folder; its name becomes the default space name.
- Apply the skip rules and size limits, then classify each file as a note (`.md`) or an attachment.

### Preview dialog

- The space name field shows inline errors for collisions and empty names. It is checked against local spaces and folders here, and against the remote head tree again just before committing.
- A summary such as "214 notes, 37 attachments (18.2 MB)".
- A list of skipped items and the reasons.
- A warning when attachments will take a while because of GitHub rate limits.

### Upload

1. **Text:** each file is decoded with `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`. Valid UTF-8 without NUL bytes goes **inline** in `POST git/trees` (`content`), so Markdown needs no per-file request. Valid UTF-8 round-trips exactly, so the bytes are preserved.
2. **Binary** (and any file that isn't valid UTF-8) goes through `POST git/blobs` (base64), with three concurrent uploads. On a 403/429 secondary limit, wait for `Retry-After` (otherwise 60 s, doubling) and show "Waiting for GitHub rate limit…". Blob shas are cached for the life of the dialog, so **Retry** skips files that already uploaded.
3. **Folder tree:** built standalone (no `base_tree`), in chunks of about 2 MB or 1,000 entries. Each chunk uses the previous chunk's tree as its `base_tree`.
4. **Commit loop** (up to 3 attempts):
   - read `git/ref/heads/<branch>` → `git/commits/<sha>`, and the top-level entries of the head tree;
   - re-check the folder name against the remote;
   - read `.vault/spaces.json` at that commit and add `{folder, name, updated}`;
   - `POST git/trees` with `base_tree` set to the head tree and two entries: the folder (`040000` tree) and `spaces.json`;
   - `POST git/commits` with the message `Import "<name>" (N notes, M attachments)`;
   - `PATCH git/refs/heads/<branch>` (no force). A 422 means another device pushed in the meantime, so the loop retries on the new head. Only the final tree is rebuilt; nothing is uploaded again.

   The import holds the sync slot during this step, so a background sync cannot run between the ref update and local seeding.
5. **Seed locally:** imported notes go into the local store with their git blob sha (`SHA-1("blob <len>\0" + bytes)`), so the next sync doesn't download them again. `spaces.json` is applied the same way a pulled copy is (merged if there are local edits). Everything is written in one encrypted write, then the app switches to the new space and syncs.

Locking or signing out aborts the import, and nothing is written locally. If the import is interrupted before the ref update, GitHub is left with unreferenced objects only, which are harmless. Phase 1 already gives a complete Obsidian vault in GitHub. Attachments are not visible in the app until phase 2.

### Tests

- **Worker:** new routes are allowed, `force: true` is rejected, other git routes stay forbidden, and rate-limit headers are forwarded.
- **App:** the mock Git Data server models trees, commits and refs. Tests cover:
  - importing a folder makes one commit, keeps bytes exact (BOM, CRLF, non-UTF-8 and binary files), registers the space, and needs no re-download on sync;
  - dot folders and oversized files are skipped and reported;
  - name collisions with a space, a Main folder or a remote folder block the import;
  - a ref race retries on the new head;
  - locking mid-import writes nothing.

## Phase 2: attachment sync and encrypted file store

### Storage (`secure-store.js`)

- Bump the IndexedDB version to 3 and add a `files` object store, keyed by a random id. Ids are not paths or shas, so filenames don't leak.
- Each record is `{iv, ciphertext}`, encrypted with AES-GCM and AAD `vault/file/v1:<id>`.
- Files are encrypted with a random **file key**. That key is held inside the sealed vault payload, so a password change only re-wraps the vault blob and never re-encrypts hundreds of MB of attachments.
- Metadata records live in the sealed payload: `{kind: 'file', path, sha, size, fileId}`. `isNote()` excludes them, along with every other note-only code path (list, search, backlinks, rename, quick switcher).
- Writing file bytes and the matching metadata is two-phase: bytes first, then metadata. An orphan sweep on unlock deletes `files` records that no metadata refers to.
- Locking clears the file key and revokes all blob URLs.

### Sync (`app.js`)

- The tree filter extends to every non-dot file of 25 MB or less.
- Notes are pulled first and the UI updates. Attachments with a changed sha then download through `git/blobs`, three at a time, with a status line such as "Downloading attachments 12/37".
- Remote deletions remove the metadata and the encrypted bytes.
- The app never pushes attachments in this phase.

### Rendering

- `![[img.png]]`, `![[img.png|300]]` and `![](relative/img.png)` resolve within the current space using Obsidian's order: exact path from the vault root, then path relative to the note, then shortest path by basename.
- Resolved images get `data-file` attributes. After DOMPurify runs, they receive `blob:` URLs, cached per render and revoked on re-render or lock.
- Missing attachments show a placeholder chip.

## Phase 3: Obsidian rendering

- **Frontmatter:** a leading `---` YAML block is hidden from the preview and shown as a collapsed "Properties" box. Search still indexes it.
- **Heading links:** headings get slug ids. `[[Note#Heading]]` opens the note and scrolls to the heading, and `[[#Heading]]` scrolls within the current note. Backlinks ignore the anchor.
- **Note embeds:** `![[Note]]` and `![[Note#Heading]]` render the target, or just that section, inline in a framed block. Depth is limited to 3, and cycles are rendered as links.

## Follow-ups (not planned yet)

- Callouts (`> [!note]`)
- Clickable `#tags`, including frontmatter `tags`
- Pasting or dropping images into the editor (needs an attachment push path)
- Zip import for iOS
- Merging a re-import into an existing space
- Lazy attachment download on mobile

## Risks

- **GitHub secondary rate limits.** About 80 content-creating requests a minute and 500 an hour. Markdown is inlined, so only binary files count, but a vault with more than about 450 attachments takes over an hour. The preview gives an estimate, and the idle lock can interrupt an unattended import; **Retry** resumes from cached blob shas.
- **Worker memory.** A 25 MB file arrives as about 33 MB of base64 JSON, which is within a Worker's 128 MB.
- **Tree size.** Sync refuses truncated trees (more than 100,000 entries or 7 MB of tree JSON). Very large vaults should be checked against this before importing.
