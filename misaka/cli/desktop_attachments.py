"""Prepare native file-picker selections for the desktop chat composer."""

from __future__ import annotations

import asyncio
import html
import os
from collections.abc import Sequence
from typing import Any

from misaka.utils.image_process import ProcessImageOptions, process_image
from misaka.utils.mime import IMAGE_TYPE_SNIFF_BYTES, detect_supported_image_mime_type

MAX_ATTACHMENTS = 10
MAX_TOTAL_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TEXT_BYTES = 1 * 1024 * 1024

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
_TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".toml",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".bat",
    ".ps1",
    ".sql",
    ".xml",
}
_UNSUPPORTED_SUFFIXES = {
    ".pdf": "PDF",
    ".docx": "Word DOCX",
    ".doc": "Word DOC",
    ".zip": "ZIP archive",
}


def _attachment(
    path: str,
    *,
    size: int | None = None,
    kind: str = "unsupported",
    text: str = "",
    images: list[dict[str, str]] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    return {
        "path": path,
        "name": _name_from_path(path),
        "size": size,
        "kind": kind,
        "text": text,
        "images": images or [],
        "error": error,
    }


def _read_bytes(path: str, size: int | None = None) -> bytes:
    with open(path, "rb") as handle:
        return handle.read() if size is None else handle.read(size)


def _kind_from_suffix(path: str) -> str:
    suffix = _suffix_from_path(path)
    if suffix in _IMAGE_SUFFIXES:
        return "image"
    if suffix in _TEXT_SUFFIXES:
        return "text"
    return "unsupported"


def _name_from_path(path: str) -> str:
    return path.rstrip("\\/").replace("\\", "/").rsplit("/", 1)[-1] or path


def _suffix_from_path(path: str) -> str:
    return os.path.splitext(_name_from_path(path))[1].lower()


async def _prepare_one(path: str, size: int, prefix: bytes) -> dict[str, Any]:
    name = _name_from_path(path)
    suffix = _suffix_from_path(name)
    mime_type = detect_supported_image_mime_type(prefix)
    image_candidate = mime_type is not None or suffix in _IMAGE_SUFFIXES
    item = _attachment(path, size=size, kind="image" if image_candidate else "unsupported")

    if suffix in _UNSUPPORTED_SUFFIXES:
        format_name = _UNSUPPORTED_SUFFIXES[suffix]
        item["error"] = f"{format_name} attachments are not supported yet."
        return item

    if mime_type is None and prefix.startswith((b"%PDF-", b"PK")):
        format_name = "PDF" if prefix.startswith(b"%PDF-") else "ZIP archive"
        item["error"] = f"{format_name} attachments are not supported yet."
        return item

    if image_candidate:
        item["kind"] = "image"
        if size > MAX_IMAGE_BYTES:
            item["error"] = "Image attachments must be 10 MiB or smaller."
            return item
        if mime_type is None:
            item["error"] = "The selected image is damaged or uses an unsupported image encoding."
            return item

        try:
            raw = await asyncio.to_thread(_read_bytes, path, MAX_IMAGE_BYTES + 1)
            if len(raw) > MAX_IMAGE_BYTES:
                item["error"] = "Image attachments must be 10 MiB or smaller."
                return item
            processed = await process_image(raw, mime_type, ProcessImageOptions(autoResizeImages=True))
        except Exception as exc:  # noqa: BLE001 - convert any one-image failure to its item result.
            item["error"] = f"Could not prepare image: {exc}"
            return item

        if not processed.ok:
            item["error"] = processed.message
            return item

        item["images"] = [
            {"type": "image", "mimeType": processed.mimeType, "data": processed.data}
        ]
        label = f"Attached image: {name}."
        notes = [label, *processed.hints]
        item["text"] = f'<file name="{html.escape(name, quote=True)}">\n{"\n".join(notes)}\n</file>\n'
        return item

    if suffix not in _TEXT_SUFFIXES:
        if prefix.startswith(b"PK"):
            item["error"] = "ZIP archive attachments are not supported yet."
        else:
            item["error"] = "Unsupported file type. Attach a supported image or UTF-8 text file."
        return item

    item["kind"] = "text"
    if size > MAX_TEXT_BYTES:
        item["error"] = "Text attachments must be 1 MiB or smaller."
        return item

    try:
        raw = await asyncio.to_thread(_read_bytes, path, MAX_TEXT_BYTES + 1)
        if len(raw) > MAX_TEXT_BYTES:
            item["error"] = "Text attachments must be 1 MiB or smaller."
            return item
        content = raw.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        item["error"] = f"Text attachment is not valid UTF-8: {exc}"
        return item
    except OSError as exc:
        item["error"] = f"Could not read attachment: {exc}"
        return item

    if "\x00" in content:
        item["error"] = "Text attachment contains binary data rather than UTF-8 text."
        return item

    # Match normal UTF-8 text-file reads: Windows CRLF and legacy CR line endings become LF.
    content = content.replace("\r\n", "\n").replace("\r", "\n")

    item["text"] = f'<file name="{html.escape(name, quote=True)}">\n{content}\n</file>\n'
    return item


async def prepare_attachments(paths: Sequence[str | os.PathLike[str]]) -> list[dict[str, Any]]:
    """Read and normalize selected files, returning one JSON-ready result per path.

    File and batch limits are checked before loading file contents. An individual failure is
    recorded in that item's ``error`` field so successfully prepared siblings are retained.
    """

    results: list[dict[str, Any]] = []
    total_bytes = 0
    total_limit_exceeded = False

    for index, raw_path in enumerate(paths):
        try:
            path = os.fspath(raw_path)
        except TypeError:
            results.append(_attachment(str(raw_path), error="Invalid attachment path."))
            continue

        if index >= MAX_ATTACHMENTS:
            results.append(
                _attachment(
                    path,
                    kind=_kind_from_suffix(path),
                    error=f"A maximum of {MAX_ATTACHMENTS} attachments can be selected at once.",
                )
            )
            continue

        try:
            size = (await asyncio.to_thread(os.stat, path)).st_size
        except OSError as exc:
            results.append(
                _attachment(path, kind=_kind_from_suffix(path), error=f"Could not read attachment: {exc}")
            )
            continue

        total_bytes += size
        if total_bytes > MAX_TOTAL_BYTES:
            total_limit_exceeded = True
        if total_limit_exceeded:
            results.append(
                _attachment(
                    path,
                    size=size,
                    kind=_kind_from_suffix(path),
                    error="Selected attachments exceed the 25 MiB total size limit.",
                )
            )
            continue

        try:
            prefix = await asyncio.to_thread(_read_bytes, path, IMAGE_TYPE_SNIFF_BYTES)
        except OSError as exc:
            results.append(_attachment(path, size=size, error=f"Could not read attachment: {exc}"))
            continue

        try:
            results.append(await _prepare_one(path, size, prefix))
        except OSError as exc:
            results.append(_attachment(path, size=size, error=f"Could not read attachment: {exc}"))

    return results


__all__ = ["prepare_attachments"]
