"""Markup -> the text a reader sees, with the structure a reader navigates by.

One extractor, used by everything in this repository that turns HTML into text: `web_fetch`
for a page pulled off the internet, and the corpus for an .html file or an EPUB chapter on
disk. Two copies would mean two answers to "what does this document say" -- and a fix, a
bound, or a hardening applied to one of them.

Standard library only (`html.parser`): a document store must not need a parser wheel to read
Project Gutenberg, and the parser that survives a hostile page is the one with no ambition.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser

import httpx

# A link target longer than this is not a link a model will usefully follow, and the href is
# attacker-chosen text; the anchor still renders, without the URL.
MAX_LINK_CHARS = 500

# A <title> is document-written text that callers repeat as metadata: into a tool result, into
# a corpus meta.json, and from there into whatever ledger row is built from it. Bounded so one
# document cannot decide how much of a turn -- or of a database column -- it occupies; a 2 MiB
# <title> is as easy to serve as a 2 MiB body.
MAX_TITLE_CHARS = 200
# An image's alt text as a marker carries it: enough to say what the picture is, clipped like
# the alt text the Word reader writes (office/docx.py).
MAX_ALT_CHARS = 120

_BLANK_RUN = re.compile(r"\n{3,}")

_HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_HIDDEN = frozenset({"script", "style", "noscript", "template", "svg"})
_BLOCKS = frozenset({
    "article", "aside", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure",
    "footer", "form", "header", "hr", "main", "nav", "ol", "p", "pre", "section",
    "table", "td", "th", "tr", "ul",
})


@dataclass(slots=True)
class _Anchor:
    start: int
    href: str


class Readable(HTMLParser):
    """Visible page text with the structure a reader navigates by kept.

    Headings, list items, paragraph breaks and link targets survive, because those are
    what the next tool call is chosen from: a model that cannot see a page's links has
    to guess the URL of whatever it wants to read next.
    """

    def __init__(self, base_url: str = "", images: list | None = None) -> None:
        super().__init__(convert_charrefs=True)
        # Given a list, an <img> is written where it stands as ``![alt]`` (``![image N]`` with no
        # alt) and its src added to the list in the same order, so a reader can be shown the
        # picture behind each marker. The corpus asks this for an EPUB; a web page is not asked,
        # because its icons and trackers would bury the text.
        self._images = images
        try:
            # No base -- a file on disk, an EPUB chapter -- means no absolute target exists,
            # so links render as the words they show rather than as a URL nobody can follow.
            self._base: httpx.URL | None = httpx.URL(base_url) if base_url else None
        except httpx.InvalidURL:
            self._base = None
        self._seen_base = False
        self._hidden = 0
        self._in_title = False
        self._title: list[str] = []
        self._parts: list[str] = []
        self._anchors: list[_Anchor] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "image" and self._hidden and self._images is not None:
            # An EPUB's cover or plate is often <svg><image xlink:href=...>: the svg is a drawing
            # and stays hidden, the picture it frames does not (0.18.9 sweep).
            found = dict(attrs)
            self._picture(found.get("xlink:href") or found.get("href"), "", framed=True)
            return
        if tag in _HIDDEN:
            self._hidden += 1
            return
        if self._hidden:
            return
        if tag == "base" and not self._seen_base:
            href = next((value for name, value in attrs if name == "href"), None)
            if href is not None:
                self._seen_base = True  # Only the first base with an href takes effect.
                if self._base is not None:
                    try:
                        target = self._base.join(href.strip())
                        if target.scheme in {"http", "https"}:
                            self._base = target
                    except (httpx.InvalidURL, ValueError, UnicodeError):
                        pass
        elif tag == "title":
            self._in_title = True
        elif tag == "a":
            # Only the outermost anchor is tracked. Nested <a> is invalid HTML and a
            # browser closes the outer one anyway, but the real reason is cost: one
            # frame per level makes _close_anchor re-flatten the same, ever-longer text
            # once per level, and each level also re-appends the resolved URL. 40k
            # nested anchors -- 460 KB, well under the fetch cap -- took 8.5s of blocked
            # event loop and rendered 1 MB of text out of them.
            if not self._anchors:
                href = next((value for name, value in attrs if name == "href"), None)
                self._anchors.append(_Anchor(len(self._parts), href or ""))
        elif tag in _HEADINGS:
            self._parts.append("\n\n" + "#" * _HEADINGS[tag] + " ")
        elif tag == "li":
            self._parts.append("\n- ")
        elif tag == "br":
            self._parts.append("\n")
        elif tag == "img" and self._images is not None:
            found = dict(attrs)
            self._picture(found.get("src"), found.get("alt"))
        elif tag in _BLOCKS:
            self._parts.append("\n\n")

    def _picture(self, src: str | None, alt: str | None, *, framed: bool = False) -> None:
        alt = " ".join((alt or "").split())[:MAX_ALT_CHARS]
        marker = f"![{alt or f'image {len(self._images) + 1}'}]"
        self._images.append({"marker": marker, "alt": alt, "src": (src or "").strip(),
                             **({"svg": True} if framed else {})})
        self._parts.append(f" {marker} ")

    def handle_endtag(self, tag: str) -> None:
        if tag in _HIDDEN:
            self._hidden = max(0, self._hidden - 1)
            return
        if self._hidden:
            return
        if tag == "title":
            self._in_title = False
        elif tag == "a" and self._anchors:
            self._close_anchor(self._anchors.pop())
        elif tag in _HEADINGS or tag in _BLOCKS:
            self._parts.append("\n\n")

    def handle_data(self, data: str) -> None:
        if self._hidden:
            return
        if self._in_title:
            self._title.append(data)
            return
        if not data.strip():
            # Whitespace between two inline elements is a word boundary: dropping it
            # outright glues "<b>foo</b> <i>bar</i>" into one word.
            if self._parts and not self._parts[-1].endswith((" ", "\n")):
                self._parts.append(" ")
            return
        self._parts.append(data)

    def _close_anchor(self, anchor: _Anchor) -> None:
        text = " ".join("".join(self._parts[anchor.start:]).split())
        del self._parts[anchor.start:]
        if not text:
            return
        target = self._absolute(anchor.href)
        self._parts.append(f"[{text}]({target})" if target else text)

    def _absolute(self, href: str) -> str:
        """An absolute http(s) target for *href*, or "" if it is not one worth showing."""
        href = href.strip()
        if not href or self._base is None or href.startswith(("#", "javascript:", "data:", "mailto:")):
            return ""
        try:
            target = self._base.join(href)
        except (httpx.InvalidURL, ValueError, UnicodeError):
            return ""
        if target.scheme not in {"http", "https"}:
            return ""
        rendered = str(target)
        return rendered if len(rendered) <= MAX_LINK_CHARS else ""

    def title(self) -> str:
        return " ".join("".join(self._title).split())

    def text(self) -> str:
        lines = (" ".join(line.split()) for line in "".join(self._parts).split("\n"))
        return _BLANK_RUN.sub("\n\n", "\n".join(lines)).strip()


def clip(value: str, limit: int) -> str:
    """One document-written string, short enough to quote. The ellipsis is deliberate:
    a silently shortened value reads as the whole thing."""
    return value if len(value) <= limit else value[:limit] + "…"


def readable(markup: str, base_url: str = "", images: list | None = None) -> tuple[str, str]:
    """``(text, title)`` for a markup document. ``base_url`` resolves relative links; ``images``,
    when given, collects the pictures the text marks (see ``Readable``)."""
    parser = Readable(base_url, images)
    try:
        parser.feed(markup)
        parser.close()
    except Exception:  # noqa: BLE001, S110 - broken markup: keep whatever parsed first
        pass
    return parser.text(), clip(parser.title(), MAX_TITLE_CHARS)
