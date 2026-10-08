"""A quotation is looked for on the page it is cited on (GitHub issue #9).

The page a quotation was cited on had never been compared with anything: doc_verify searched the
whole document and answered with the first match, research cards did not have it, and the
ledger, the red team and the report took the page as declared. A quotation on another page, or
nowhere in the indexed text, is now marked where it is read. Marked, never refused: OCR and
typography make true quotations miss."""
from __future__ import annotations

from types import SimpleNamespace as NS

from misaka.core.documents import index as corpus
from misaka.core.documents.wiring import documents
from misaka.core.research import ledger, planner
from misaka.core.wiring import ToolCollector

PAGES = ["The opening page says nothing in particular about the campaign at all.",
         "The bridge at the Berezina was built by the pontonniers of General Eblé.",
         "A third page closes the chapter with the retreat towards Vilna in December."]
QUOTE = "built by the pontonniers of General Eblé"


def _indexed(tmp_path, monkeypatch):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "march.pdf").write_bytes(b"%PDF-1.4\n% stand-in\n")
    monkeypatch.setattr(corpus, "extract_pages", lambda p, meta=None: list(PAGES))
    monkeypatch.setattr(corpus, "_pdf_page_labels", lambda p: None)
    doc_id, _ = corpus.ingest(str(workspace / "march.pdf"), workspace=str(workspace), with_tree=False)
    return doc_id, str(workspace)


def test_a_quotation_is_found_on_its_page_elsewhere_or_not_at_all(tmp_path, monkeypatch):
    doc_id, workspace = _indexed(tmp_path, monkeypatch)
    assert corpus.locate_quote(doc_id, QUOTE, 2, workspace=workspace)["status"] == "on_page"
    elsewhere = corpus.locate_quote(doc_id, QUOTE, 3, workspace=workspace)
    assert (elsewhere["status"], elsewhere["page"], elsewhere["cited_page"]) == ("elsewhere", 2, 3)
    assert corpus.locate_quote(doc_id, "a sentence the book never wrote", 2, workspace=workspace)["status"] == "not_found"
    assert corpus.locate_quote("0" * 12, QUOTE, 2, workspace=workspace)["status"] == "no_document"


async def test_doc_verify_says_when_the_cited_page_is_the_wrong_one(tmp_path, monkeypatch):
    doc_id, workspace = _indexed(tmp_path, monkeypatch)
    collector = ToolCollector()
    documents.register(collector)
    verify = next(t for t in collector.tools if t.name == "doc_verify")
    ctx = NS(cwd=workspace, model=None, modelRegistry=None, signal=None)
    wrong = (await verify.execute("call", {"doc_id": doc_id, "quote": QUOTE, "page": 3}, None, None, ctx))["content"][0]["text"]
    assert "Not on page 3: the quotation is on page 2" in wrong and f"Cite as: [{doc_id} p2]" in wrong
    right = (await verify.execute("call", {"doc_id": doc_id, "quote": QUOTE, "page": 2}, None, None, ctx))["content"][0]["text"]
    assert right.startswith("✅ Page 2")


def test_research_cards_can_locate_quotations():
    assert "doc_verify" in planner.MATERIAL_TOOLS


def test_the_ledger_marks_a_quotation_cited_on_the_wrong_page(tmp_path, monkeypatch):
    doc_id, workspace = _indexed(tmp_path, monkeypatch)
    run = {"workspace": workspace}
    right = {"source_file": f"doc:{doc_id}#p2", "quote": QUOTE}
    wrong = {"source_file": f"doc:{doc_id}#p3", "quote": QUOTE}
    missing = {"source_file": f"doc:{doc_id}#p2", "quote": "words nobody printed"}
    assert ledger.locate(right, workspace) == "located on p2"
    assert planner._located(wrong, run)["located"] == "NOT on the cited p3: the quotation is on p2"
    assert ledger.locate(missing, workspace).startswith("NOT FOUND")
    assert ledger.locate({"source_file": "notes.md", "quote": QUOTE}, workspace) is None
    assert "located" not in planner._located({"source_file": f"doc:{doc_id}#p2", "quote": ""}, run)


def test_a_quotation_that_runs_onto_the_next_page_is_on_its_cited_page(tmp_path, monkeypatch):
    """Marked "not found" in 0.18.7-0.18.9, and listed as not where it was cited."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "march.pdf").write_bytes(b"%PDF-1.4\n% stand-in\n")
    pages = ["The bridge at the Berezina was built by the pontonniers of", "General Eblé, who stood in the river.",
             "The retreat went on towards Vilna."]
    monkeypatch.setattr(corpus, "extract_pages", lambda p, meta=None: list(pages))
    monkeypatch.setattr(corpus, "_pdf_page_labels", lambda p: None)
    doc_id, _ = corpus.ingest(str(workspace / "march.pdf"), workspace=str(workspace), with_tree=False)
    found = corpus.locate_quote(doc_id, QUOTE, 1, workspace=str(workspace))
    assert (found["status"], found["page"], found["continues_on"]) == ("on_page", 1, 2)
    assert corpus.locate_quote(doc_id, QUOTE, 2, workspace=str(workspace))["status"] == "not_found", \
        "a quotation is located from the page it begins on"
    assert corpus.locate_quote(doc_id, "Eblé, who stood in the river. The retreat", 2,
                               workspace=str(workspace))["status"] == "on_page"


def test_quotations_missing_from_a_book_read_it_once(tmp_path, monkeypatch):
    """Every unfound quotation read and normalised every page again: half a minute for 200 of them
    in an 800-page book, on the node's event loop (0.18.10 sweep)."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "book.pdf").write_bytes(b"%PDF-1.4\n% stand-in\n")
    pages = [f"Page {n} of the salt administration records, nothing quoted here." for n in range(1, 60)]
    monkeypatch.setattr(corpus, "extract_pages", lambda p, meta=None: list(pages))
    monkeypatch.setattr(corpus, "_pdf_page_labels", lambda p: None)
    doc_id, _ = corpus.ingest(str(workspace / "book.pdf"), workspace=str(workspace), with_tree=False)
    reads = []
    real = corpus._iter_pages
    monkeypatch.setattr(corpus, "_iter_pages", lambda *a, **k: reads.append(k.get("lo")) or real(*a, **k))
    for n in range(20):
        assert corpus.locate_quote(doc_id, f"a sentence the book never wrote, number {n}", 5,
                                   workspace=str(workspace))["status"] == "not_found"
    assert reads.count(None) == 1, "the whole book is read once, not once per quotation"
