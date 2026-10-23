# Encrypted vault protocol v1

The browser is the encryption endpoint. The Worker stores opaque ciphertext and authorizes transport; GitHub is the private object store. This is a custom protocol built from Web Crypto primitives, not an independently audited encryption product.

## Key hierarchy

- A vault has a random UUID, an increasing key epoch and an increasing checkpoint generation.
- Each epoch has independently generated 32-byte master and access secrets. SHA-256 of the access secret is public authentication metadata. HMAC sessions use an independent Worker secret and bind the vault ID, epoch, digest, expiry and random nonce.
- PBKDF2-HMAC-SHA-256 (600,000 iterations; random 16-byte salt) derives an AES-256-GCM password wrapping key. Password validation counts Unicode code points; no trimming or normalization is applied.
- The recovery key contains 32 random bytes, base64url encoded as `VK1.<secret>.<checksum>`. The checksum is the first four bytes of SHA-256. HKDF-SHA-256 derives its wrapping key using the vault ID as salt and `['vault/recovery/v1']` as information.
- Both wrappers encrypt the epoch's bundle. Authenticated data binds `['vault/key/v1', vaultId, epoch, authDigest, kind]`; the password wrapper additionally binds its KDF name, iteration count and salt.
- Object keys use HKDF-SHA-256 with the master key, vault ID salt and `['vault/object/v1', vaultId, epoch, kind, objectId, revisionId]`. The same context is authenticated data. Each object revision and every wrap has a new 12-byte nonce and 128-bit GCM tag. IDs are random UUIDv4 values.
- The device cache has a separate password-derived key, random salt, fresh save nonces, atomic IndexedDB updates and encrypted per-file/per-version records bound to random IDs. Its key bundle, checkpoint, history metadata and pending rotation journal are encrypted inside that cache.

## Storage and commit point

`e2ee/head.json` is a strictly validated public header: protocol version, vault ID, epoch, generation, authentication digest, password and recovery wrappers, and an encrypted-manifest reference. It contains no user paths or titles. Each opaque object lives at `e2ee/objects/<objectId>/<revisionId>.enc`. Its header binds identity, epoch, type and nonce to ciphertext.

The encrypted manifest lists logical paths, types, modification times, tombstones and immutable object references. References include Git blob SHA identifiers. The client checks the response SHA and computed Git SHA, then verifies AES-GCM authentication. SHA-1 here is a Git transport identifier, not the cryptographic authenticity boundary.

Upload every new object and manifest before conditionally updating the head with its previous Git SHA. Initial setup requires no existing head. This head write is the publication point. Conflicts return 409 and the browser pulls and retries. Repeating an identical object upload is safe; an immutable path cannot be replaced. A lost head response is resolved by reading the published head. Garbage collection is intentionally absent.

The Worker validates formats, sizes and epoch transitions but cannot validate manifest plaintext or enforce honest-client conflict decisions without decryption keys. An authorized malicious device can damage availability or publish unreadable ciphertext. No server capability promises to protect against an authorized owner's malicious client.

## API

| Route | Authorization | Purpose |
| --- | --- | --- |
| `GET /vault/bootstrap` | Public, separately rate limited | Wrapped unlock metadata and current head SHA |
| `POST /login` | Rate limited random access secret | Obtain a session, maximum eight hours |
| `POST /vault/setup` | Single-use Setup capability | Initial conditional head creation |
| `GET /vault/head` | Current session | Fetch authenticated current checkpoint |
| `GET /vault/objects/:object/:revision` | Current session | Read ciphertext for the current epoch |
| `PUT /vault/objects/:object/:revision` | Current session | Stage immutable current/next-epoch ciphertext |
| `POST /vault/commit` | Current session | Conditional head publication or epoch rotation |

Setup can stage manifests before initialization and cannot read data or modify an initialized vault. The encrypted initial manifest is created empty by the browser; the keyless Worker cannot inspect its entries. There is no general GitHub proxy, plaintext notes endpoint, password endpoint or collaborator API. All responses are `no-store`, exact origins are required, query parameters are rejected and JSON request sizes are bounded.

## Rotation and recovery

Prepare new epoch ciphertext under fresh master/access/recovery keys. Save the pending rotation journal with the entire device cache under the new password **before** committing the new head. Keep old credentials only inside that new-password-encrypted journal until the head commits. Resume by checking whether the old or new epoch is current. If another device has committed edits meanwhile, reprepare against its current checkpoint and preserve those entries. Clear the journal only after persisting the completed checkpoint.

An old password or recovery key cannot unlock the new head; a new session is required immediately after epoch publication. This does not remove old encrypted Git revisions, invalidate an offline cache or revoke material an attacker already copied. Fresh-profile recovery restores synced state, not unsynced password-encrypted cache contents.

## Limits and trust

Locking hides the editor immediately and cancels sync requests. After saving pending changes as ciphertext, it clears keys, decrypted collections, template callbacks, history titles and previews, closes popups, revokes attachment URLs, and reloads the page to discard the old application context. Late attachment decryptions are rejected after key cleanup, and closed cloud clients cannot refill their plaintext caches. A service worker update cannot force a reload while locking is in progress or saving has failed.

If encrypted saving fails, the lock screen explicitly reports **Lock incomplete**. Decrypted data and keys remain in memory so unsaved edits can be retried; unlocking is disabled and navigation prompts warn about losing the retained edits. The app does not automatically reload or discard them. A successful retry saves the edits, clears sensitive state, and reloads. Reloading reduces retained application state but does not guarantee physical memory erasure, and it cannot remove clipboard contents, downloaded copies, browser HTTP caches, swap or crash dumps. A non-secret session-storage flag preserves the new-password instruction across reload when password rotation is pending.

Ciphertext lengths, object counts, revision timing, IPs and Git authors remain visible. The static application publisher, origin, browser, extensions and dependencies are trusted while unlocked. Browser APIs cannot guarantee physical zeroization, defeat local malware or prevent screenshots. CSP, sanitization, bundled dependencies, explicit remote-image loading and lock fencing reduce exposure but do not remove that trust.

A stored checkpoint detects ordinary rollback and omission on a known device. New devices cannot establish freshness independently. There are no signed cross-device transparency logs, hardware-bound keys or malicious-server fork proofs. Public password wrappers permit offline guessing: choose a high-entropy password even though online login uses an unguessable secret.

Limits: 5 MiB note plaintext, 20 MiB file plaintext, 4 MiB manifest plaintext, at most 20,000 manifest entries. Large Contents API reads fall back to Git blob reads. Live resource limits, mobile memory use and end-to-end deployment must be checked before release. No existing-format migration, multi-user sharing, Obsidian synchronization or remote erasure is provided.
