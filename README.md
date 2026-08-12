# Field Notes

A Markdown-driven site for GitHub Pages. Articles remain static and readable
when the optional discussion service is unavailable. The site has no analytics,
newsletter or CMS.

## Write

The initial deployment intentionally contains no posts. Add a Markdown file
under `content/posts/` when there is something worth publishing. The homepage,
article pages, Atom feed, sitemap, robots file, and 404 page are generated from
the same post metadata.

## Build and verify

```bash
python -m pip install -r requirements.txt
python build.py
python scripts/check_site.py
python -m http.server 4173 --directory public
```

Then open <http://127.0.0.1:4173/>.

To point a local build at a local discussion service, set
`COMMENTS_API_URL=http://127.0.0.1:8090` when running `build.py`. See
[`server/README.md`](server/README.md) for the account, nested-reply and image
service.

`build.py` replaces only the generated `public/` directory. GitHub Actions runs
the same build and check commands, uploads `public/`, and deploys it through
GitHub Pages.

## Publish

The repository is `Loong0x00/field-notes`. GitHub Actions deploys `public/` to
GitHub Pages, and `loong0x00.com` is the canonical custom domain.
