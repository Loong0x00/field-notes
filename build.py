#!/usr/bin/env python3
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import struct
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape
from markdown_it import MarkdownIt


ROOT = Path(__file__).resolve().parent
CONTENT = ROOT / "content" / "posts"
DOWNLOADS = ROOT / "downloads"
TEMPLATES = ROOT / "templates"
OUT = ROOT / "public"
REQUIRED = {
    "slug",
    "serial",
    "title",
    "date",
    "category",
    "status",
    "status_text",
    "summary",
    "finding_number",
    "finding_text",
    "boundary",
    "external_url",
}
XBAR_TABLE_MARKER = "[[xbar-table:astral-2001w-status]]"
XBAR_STATUS_CSV = (
    DOWNLOADS / "xbar" / "astral-2001w-xoc-r610.57.04-xbar.csv"
)
XBAR_STATUS_PUBLIC = "/downloads/xbar/astral-2001w-xoc-r610.57.04-xbar.csv"
IMAGE_TAG = re.compile(r"<img (?P<attrs>[^>]*?)\s*/>")
IMAGE_SRC = re.compile(r'\bsrc="([^"]+)"')


def render_table_cell_open(renderer, tokens, idx, options, env) -> str:
    token = tokens[idx]
    style = token.attrs.pop("style", "")
    if style.startswith("text-align:"):
        token.attrJoin("class", f"align-{style.removeprefix('text-align:')}")
    return renderer.renderToken(tokens, idx, options, env)


def load_frontmatter(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        raise ValueError(f"{path}: missing YAML front matter")
    header, body = text[4:].split("\n---\n", 1)
    data = yaml.safe_load(header)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: front matter must be a mapping")
    missing = REQUIRED - data.keys()
    if missing:
        raise ValueError(f"{path}: missing fields: {', '.join(sorted(missing))}")
    return data, body.strip() + "\n"


def parse_date(value: object) -> dt.date:
    if isinstance(value, dt.date):
        return value
    return dt.date.fromisoformat(str(value))


def render_xbar_status_disclosure() -> str:
    with XBAR_STATUS_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != 127:
        raise ValueError(f"{XBAR_STATUS_CSV}: expected 127 points, found {len(rows)}")

    table_rows: list[str] = []
    for expected_point, row in enumerate(rows):
        point = int(row["point"])
        voltage_mv = int(row["effective_voltage_uv"]) // 1000
        base_mhz = int(row["base_freq_mhz"])
        tuning_mhz = int(row["freq_tuning_offset_khz"]) // 1000
        effective_mhz = int(row["effective_freq_mhz"])
        if point != expected_point:
            raise ValueError(f"{XBAR_STATUS_CSV}: expected point {expected_point}, found {point}")
        if tuning_mhz != 45 or effective_mhz != base_mhz + tuning_mhz:
            raise ValueError(f"{XBAR_STATUS_CSV}: inconsistent point {point}")
        table_rows.append(
            "<tr>"
            f'<td class="align-right">{point}</td>'
            f'<td class="align-right">{voltage_mv}</td>'
            f'<td class="align-right">{base_mhz}</td>'
            f'<td class="align-right">{tuning_mhz:+d}</td>'
            f'<td class="align-right">{effective_mhz}</td>'
            "</tr>"
        )

    return """<details class="data-disclosure">
<summary><span>Complete 127-point STATUS table</span></summary>
<div class="data-disclosure-body">
<p>Collapsed by default. Values are reproduced from the downloadable raw CSV.</p>
<div class="data-disclosure-scroll">
<table>
<thead><tr><th class="align-right">Point</th><th class="align-right">STATUS voltage (mV)</th><th class="align-right">Base frequency (MHz)</th><th class="align-right">Tuning offset (MHz)</th><th class="align-right">Effective frequency (MHz)</th></tr></thead>
<tbody>
""" + "\n".join(table_rows) + """
</tbody>
</table>
</div>
</div>
</details>"""


def expand_post_components(body_html: str, path: Path) -> str:
    rendered_marker = f"<p>{XBAR_TABLE_MARKER}</p>"
    if rendered_marker in body_html:
        body_html = body_html.replace(rendered_marker, render_xbar_status_disclosure())
    if "[[xbar-table:" in body_html:
        raise ValueError(f"{path}: unknown XBAR table marker")
    return body_html


def machine_markdown(body: str) -> str:
    return body.replace(
        XBAR_TABLE_MARKER,
        f"[Complete 127-point STATUS table (CSV)]({XBAR_STATUS_PUBLIC})",
    )


def local_image_dimensions(url: str) -> tuple[int, int] | None:
    if not url.startswith("/") or "?" in url or "#" in url:
        return None
    path = ROOT / url.lstrip("/")
    if not path.is_file():
        return None
    with path.open("rb") as handle:
        header = handle.read(24)
    if header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR":
        return struct.unpack(">II", header[16:24])
    return None


def enrich_images(body_html: str) -> str:
    def replace(match: re.Match[str]) -> str:
        attrs = match.group("attrs").strip()
        source = IMAGE_SRC.search(attrs)
        additions = []
        if " loading=" not in f" {attrs}":
            additions.extend(['loading="lazy"', 'decoding="async"'])
        if source and " width=" not in f" {attrs}" and (size := local_image_dimensions(source.group(1))):
            additions.extend([f'width="{size[0]}"', f'height="{size[1]}"'])
        suffix = f" {' '.join(additions)}" if additions else ""
        return f"<img {attrs}{suffix} />"

    return IMAGE_TAG.sub(replace, body_html)


def render_machine_post(site: dict, post: dict) -> str:
    frontmatter = {
        "title": post["title"],
        "canonical": f"{site['url']}{post['url']}",
        "date": post["date_iso"],
        "language": post["language"],
        "category": post["category"],
        "status": post["status"],
        "summary": post["summary"],
        "evidence_boundary": post["boundary"],
    }
    header = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).strip()
    return f"---\n{header}\n---\n\n# {post['title']}\n\n{post['body_markdown'].strip()}\n"


def render_llms_index(site: dict, posts: list[dict]) -> str:
    lines = [
        f"# {site['title']}",
        "",
        f"> {site['description']}",
        "",
        "Evidence-bounded technical field notes by Loong0x00. Canonical HTML is intended for people; Markdown alternates preserve the same article semantics for machines.",
        "",
        "## Research notes",
        "",
    ]
    lines.extend(
        f"- [{post['title']}]({site['url']}{post['markdown_url']}): {post['summary']}"
        for post in posts
    )
    lines.extend([
        "",
        "## Evidence and data",
        "",
        f"- [XBAR evidence bundle index]({site['url']}/downloads/xbar/INDEX.md): raw notes, CSV data, hashes, runnable code, and verification boundaries.",
        f"- [Atom feed]({site['url']}/feed.xml): publication updates.",
        f"- [Sitemap]({site['url']}/sitemap.xml): canonical HTML pages.",
        f"- [Full machine-readable corpus]({site['url']}/llms-full.txt): all published note text in one file.",
    ])
    return "\n".join(lines) + "\n"


def render_llms_full(site: dict, posts: list[dict]) -> str:
    parts = [
        f"# {site['title']}: full published corpus",
        "",
        f"> {site['description']}",
    ]
    for post in posts:
        parts.extend([
            "",
            "---",
            "",
            f"# {post['title']}",
            "",
            f"Canonical: {site['url']}{post['url']}",
            f"Published: {post['date_iso']}",
            f"Evidence boundary: {post['boundary']}",
            "",
            post["body_markdown"].strip(),
        ])
    return "\n".join(parts) + "\n"


def render_service_worker(posts: list[dict]) -> str:
    page_urls = ["/", "/account/", *(post["url"] for post in posts)]
    static_urls = ["/style.css", "/site.js", "/discussion.js"]
    cacheable_urls = page_urls + static_urls

    digest = hashlib.sha256()
    for url in cacheable_urls:
        relative = url.lstrip("/")
        path = OUT / relative / "index.html" if url.endswith("/") else OUT / relative
        digest.update(url.encode("utf-8"))
        digest.update(path.read_bytes())

    return f'''"use strict";

const CACHE_NAME = "field-notes-{digest.hexdigest()[:16]}";
const CACHEABLE_PATHS = new Set({json.dumps(cacheable_urls, ensure_ascii=False)});

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {{
  event.waitUntil((async () => {{
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("field-notes-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  }})());
}});

async function fetchAndCache(request) {{
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {{
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }}
  return response;
}}

self.addEventListener("fetch", (event) => {{
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !CACHEABLE_PATHS.has(url.pathname)) return;

  event.respondWith((async () => {{
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request, {{ ignoreSearch: true }});
    const update = fetchAndCache(event.request);
    if (cached) {{
      event.waitUntil(update.catch(() => undefined));
      return cached;
    }}
    return update;
  }})());
}});

self.addEventListener("message", (event) => {{
  if (event.data?.type !== "warm" || !Array.isArray(event.data.paths)) return;
  const requests = event.data.paths
    .filter((path) => CACHEABLE_PATHS.has(path))
    .map((path) => new Request(new URL(path, self.location.origin), {{ credentials: "same-origin" }}));
  event.waitUntil((async () => {{
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(requests.map(async (request) => {{
      if (await cache.match(request, {{ ignoreSearch: true }})) return;
      await fetchAndCache(request);
    }}));
  }})());
}});
'''


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def main() -> None:
    site = yaml.safe_load((ROOT / "site.yml").read_text(encoding="utf-8"))
    if comments_api := os.environ.get("COMMENTS_API_URL"):
        site["comments_api"] = comments_api.rstrip("/")
    if not isinstance(site, dict) or not site.get("url"):
        raise ValueError("site.yml must define a public url")
    site["url"] = str(site["url"]).rstrip("/")

    md = MarkdownIt("commonmark", {"html": False}).enable("table")
    md.add_render_rule("th_open", render_table_cell_open)
    md.add_render_rule("td_open", render_table_cell_open)
    posts: list[dict] = []
    seen_slugs: set[str] = set()
    for path in sorted(CONTENT.glob("*.md")):
        meta, body = load_frontmatter(path)
        slug = str(meta["slug"])
        if slug in seen_slugs:
            raise ValueError(f"duplicate slug: {slug}")
        seen_slugs.add(slug)
        date = parse_date(meta["date"])
        body_html = enrich_images(expand_post_components(md.render(body), path))
        post = dict(meta)
        post.update(
            date=date,
            date_iso=date.isoformat(),
            date_display=date.strftime("%Y.%m.%d"),
            date_short=date.strftime("%m.%d"),
            url=f"/notes/{slug}/",
            markdown_url=f"/notes/{slug}/index.md",
            language=str(meta.get("language", site["language"])),
            body_markdown=machine_markdown(body),
            body_html=body_html,
        )
        posts.append(post)

    posts.sort(key=lambda post: post["date"], reverse=True)

    if OUT.exists():
        if OUT.is_symlink() or OUT.resolve() != (ROOT / "public").resolve():
            raise RuntimeError(f"refusing to replace unexpected output path: {OUT}")
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copy2(ROOT / "assets" / "style.css", OUT / "style.css")
    shutil.copy2(ROOT / "assets" / "site.js", OUT / "site.js")
    shutil.copy2(ROOT / "assets" / "discussion.js", OUT / "discussion.js")
    shutil.copy2(ROOT / "assets" / "og.png", OUT / "og.png")
    if DOWNLOADS.exists():
        shutil.copytree(DOWNLOADS, OUT / "downloads")
    (OUT / ".nojekyll").touch()
    write(
        OUT / "_headers",
        """/*
  Cache-Control: public, max-age=0, must-revalidate, no-transform
  Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; style-src 'self'
  Link: </llms.txt>; rel="alternate"; type="text/plain"
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff

/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /
""",
    )

    env = Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=select_autoescape(("html", "xml")),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    shared = {"site": site, "posts": posts}
    index = env.get_template("index.html").render(
        **shared,
        page_title=site["title"],
        description=site["description"],
        canonical=f"{site['url']}/",
    )
    write(OUT / "index.html", index)

    account = env.get_template("account.html").render(
        **shared,
        page_title=f"讨论账户 — {site['author']}",
        description="注册、登录或恢复讨论账户。",
        canonical=f"{site['url']}/account/",
    )
    write(OUT / "account" / "index.html", account)

    post_template = env.get_template("post.html")
    for post in posts:
        rendered = post_template.render(
            **shared,
            post=post,
            page_title=f"{post['title']} — {site['author']}",
            description=post["summary"],
            canonical=f"{site['url']}{post['url']}",
            page_language=post["language"],
            og_type="article",
        )
        write(OUT / "notes" / post["slug"] / "index.html", rendered)
        write(OUT / "notes" / post["slug"] / "index.md", render_machine_post(site, post))

    not_found = env.get_template("404.html").render(
        **shared,
        page_title=f"404 — {site['author']}",
        description="页面不存在。",
        canonical=f"{site['url']}/404.html",
    )
    write(OUT / "404.html", not_found)

    updated = (
        dt.datetime.combine(posts[0]["date"], dt.time(), tzinfo=dt.timezone.utc)
        if posts
        else dt.datetime.fromisoformat(str(site["updated"]))
    )
    write(
        OUT / "feed.xml",
        env.get_template("feed.xml").render(**shared, updated=updated.isoformat()),
    )
    write(OUT / "sitemap.xml", env.get_template("sitemap.xml").render(**shared))
    write(OUT / "llms.txt", render_llms_index(site, posts))
    write(OUT / "llms-full.txt", render_llms_full(site, posts))
    write(OUT / "sw.js", render_service_worker(posts))
    write(
        OUT / "robots.txt",
        f"User-agent: *\nAllow: /\nSitemap: {site['url']}/sitemap.xml\n# Machine-readable index: {site['url']}/llms.txt\n",
    )
    print(f"built {len(posts)} posts into {OUT}")


if __name__ == "__main__":
    main()
