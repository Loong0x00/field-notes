#!/usr/bin/env python3
from __future__ import annotations

import csv
import datetime as dt
import os
import shutil
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
XBAR_STATUS_TABLE_MARKER = "[[data-table:astral-2001w-xbar-status]]"
XBAR_STATUS_CSV = (
    DOWNLOADS / "xbar" / "astral-2001w-xoc-r610.57.04-xbar.csv"
)


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


def render_xbar_status_table() -> str:
    with XBAR_STATUS_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != 127:
        raise ValueError(f"{XBAR_STATUS_CSV}: expected 127 points, found {len(rows)}")

    lines = [
        "| Point | STATUS voltage (mV) | Base frequency (MHz) | Frequency tuning offset (MHz) | Effective frequency (MHz) |",
        "|---:|---:|---:|---:|---:|",
    ]
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
        lines.append(
            f"| {point} | {voltage_mv} | {base_mhz} | {tuning_mhz:+d} | {effective_mhz} |"
        )
    return "\n".join(lines)


def expand_data_tables(body: str, path: Path) -> str:
    if XBAR_STATUS_TABLE_MARKER in body:
        body = body.replace(XBAR_STATUS_TABLE_MARKER, render_xbar_status_table())
    if "[[data-table:" in body:
        raise ValueError(f"{path}: unknown data-table marker")
    return body


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
        body = expand_data_tables(body, path)
        slug = str(meta["slug"])
        if slug in seen_slugs:
            raise ValueError(f"duplicate slug: {slug}")
        seen_slugs.add(slug)
        date = parse_date(meta["date"])
        post = dict(meta)
        post.update(
            date=date,
            date_iso=date.isoformat(),
            date_display=date.strftime("%Y.%m.%d"),
            date_short=date.strftime("%m.%d"),
            url=f"/notes/{slug}/",
            body_html=md.render(body),
        )
        posts.append(post)

    posts.sort(key=lambda post: post["date"], reverse=True)

    if OUT.exists():
        if OUT.is_symlink() or OUT.resolve() != (ROOT / "public").resolve():
            raise RuntimeError(f"refusing to replace unexpected output path: {OUT}")
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copy2(ROOT / "assets" / "style.css", OUT / "style.css")
    shutil.copy2(ROOT / "assets" / "discussion.js", OUT / "discussion.js")
    shutil.copy2(ROOT / "assets" / "og.png", OUT / "og.png")
    if DOWNLOADS.exists():
        shutil.copytree(DOWNLOADS, OUT / "downloads")
    (OUT / ".nojekyll").touch()

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
        )
        write(OUT / "notes" / post["slug"] / "index.html", rendered)

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
    write(
        OUT / "robots.txt",
        f"User-agent: *\nAllow: /\nSitemap: {site['url']}/sitemap.xml\n",
    )
    print(f"built {len(posts)} posts into {OUT}")


if __name__ == "__main__":
    main()
