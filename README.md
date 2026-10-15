# Vault — a free, personal Obsidian-style notes app

Local-first PWA. Notes are plain `.md` files, kept in your browser (IndexedDB) and synced to **your own private GitHub repo**. No server, no cost.

## Features
- Markdown editor with live preview (Edit / Split / View)
- `[[Wikilinks]]` (also `[[Note|alias]]`), autocomplete when you type `[[`, click-to-create missing notes
- Backlinks panel
- Full-text search and quick switcher (Ctrl/Cmd+O)
- Folders via `folder/name`
- Works offline, installable on phone and desktop
- Notes stay compatible with Obsidian: open the same repo as a vault

## Shortcuts
Ctrl/Cmd+O switcher · Ctrl/Cmd+S sync · Ctrl/Cmd+E edit/view · Ctrl/Cmd+Shift+F search · Alt+N new note

## Deploy for free (about 5 minutes)

**1. Create the app repo (public, hosts the app only)**
1. On GitHub, create a repo named `vault-app`.
2. Upload `index.html`, `manifest.webmanifest`, `icon.svg`, `sw.js`.
3. Settings → Pages → Deploy from branch → `main` / root.
4. Your app is live at `https://<you>.github.io/vault-app/`.

**2. Create the notes repo (private, holds your notes)**
1. Create a **private** repo, e.g. `my-vault`, initialized with a README (so the branch exists).
2. Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate.
3. Limit it to `my-vault` only, permission **Contents: Read and write**.

**3. Sync server (password sign-in, recommended)**
`worker.js` is a free Cloudflare Worker that keeps the token server-side, so each device only needs a password.
1. dash.cloudflare.com → Workers & Pages → Create → Worker → name it `vault-sync` → Deploy → Edit code → paste `worker.js` → Deploy.
2. Worker → Settings → Variables and Secrets, add:
   - `GH_TOKEN` (Secret): the fine-grained token
   - `PASSWORD` (Secret): a long password
   - `REPO` (Text): `you/my-vault`
   - `ALLOWED_ORIGIN` (Text): `https://<you>.github.io`
3. Optional: set `SYNC_URL` near the top of `index.html` to the Worker URL so new devices only ask for the password.

**4. Connect**
Open the app → ⚙ → Password → Worker URL and password → Save & sync. Sessions last 90 days; changing `PASSWORD` or `GH_TOKEN` signs out every device.
(Direct mode is still available under ⚙ → Access token, which stores the token in that browser.)

Alternative hosts: Cloudflare Pages or Netlify drop-in work too, since it's just static files.

## Sync behaviour
- Pull then push on load, on Ctrl/Cmd+S, ~15s after edits, and when you return to the tab.
- If the same note changed in both places, your local version is kept and the remote one is saved as `Note (conflict YYYY-MM-DD).md`.
- Renames and deletes propagate. Only `.md` files are synced; dotfolders such as `.obsidian` are ignored.

## Notes and limits
- Use a token scoped to a single private repo; anyone with access to your browser profile can read it.
- Images and attachments are not supported yet.
- The GitHub API allows about 5,000 requests/hour, plenty for personal use. Each changed note is one commit.

## Ideas for next steps
Graph view, daily notes, tags pane, image paste (stored in the repo), end-to-end encryption before pushing.
