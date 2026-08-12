# Discussion service

The discussion service is deliberately separate from GitHub Pages. It provides:

- public comment reading;
- username/password registration without email or phone numbers;
- one-time recovery codes for password recovery;
- arbitrary-depth replies;
- plain-text bodies (HTML is never rendered);
- up to four JPEG, PNG or WebP attachments per comment;
- owner editing/deletion and administrator hide/ban operations.

SQLite stores accounts, sessions, comments and image metadata. Normalized image
files live under `COMMENTS_DATA_DIR/media`; they are not stored in SQLite.

## Local run

From this directory:

```bash
COMMENTS_ALLOWED_ORIGINS=http://127.0.0.1:4173 \
COMMENTS_ALLOW_NO_TURNSTILE=true \
COMMENTS_SECURE_COOKIE=false \
go run ./cmd/commentsd
```

In another terminal, build and serve the static site:

```bash
cd ..
COMMENTS_API_URL=http://127.0.0.1:8090 python build.py
python -m http.server 4173 --directory public
```

`COMMENTS_ALLOW_NO_TURNSTILE=true` is only for local development.

## Create or rotate the administrator account

Stop the service first, then use the same data directory and origin:

```bash
COMMENTS_ALLOWED_ORIGINS=https://loong0x00.com \
COMMENTS_DATA_DIR=/var/lib/field-notes \
COMMENTS_ADMIN_USERNAME=owner \
COMMENTS_ADMIN_PASSWORD='use-a-password-manager' \
go run ./cmd/commentsd bootstrap-admin
```

The command prints a new recovery code exactly once and invalidates the old
password/recovery pair for that username. Do not put the password in shell
history on the real host; load these two values from a protected environment
file or an interactive wrapper.

## Production configuration

Required:

- `COMMENTS_ALLOWED_ORIGINS=https://loong0x00.com`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

Recommended/available:

- `COMMENTS_DATA_DIR=/var/lib/field-notes`
- `COMMENTS_LISTEN=127.0.0.1:8090`
- `COMMENTS_SECURE_COOKIE=true` (the default)
- `COMMENTS_COOKIE_NAME=field_notes_session`

Expose only `127.0.0.1:8090` to a Cloudflare Tunnel route for
`comments.loong0x00.com`; do not open the service port to the Internet. Back up
both the SQLite database (including its WAL while live) and the media directory.
Bring this service and Turnstile online before publishing the static discussion
UI.

## Install on this host

The repository includes hardened user services for both the API and Tunnel:

```bash
./scripts/install_comments_service.sh
```

The installer builds the current source, installs the binary under the user's
local data tree, and installs two user units. It does not start either unit
until the real Turnstile keys and tunnel UUID have replaced the example values
under `~/.config/field-notes-comments/`.
