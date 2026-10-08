"""Behavioral contract for files selected in the desktop attachment picker."""

import asyncio
import base64
import io

import pytest
from PIL import Image

from misaka.cli.desktop_attachments import prepare_attachments


def _png_bytes(width=2, height=2):
    image = Image.new("RGB", (width, height), (25, 120, 210))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _image_bytes(image_format):
    image = Image.new("RGB", (2, 2), (25, 120, 210))
    output = io.BytesIO()
    image.save(output, format=image_format)
    return output.getvalue()


def test_prepare_attachments_returns_utf8_text_and_processed_image(tmp_path):
    note = tmp_path / "notes.md"
    note.write_text("# A note\nHello, world!", encoding="utf-8")
    image = tmp_path / "photo.png"
    image.write_bytes(_png_bytes())

    results = asyncio.run(prepare_attachments([str(note), str(image)]))

    assert len(results) == 2
    text_item, image_item = results
    assert (text_item["path"], text_item["name"], text_item["size"], text_item["kind"]) == (
        str(note), "notes.md", note.stat().st_size, "text"
    )
    assert text_item["text"] == '<file name="notes.md">\n# A note\nHello, world!\n</file>\n'
    assert text_item["images"] == []
    assert text_item["error"] is None

    assert image_item["kind"] == "image"
    assert image_item["error"] is None
    assert "photo.png" in image_item["text"]
    assert len(image_item["images"]) == 1
    inline_image = image_item["images"][0]
    assert inline_image["type"] == "image"
    assert inline_image["mimeType"] == "image/png"
    assert base64.b64decode(inline_image["data"]).startswith(b"\x89PNG\r\n\x1a\n")


@pytest.mark.parametrize(
    "image_format, suffix, expected_mime",
    [
        ("PNG", ".png", "image/png"),
        ("JPEG", ".jpg", "image/jpeg"),
        ("GIF", ".gif", "image/gif"),
        ("WEBP", ".webp", "image/webp"),
        ("BMP", ".bmp", "image/png"),
    ],
)
def test_prepare_attachments_normalizes_supported_image_formats(
    tmp_path, image_format, suffix, expected_mime
):
    path = tmp_path / f"image{suffix}"
    path.write_bytes(_image_bytes(image_format))

    [item] = asyncio.run(prepare_attachments([str(path)]))

    assert item["error"] is None
    assert item["kind"] == "image"
    assert item["images"][0]["mimeType"] == expected_mime


@pytest.mark.parametrize(
    "filename, content, message_part",
    [
        ("report.pdf", b"%PDF-1.7", "PDF"),
        ("report.docx", b"PK\x03\x04", "DOCX"),
        ("archive.zip", b"PK\x03\x04", "ZIP"),
        ("payload.bin", b"\x00\x01\xff\x00", "Unsupported"),
    ],
)
def test_prepare_attachments_reports_unsupported_types_per_file(
    tmp_path, filename, content, message_part
):
    path = tmp_path / filename
    path.write_bytes(content)

    [item] = asyncio.run(prepare_attachments([str(path)]))

    assert item["path"] == str(path)
    assert item["name"] == filename
    assert item["size"] == len(content)
    assert item["kind"] == "unsupported"
    assert item["images"] == []
    assert item["text"] == ""
    assert message_part.casefold() in item["error"].casefold()


def test_prepare_attachments_keeps_valid_results_when_another_file_fails(tmp_path):
    good = tmp_path / "readme.txt"
    good.write_text("available", encoding="utf-8")

    results = asyncio.run(prepare_attachments([str(good), str(tmp_path / "missing.txt")]))

    assert results[0]["error"] is None
    assert "available" in results[0]["text"]
    assert results[1]["path"] == str(tmp_path / "missing.txt")
    assert results[1]["error"]
    assert results[1]["images"] == []


def test_prepare_attachments_keeps_windows_picker_basename_on_stat_error():
    path = r"C:\missing\folder\picked.txt"

    [item] = asyncio.run(prepare_attachments([path]))

    assert item["path"] == path
    assert item["name"] == "picked.txt"
    assert item["kind"] == "text"
    assert item["error"]


def test_prepare_attachments_turns_read_io_errors_into_item_errors(tmp_path, monkeypatch):
    import misaka.cli.desktop_attachments as attachments

    failed = tmp_path / "read-error.txt"
    failed.write_text("stat works, read fails", encoding="utf-8")
    good = tmp_path / "good.txt"
    good.write_text("still available", encoding="utf-8")
    read_bytes = attachments._read_bytes

    def read_with_failure(path, size=None):
        if path == str(failed) and size != 4100:
            raise OSError("device read failure")
        return read_bytes(path, size)

    monkeypatch.setattr(attachments, "_read_bytes", read_with_failure)
    results = asyncio.run(prepare_attachments([str(failed), str(good)]))

    assert "device read failure" in results[0]["error"]
    assert results[0]["text"] == ""
    assert results[1]["error"] is None
    assert "still available" in results[1]["text"]


def test_prepare_attachments_rejects_corrupt_image_without_aborting_batch(tmp_path):
    corrupt = tmp_path / "broken.png"
    corrupt.write_bytes(b"not a png")
    good = tmp_path / "ok.txt"
    good.write_text("still processed", encoding="utf-8")

    results = asyncio.run(prepare_attachments([str(corrupt), str(good)]))

    assert results[0]["kind"] == "image"
    assert results[0]["error"]
    assert results[0]["images"] == []
    assert results[1]["error"] is None


def test_prepare_attachments_enforces_per_type_byte_limits_before_processing(tmp_path):
    too_large_text = tmp_path / "large.txt"
    too_large_text.write_bytes(b"x" * (1024 * 1024 + 1))
    too_large_image = tmp_path / "large.png"
    with too_large_image.open("wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.truncate(10 * 1024 * 1024 + 8)

    text_item, image_item = asyncio.run(
        prepare_attachments([str(too_large_text), str(too_large_image)])
    )

    assert text_item["size"] == 1024 * 1024 + 1
    assert text_item["error"] and "1 MiB" in text_item["error"]
    assert image_item["size"] == 10 * 1024 * 1024 + 8
    assert image_item["error"] and "10 MiB" in image_item["error"]


def test_prepare_attachments_limits_count_and_total_raw_size_per_item(tmp_path):
    paths = []
    for index in range(11):
        path = tmp_path / f"{index}.png"
        with path.open("wb") as handle:
            handle.write(b"\x89PNG\r\n\x1a\n")
            handle.truncate(9 * 1024 * 1024)
        paths.append(str(path))

    results = asyncio.run(prepare_attachments(paths))

    assert len(results) == 11
    assert all(item["error"] for item in results)
    assert "25 MiB" in results[2]["error"]
    assert "10" in results[10]["error"]


def test_prepare_attachments_reports_invalid_utf8_text_as_an_item_error(tmp_path):
    path = tmp_path / "bad.txt"
    path.write_bytes(b"hello\xffworld")

    [item] = asyncio.run(prepare_attachments([str(path)]))

    assert item["kind"] == "text"
    assert item["error"] and "UTF-8" in item["error"]
    assert item["text"] == ""


def test_prepare_attachments_marks_paths_after_ten_as_count_errors(tmp_path):
    paths = []
    for index in range(11):
        path = tmp_path / f"{index}.txt"
        path.write_text(str(index), encoding="utf-8")
        paths.append(str(path))

    results = asyncio.run(prepare_attachments(paths))

    assert len(results) == 11
    assert all(item["error"] is None for item in results[:10])
    assert results[10]["error"]
    assert results[10]["text"] == ""
    assert results[10]["images"] == []
