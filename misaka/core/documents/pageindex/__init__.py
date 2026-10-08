"""MISAKA's in-process PageIndex adapter."""

from __future__ import annotations

import importlib.util

# The third-party packages the vendored tree imports, all of them MISAKA's own dependencies
# since 2026-10-07 (they were the ``pageindex`` extra). One missing is a broken install.
REQUIREMENTS = ("PyPDF2", "pypdfium2", "regex", "sortedcontainers")

INSTALL_HINT = "reinstall MISAKA (PyPDF2 and sortedcontainers are its dependencies; in a checkout, uv sync)"


class PageIndexUnavailable(RuntimeError):
    """PageIndex's packages are missing from this install.

    A distinct type so callers can tell "this install cannot do structure extraction at all"
    -- actionable, and the same for every document -- from a per-document parse failure.
    """


def available() -> bool:
    """Whether structure extraction can run in this install."""
    for name in REQUIREMENTS:
        try:
            if importlib.util.find_spec(name) is None:
                return False
        except (ImportError, ValueError):
            return False
    return True


def build_tree(pdf, *, workers=None) -> list[dict]:
    """Return the deterministic PageIndex outline for a PDF."""
    try:
        from .flash import page_index_flash
    except ModuleNotFoundError as exc:
        if exc.name in set(REQUIREMENTS):
            raise PageIndexUnavailable(
                f"PageIndex structure extraction needs the optional extra: {INSTALL_HINT}"
            ) from exc
        raise
    return page_index_flash(pdf, workers=workers).get("structure") or []


__all__ = ["INSTALL_HINT", "REQUIREMENTS", "PageIndexUnavailable", "available", "build_tree"]
