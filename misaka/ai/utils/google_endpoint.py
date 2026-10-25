"""Concrete Google SDK endpoints shared by transports and offline diagnostics."""

from __future__ import annotations

import os


def resolve_google_endpoint(base_url: str, *, vertexai: bool = False, location: str = "global") -> str:
    """Resolve SDK URL precedence before freezing a request's network route.

    Vertex catalog URLs containing ``{location}`` denote SDK defaults, not a
    custom collection endpoint. Keep that distinction in the provider adapter.
    """
    explicit = base_url.strip()
    if vertexai and "{location}" in explicit:
        explicit = ""
    if explicit:
        return explicit

    try:
        from google.genai._base_url import get_base_url
    except ImportError:  # Diagnostics also work without the optional Google SDK.
        override = os.environ.get("GOOGLE_VERTEX_BASE_URL" if vertexai else "GOOGLE_GEMINI_BASE_URL")
    else:
        # The SDK owns set_default_base_urls > environment precedence.
        override = get_base_url(vertexai)
    if override:
        return override
    if not vertexai:
        return "https://generativelanguage.googleapis.com"
    if location == "global":
        return "https://aiplatform.googleapis.com"
    if location in {"us", "eu"}:
        return f"https://aiplatform.{location}.rep.googleapis.com"
    return f"https://{location}-aiplatform.googleapis.com"
