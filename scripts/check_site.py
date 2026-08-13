#!/usr/bin/env python3
from __future__ import annotations

import sys
import urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        fields = {"a": "href", "link": "href", "script": "src", "img": "src"}
        wanted = fields.get(tag)
        if not wanted:
            return
        for key, value in attrs:
            if key == wanted and value:
                self.urls.append(value)


def target_for(source: Path, url: str) -> Path | None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme or parsed.netloc or url.startswith(("mailto:", "data:")):
        return None
    path = urllib.parse.unquote(parsed.path)
    if not path:
        return None
    if path.startswith("/"):
        target = PUBLIC / path.lstrip("/")
    else:
        target = source.parent / path
    if path.endswith("/"):
        target = target / "index.html"
    return target


def main() -> None:
    failures: list[str] = []
    html_files = sorted(PUBLIC.rglob("*.html"))
    if len(html_files) < 3:
        failures.append(f"expected homepage, account and 404; found {len(html_files)} HTML files")
    for path in html_files:
        text = path.read_text(encoding="utf-8")
        if "{{" in text or "{%" in text:
            failures.append(f"unrendered template marker in {path}")
        if " style=" in text:
            failures.append(f"inline style blocked by CSP in {path}")
        parser = Links()
        parser.feed(text)
        for url in parser.urls:
            target = target_for(path, url)
            if target is not None and not target.exists():
                failures.append(f"{path.relative_to(PUBLIC)} -> missing {url}")
    for name in ("feed.xml", "sitemap.xml"):
        try:
            ET.parse(PUBLIC / name)
        except Exception as exc:
            failures.append(f"invalid {name}: {exc}")
    if failures:
        print("\n".join(f"ERROR: {item}" for item in failures), file=sys.stderr)
        raise SystemExit(1)
    print(f"checked {len(html_files)} HTML files; internal links and XML are valid")


if __name__ == "__main__":
    main()
