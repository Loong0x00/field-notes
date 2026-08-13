# Field Notes

A Markdown-driven personal site deployed as one managed edge application. HTML,
Markdown alternates and machine-readable indexes are served asset-first; only
the discussion API and media routes invoke the Worker. D1 stores accounts and
threaded comments, and R2 stores image attachments. The site has no analytics,
newsletter or CMS.

## Write

The initial deployment intentionally contains no posts. Add a Markdown file
under `content/posts/` when there is something worth publishing. The homepage,
article pages, Markdown alternates, `llms.txt`, `llms-full.txt`, Atom feed,
sitemap, robots file, and 404 page are generated from the same post metadata.

## Build and verify

```bash
python -m pip install -r requirements.txt
npm ci
npm run check
npx wrangler d1 migrations apply field-notes-local --local --config wrangler.jsonc
npx wrangler dev --config wrangler.jsonc
```

Then open <http://127.0.0.1:8787/>. With the development server running, use
`npm run test:e2e` to exercise same-origin protection, accounts, password
recovery, comments, replies, image storage, editing and deletion against real
local D1/R2 bindings.

`build.py` replaces only the generated `public/` directory. `npm run build`
then bundles that output and the Worker into `dist/`.

## Publish

The repository is `Loong0x00/field-notes`. OpenAI Sites owns the production
Worker, D1 database, R2 bucket and custom-domain deployment for
`loong0x00.com`. GitHub Actions validates source changes but does not publish
the site.
