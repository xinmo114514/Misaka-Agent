from types import SimpleNamespace
from contextlib import closing
import json
import time

from misaka.core.research import desktop_view, runs
from misaka.core.platform import tasks


def test_registered_artifact_returns_full_text_and_workspace_relative_path(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    body = "# Node conclusion\n\nFull evidence-backed conclusion.\n"
    path = workspace / "nodes" / "n_1" / "SYNTHESIS.md"
    path.parent.mkdir(parents=True)
    path.write_bytes(body.encode("utf-8"))
    row = {
        "id": "a_1", "kind": "synthesis", "title": "Node conclusion",
        "path": str(path), "sha256": runs.hashlib.sha256(body.encode("utf-8")).hexdigest(),
    }

    result = desktop_view.registered_artifact(row, str(workspace))

    assert result == {
        "id": "a_1", "kind": "synthesis", "title": "Node conclusion",
        "path": "nodes/n_1/SYNTHESIS.md", "state": "available", "content": body,
    }


def test_registered_artifact_reports_changed_content_without_returning_it(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    path = workspace / "nodes" / "n_1" / "SYNTHESIS.md"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"edited conclusion")
    row = {
        "id": "a_2", "kind": "synthesis", "title": "Node conclusion",
        "path": str(path), "sha256": "frozen-digest-from-registration",
    }

    result = desktop_view.registered_artifact(row, str(workspace))

    assert result["state"] == "changed"
    assert result["content"] is None


def test_registered_artifact_reports_missing_content(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    row = {
        "id": "a_3", "kind": "critique", "title": "Red team",
        "path": str(workspace / "missing.md"), "sha256": "digest",
    }

    result = desktop_view.registered_artifact(row, str(workspace))

    assert result["state"] == "missing"
    assert result["content"] is None


def test_registered_artifact_rejects_paths_outside_workspace(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    outside = tmp_path / "private.md"
    outside.write_bytes(b"outside")
    row = {
        "id": "a_4", "kind": "final", "title": "Report",
        "path": str(outside), "sha256": runs.hashlib.sha256(b"outside").hexdigest(),
    }

    result = desktop_view.registered_artifact(row, str(workspace))

    assert result["state"] == "outside_workspace"
    assert result["content"] is None


def test_run_node_and_report_read_models_expose_details_without_embedding_report_twice(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="A small research question")
        root = runs.root(con, run["id"])
        final_body = "# Final answer\n\nA complete report with its references.\n"
        final_id, _ = runs.write_text(con, run["id"], "final", "Final report", "final/final.md", final_body)
        synthesis = "# Conclusion\n\nThe full node conclusion.\n"
        synthesis_id, _ = runs.write_text(
            con, run["id"], "synthesis", "Node conclusion", f"nodes/{root['id']}/SYNTHESIS.md",
            synthesis, branch_id=root["id"],
        )

        detail = desktop_view.run_detail(con, run["id"])
        node = desktop_view.node_detail(con, run["id"], root["id"])
        report = desktop_view.artifact_detail(con, run["id"], final_id)
        full_synthesis = desktop_view.artifact_detail(con, run["id"], synthesis_id)

        assert detail["run"]["id"] == run["id"]
        assert detail["graph"]["nodes"][0]["id"] == root["id"]
        report_index = next(item for item in detail["graph"]["final_artifacts"] if item["id"] == final_id)
        assert report_index["path"] == "final/final.md"
        assert "content" not in report_index
        assert node["artifacts"][0]["content"] == synthesis
        assert report["content"] == final_body
        assert full_synthesis["content"] == synthesis


def test_node_and_artifact_reads_are_scoped_to_the_requested_run(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        left = runs.create(con, workspace=str(first), question="First")
        right = runs.create(con, workspace=str(second), question="Second")
        foreign_node = runs.root(con, right["id"])
        assert desktop_view.node_detail(con, left["id"], foreign_node["id"]) is None
        assert desktop_view.artifact_detail(con, left["id"], "unknown") is None


def test_active_run_status_can_be_shown_while_the_chat_switches_projects(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        active = runs.create(con, workspace=str(first), question="Active in first project")
        waiting = runs.create(con, workspace=str(second), question="Waiting in second project")
        completed = runs.create(con, workspace=str(second), question="Completed")
        runs.set_state(con, active["id"], status="active", phase="executing")
        runs.set_state(con, waiting["id"], status="waiting_input", phase="waiting_input")
        runs.set_state(con, completed["id"], status="done", phase="done")

        result = desktop_view.active_runs(con)

        assert {item["id"] for item in result} == {active["id"], waiting["id"]}
        assert next(item for item in result if item["id"] == waiting["id"])["phase"] == "waiting_input"


def test_node_detail_returns_errata_against_that_node_with_the_complete_correction_record(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="A question")
        root = runs.root(con, run["id"])
        reviewer = runs.create_node(con, run["id"], question="A reviewer", parents=[root["id"]])
        payload = {"node": root["id"], "claim": "Earlier statement", "correction": "Corrected statement",
                   "grounds": "cards/evidence.md"}
        con.execute("INSERT INTO research_actions VALUES (?,?,?,?,?,?,?)",
                    (run["id"], reviewer["id"], "erratum:fixture", json.dumps(payload),
                     "sessions/reviewer.jsonl", "fixture-call", int(time.time())))

        detail = desktop_view.node_detail(con, run["id"], root["id"])

        assert detail["errata"] == [{"raised_by": reviewer["id"], **payload}]
