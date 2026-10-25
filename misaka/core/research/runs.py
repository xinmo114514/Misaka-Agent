"""Persistent research-run state and file artifacts.

A run is a directed acyclic graph of nodes (``research_branches`` joined by ``research_edges``).
The root (depth 0) is the question as asked; every other node pursues an option of a decision
some node made -- a possibility (another hypothesis, method, reading, perspective, decomposition,
or a critique of the question itself), never a correction: corrections stay in their node as
revision rounds. A node reached by options of several nodes, or opened to carry several finished
nodes forward together, has several parents. Research prose lives directly in the project from
its first write: ``<workspace>/nodes/<node>/`` per node (its cards under ``cards/``) and
``<workspace>/final/`` for run-level products. Session transcripts share the existing
``~/.misaka/sessions`` store. SQLite is the only authority on the graph; the graph files in the
project are views written from it and never read back.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import socket
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from misaka.config import home
from misaka.core.platform import tasks as task_store
from misaka.utils import atomic

# Cards that review rather than research: a critique records issues, a divergence review records
# alternatives. Neither feeds the evidence ledger.
CRITIQUE_KINDS = frozenset({"red_team", "final_review"})
REVIEW_KINDS = CRITIQUE_KINDS | {"divergence"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS research_actions (
  run_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  session_file TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,branch_id,action_key)
);
CREATE TABLE IF NOT EXISTS research_runs (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  question        TEXT NOT NULL,
  phase           TEXT NOT NULL,
  status          TEXT NOT NULL,
  wave            INTEGER NOT NULL DEFAULT 0,
  limits_json     TEXT NOT NULL,
  token_start     INTEGER NOT NULL DEFAULT 0,
  root_session    TEXT,
  origin_session  TEXT,
  stop_requested  INTEGER NOT NULL DEFAULT 0,
  final_artifact  TEXT,
  last_error      TEXT,
  driver_lock     TEXT,
  driver_expires  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_branches (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  question        TEXT NOT NULL,
  depth           INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  session_file    TEXT,
  fork_entry      TEXT,
  context_artifact TEXT,
  runner_pid      INTEGER,
  runner_identity TEXT,
  runner_key      TEXT,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_edges (
  run_id          TEXT NOT NULL,
  child_id        TEXT NOT NULL,
  parent_id       TEXT NOT NULL,
  PRIMARY KEY(child_id,parent_id)
);
CREATE TABLE IF NOT EXISTS research_decisions (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  round           INTEGER NOT NULL,
  origin          TEXT NOT NULL,
  question        TEXT NOT NULL,
  stakes          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_options (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  decision_id     TEXT NOT NULL,
  label           TEXT NOT NULL,
  premise         TEXT NOT NULL,
  node_id         TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_relations (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  note            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_relation_nodes (
  relation_id     TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  position        INTEGER NOT NULL,
  PRIMARY KEY(relation_id,node_id)
);
CREATE TABLE IF NOT EXISTS research_reconciles (
  run_id          TEXT NOT NULL,
  round           INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  session_file    TEXT NOT NULL,
  tool_call_id    TEXT NOT NULL,
  approved_call_id TEXT,
  receipt_json    TEXT,
  applied_at      INTEGER,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY(run_id,round)
);
CREATE TABLE IF NOT EXISTS research_run_tasks (
  task_id         TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  branch_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  round           INTEGER NOT NULL DEFAULT 1,
  local_id        TEXT,
  depends_json    TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_issues (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  branch_id       TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  round           INTEGER NOT NULL,
  origin          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  question        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  disposition     TEXT,
  option_id       TEXT,
  covered_by      TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_artifacts (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  branch_id       TEXT,
  task_id         TEXT,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  path            TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_findings (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  branch_id       TEXT,
  task_id         TEXT NOT NULL,
  text            TEXT NOT NULL,
  claim_type      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_claims (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id      TEXT NOT NULL,
  artifact_id     TEXT,
  source_file     TEXT NOT NULL,
  quote           TEXT NOT NULL,
  evidence_sha    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(finding_id,artifact_id,quote)
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS research_branches_run ON research_branches(run_id,depth);
CREATE INDEX IF NOT EXISTS research_edges_parent ON research_edges(parent_id);
CREATE INDEX IF NOT EXISTS research_edges_run ON research_edges(run_id);
CREATE INDEX IF NOT EXISTS research_decisions_run ON research_decisions(run_id,node_id);
CREATE INDEX IF NOT EXISTS research_options_run ON research_options(run_id,decision_id);
CREATE INDEX IF NOT EXISTS research_relations_run ON research_relations(run_id);
CREATE INDEX IF NOT EXISTS research_relation_nodes_node ON research_relation_nodes(node_id);
CREATE INDEX IF NOT EXISTS research_tasks_run ON research_run_tasks(run_id,branch_id,kind);
CREATE INDEX IF NOT EXISTS research_issues_run ON research_issues(run_id,branch_id,round);
CREATE INDEX IF NOT EXISTS research_issues_option ON research_issues(option_id);
CREATE INDEX IF NOT EXISTS research_artifacts_run ON research_artifacts(run_id,branch_id,kind);
CREATE UNIQUE INDEX IF NOT EXISTS research_artifacts_generated ON research_artifacts(run_id,path) WHERE task_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS research_artifacts_task ON research_artifacts(run_id,task_id,path) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS research_findings_run ON research_findings(run_id,branch_id,task_id);
CREATE INDEX IF NOT EXISTS research_claims_finding ON research_claims(finding_id);
CREATE UNIQUE INDEX IF NOT EXISTS research_tasks_local ON research_run_tasks(run_id,branch_id,local_id) WHERE local_id IS NOT NULL;
"""

ACTIVE = ("active", "waiting_input", "stopping")
# closed = the node's own work is done. Its options wait for the level's reconciliation and its
# children run on their own: neither is the node's status.
NODE_TERMINAL = ("closed", "failed", "parked")
DEFAULT_LIMITS = {"max_depth": 3, "parallel": 4, "sister_parallel": 4, "max_followups": 2,
                  "max_revisions": 2, "max_nodes": 30}
MAX_NODES_CEILING = 500
# A run's own compaction threshold, as a share of the context window: below a tenth a session would
# compact on nearly every turn, above 0.95 there is no room left to compact into.
MIN_CONTEXT_THRESHOLD, MAX_CONTEXT_THRESHOLD = 0.1, 0.95
RESEARCH_SCHEMA_VERSION = 18   # typed issue destinations (option_id, covered_by); relation members as rows
DRIVER_TTL_SECONDS = 300
RESEARCH_TABLES = (
    "research_actions", "research_reconciles",
    "research_claims", "research_findings", "research_artifacts",
    "research_issues", "research_relation_nodes", "research_relations", "research_options", "research_decisions",
    "research_run_tasks", "research_edges", "research_branches", "research_runs",
)
# What Last Order may answer a red-team issue with; one she took to her decision ends as ``branch``
# (``option_id`` = the option that takes it up) or, not opened, as ``covered`` (``covered_by``, or the
# ``option_id`` of an option waiting to be opened) or ``decline``.
CRITIQUE_DISPOSITIONS = ("revise", "correct", "rebut", "concede", "covered", "park", "branch")
# What becomes of a divergence proposal at the node's decision. A gap is not a proposal: the
# divergence review's gaps are filled or answered in its own rounds, before the node forks.
PROPOSAL_DISPOSITIONS = ("branch", "covered", "decline")
RELATION_KINDS = ("converge", "diverge", "resonates", "appropriates", "displaces")


def _execute_script(con, source):
    """Execute a static SQL script without ``executescript``'s implicit commit."""
    statement = ""
    for line in source.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            con.execute(statement)
            statement = ""
    if statement.strip():
        raise RuntimeError("Incomplete research schema statement.")


@contextmanager
def _savepoint(con):
    """Make schema-creation rollback independent of a caller's surrounding transaction."""
    name = "research_schema_init"
    con.execute(f"SAVEPOINT {name}")
    try:
        yield
    except BaseException:
        con.execute(f"ROLLBACK TO {name}")
        con.execute(f"RELEASE {name}")
        raise
    else:
        con.execute(f"RELEASE {name}")


def _schema_state(con):
    """One read snapshot of the table and the current marker."""
    row = con.execute(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'),"
        "EXISTS(SELECT 1 FROM schema_migrations WHERE component='research' AND version=?)",
        (RESEARCH_SCHEMA_VERSION,),
    ).fetchone()
    return bool(row[0]), bool(row[1])


def _matches_current_schema(con):
    """True when every active table has the current columns and UNIQUE constraints."""
    expected = sqlite3.connect(":memory:")
    try:
        _execute_script(expected, SCHEMA)

        def signature(db, table):
            columns = tuple(
                (row[1], row[2].upper(), int(row[3]), row[4], int(row[5]))
                for row in db.execute(f'PRAGMA table_info("{table}")')
            )
            unique = sorted(
                tuple(item[2] for item in db.execute(f'PRAGMA index_info("{index[1]}")'))
                for index in db.execute(f'PRAGMA index_list("{table}")')
                if index[2] and index[3] == "u"
            )
            return columns, unique

        return all(signature(con, table) == signature(expected, table)
                   for table in RESEARCH_TABLES)
    finally:
        expected.close()


def _validate_current_schema(con):
    """A version marker is not proof of table shape. Recheck after any SQLite DDL change."""
    cookie = (RESEARCH_SCHEMA_VERSION, con.execute("PRAGMA schema_version").fetchone()[0])
    if getattr(con, "_research_schema_checked", None) == cookie:
        return
    if not _matches_current_schema(con):
        raise RuntimeError(f"Research schema v{RESEARCH_SCHEMA_VERSION} marker does not match its tables. "
                           "Reload the current MISAKA build before starting research; no run was created.")
    if hasattr(con, "__dict__"):
        con._research_schema_checked = cookie


def init(con):
    has_runs, current = _schema_state(con)
    if has_runs and current:
        _validate_current_schema(con)
        return                               # the normal read path takes no SQLite write lock
    # DDL is transactional in SQLite, but ``executescript`` commits implicitly. Keep the new
    # tables, indexes and the version marker under one explicit transaction.
    with task_store.write_txn(con), _savepoint(con):
        # Another process may have created the schema while this one waited for BEGIN IMMEDIATE.
        has_runs, current = _schema_state(con)
        if has_runs and current:
            _validate_current_schema(con)
            return
        if task_store.require_schema(con, "research", RESEARCH_SCHEMA_VERSION, populated=has_runs):
            _execute_script(con, SCHEMA)
            _execute_script(con, INDEXES)


def _lease_holder_is_dead(lock):
    """Whether a driver lock (``driver:<host>:<pid>:<nonce>``) names a process on this host
    that no longer exists. A reused pid reads as alive and leaves the TTL to decide, which
    is the safe side; a foreign host is never judged from here."""
    parts = str(lock or "").split(":")
    if len(parts) != 4 or parts[0] != "driver" or parts[1] != socket.gethostname():
        return False
    try:
        pid = int(parts[2])
    except ValueError:
        return False
    import psutil
    return pid > 0 and not psutil.pid_exists(pid)


def driver_is_live(run, *, now=None):
    """Whether a persisted driver lease still names a live holder under the shared-TTL rule."""
    lock = run["driver_lock"]
    expires = run["driver_expires"]
    return bool(lock) and (expires is None or expires >= (time.time() if now is None else now)) and not _lease_holder_is_dead(lock)


def acquire_driver(con, run_id, lock, ttl_seconds=DRIVER_TTL_SECONDS):
    """Take the run's driver lease: one process advances a run at a time. False when another
    live lease holds it."""
    now = int(time.time())
    with task_store.write_txn(con):
        previous = get(con, run_id)
        if previous["driver_lock"] and previous["driver_lock"] != lock and _lease_holder_is_dead(previous["driver_lock"]):
            # A driver that died hard (a crashed pane, SIGKILL) neither renews nor releases;
            # waiting its TTL out only holds the run (2026-09-23: three refusals, cleared by
            # hand). Its lease expires here, inside the takeover transaction.
            con.execute("UPDATE research_runs SET driver_expires=0 WHERE id=? AND driver_lock=?",
                        (run_id, previous["driver_lock"]))
        cur = con.execute(
            "UPDATE research_runs SET driver_lock=?, driver_expires=? WHERE id=? "
            "AND (driver_lock IS NULL OR driver_expires IS NULL OR driver_expires < ? OR driver_lock=?)",
            (lock, now + int(ttl_seconds), run_id, now, lock),
        )
        if cur.rowcount != 1:
            return False
        if previous["driver_lock"] != lock:
            # Invalidate delayed child spawns in the same transaction as takeover.
            # Keep PID/identity for the successor's existing orphan-reaping path.
            con.execute("UPDATE research_branches SET runner_key=NULL WHERE run_id=?", (run_id,))
    return True


def heartbeat_driver(con, run_id, lock, ttl_seconds=DRIVER_TTL_SECONDS):
    cur = con.execute(
        "UPDATE research_runs SET driver_expires=? WHERE id=? AND driver_lock=?",
        (int(time.time()) + int(ttl_seconds), run_id, lock),
    )
    return cur.rowcount == 1


def release_driver(con, run_id, lock):
    con.execute("UPDATE research_runs SET driver_lock=NULL, driver_expires=NULL WHERE id=? AND driver_lock=?",
                (run_id, lock))


# Cards past these statuses keep their dependency history as it is: the DAG must not be rewritten
# under a moving card, and a finished one (whose execution already finished) has
# nothing left to wait for. Read by ``workflow._submit_tasks``, which replays a plan's edges
# onto cards that may already have run.
SETTLED_TASK_STATUSES = frozenset({"running", "review", "done", "failed", "stopped", "archived"})


def node_dir(node_id):
    """The folder a node owns: ``nodes/<node id>``, the root included. Flat on purpose: a node
    with several parents has no single place in a nested tree. A node id is a name, as
    ``session_dir`` and ``_artifact_name`` already insist."""
    node_id = str(node_id or "")
    if not node_id or Path(node_id).name != node_id or node_id in {".", ".."} or "\\" in node_id:
        raise ValueError(f"A node id is a name, not a path: {node_id!r}")
    return os.path.join("nodes", node_id)


def _bounded_int(raw, key, low, high):
    value = raw.get(key, DEFAULT_LIMITS[key])
    message = f"{key} must be an integer between {low} and {high}"
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(message)  # noqa: TRY004 - startup callers surface ValueError
    try:
        value = int(value)
    except ValueError as error:
        raise ValueError(message) from error
    if not low <= value <= high:
        raise ValueError(message)
    return value


def normalize_limits(raw=None):
    raw = raw or {}
    value = raw.get("max_depth", DEFAULT_LIMITS["max_depth"])
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("max_depth must be an integer")  # noqa: TRY004
    try:
        depth = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("max_depth must be an integer") from error
    if not 0 <= depth <= 12:
        raise ValueError("max_depth must be between 0 and 12")
    concurrency = {}
    for key in ("parallel", "sister_parallel"):
        value = raw.get(key, DEFAULT_LIMITS[key])
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise ValueError(f"{key} must be a positive integer")  # noqa: TRY004 - startup callers surface ValueError
        try:
            value = int(value)
        except ValueError as error:
            raise ValueError(f"{key} must be a positive integer") from error
        if value < 1:
            raise ValueError(f"{key} must be a positive integer")
        concurrency[key] = value
    result = {
        "max_depth": depth, **concurrency,
        # How many more times a node may send its Sisters out after its first cards are back, over
        # its whole life (before its first conclusion and while revising one). Conversation with
        # the user is never counted.
        "max_followups": _bounded_int(raw, "max_followups", 0, 6),
        # How many times a node may revise its conclusion after a red-team review; each revision
        # is reviewed again. 0 = the first conclusion is final and every issue is answered otherwise.
        "max_revisions": _bounded_int(raw, "max_revisions", 0, 6),
        # How many nodes the whole graph may hold, the root included; checked when options open.
        "max_nodes": _bounded_int(raw, "max_nodes", 1, MAX_NODES_CEILING),
    }
    if "plan_approval" in raw:
        if not isinstance(raw["plan_approval"], bool):
            raise ValueError("plan_approval must be a boolean")
        result["plan_approval"] = raw["plan_approval"]
    # The run's own session settings; absent, its sessions follow the global ones.
    if raw.get("context_threshold") is not None:
        threshold = raw["context_threshold"]
        if (isinstance(threshold, bool) or not isinstance(threshold, (int, float))
                or not MIN_CONTEXT_THRESHOLD <= threshold <= MAX_CONTEXT_THRESHOLD):
            raise ValueError(f"context_threshold must be a fraction between {MIN_CONTEXT_THRESHOLD} and {MAX_CONTEXT_THRESHOLD}")
        result["context_threshold"] = float(threshold)
    if raw.get("max_output_tokens") is not None:
        cap = raw["max_output_tokens"]
        if isinstance(cap, bool) or not isinstance(cap, int) or cap < 1024:
            raise ValueError("max_output_tokens must be an integer of at least 1024")
        result["max_output_tokens"] = cap
    return result


def session_overrides(run):
    """What the run's sessions -- its Last Order windows and its Sisters' cards -- run with instead
    of the global settings: its compaction threshold and output limit, when it chose them."""
    chosen = limits(run) if run is not None else {}
    return {key: chosen[key] for key in ("context_threshold", "max_output_tokens") if key in chosen}


def prepare_runner(con, table, row_id):
    key = secrets.token_hex(16)
    changed = con.execute(f'UPDATE "{table}" SET runner_key=?, last_error=NULL WHERE id=? '
                          'AND runner_pid IS NULL AND runner_identity IS NULL', (key, row_id)).rowcount
    if changed != 1:
        raise RuntimeError(f"Research execution {row_id} still has a runner")
    return key


def _own_identity(pid):
    """This process's identity, or ``host:pid`` where neither psutil nor ``ps`` can read its start
    time (a restricted container: every node crashed at start there, issue #10 audit, H5). Only
    for the process's own claim -- its PID cannot be reused while it runs. ``processes.identity``
    itself keeps answering None for an unreadable process: everywhere else that None is what keeps
    a reused PID from passing for the recorded one."""
    from misaka.core.platform import processes
    return processes.identity(pid) or f"{socket.gethostname()}:{pid}"


def claim_runner(con, table, row_id, key):
    """Fence delayed/duplicate spawns, including a lost pane.create reply."""
    from misaka.core.platform import processes
    if not key:
        return False
    pid = os.getpid()
    identity = _own_identity(pid)
    # The parent recorded this process's identity from its own psutil, whose start times can
    # sit a whole second from what this process reads (processes.IDENTITY_TOLERANCE_SECONDS),
    # so the fence compares in Python and the row then carries this process's own reading.
    row = con.execute(f'SELECT runner_pid, runner_identity FROM "{table}" WHERE id=? AND runner_key=?',
                      (row_id, key)).fetchone()
    if row is None:
        return False
    if row["runner_pid"] is not None and not (
            int(row["runner_pid"]) == pid and processes.same_identity(row["runner_identity"], identity)):
        return False
    return con.execute(f'UPDATE "{table}" SET runner_pid=?, runner_identity=? WHERE id=? AND runner_key=? '
                       'AND (runner_pid IS NULL OR runner_pid=?)',
                       (pid, identity, row_id, key, pid)).rowcount == 1


def note_claim_failure(con, table, row_id, key):
    """Say which part of the claim fence refused this process, and leave it on the row.

    2026-09-18 (B33): six node processes exited with "superseded execution" within a second
    of spawning, four resumes in a row, and the driver could only report "no exception was
    recorded". Every replay of the fence in isolation succeeded; the live difference was
    never captured because the losing side wrote nothing down. Now it does: the row as the
    process saw it against what the process holds, kept in ``last_error`` (only if nothing
    else is there yet) so the driver's error carries it."""
    from misaka.core.platform import processes
    row = con.execute(f'SELECT runner_key, runner_pid, runner_identity FROM "{table}" WHERE id=?',
                      (row_id,)).fetchone()
    pid = os.getpid()
    identity = _own_identity(pid)
    if row is None:
        reason = f"row {row_id} no longer exists"
    elif not key:
        reason = "this process was started without a runner key"
    elif row["runner_key"] != key:
        reason = (f"runner key mismatch: row holds {(row['runner_key'] or '')[:8] or 'NULL'!r}, "
                  f"this process holds {key[:8]!r}")
    elif row["runner_pid"] is not None and (row["runner_pid"] != pid
                                            or not processes.same_identity(row["runner_identity"], identity)):
        reason = (f"runner identity mismatch: row holds pid {row['runner_pid']} {row['runner_identity']!r}, "
                  f"this process is pid {pid} {identity!r}")
    else:
        reason = "fence refused for no visible reason (the row changed between the claim and this read)"
    text = f"claim refused: {reason}"
    try:
        con.execute(f'UPDATE "{table}" SET last_error=COALESCE(last_error,?) WHERE id=?', (text, row_id))
    except sqlite3.Error:
        pass
    return text


def release_runner(con, table, row_id, key):
    """The runner's routine is over but its process stays alive (an interactive node keeps its
    window open for the user). Consume the key too: release is durable even before the first
    parent poll, and a late spawn reply must never resurrect this execution."""
    con.execute(f'UPDATE "{table}" SET runner_pid=NULL, runner_identity=NULL, runner_key=NULL WHERE id=? AND runner_key=?',
                (row_id, key))


def session_dir(run, scope, *parts):
    """One conversation directory under the existing session store, not a separate run home."""
    from misaka.config import sessions
    values = (run["id"], scope, *parts)
    if any(not p or Path(p).name != p or p in {".", ".."} or "\\" in p for p in values):
        raise ValueError("Research session scope must contain names, not paths.")
    return os.path.join(sessions.sessions_root(), "research", "--".join(values))


def task_contexts(con):
    """Owning project and research lineage, with every card in the same project."""
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'").fetchone():
        return {}
    init(con)
    return {row["task_id"]: dict(row) for row in con.execute(
        "SELECT t.task_id,t.run_id,t.branch_id AS node_id,b.depth,t.kind,t.round,"
        "r.workspace,r.origin_session,b.question AS node_question "
        "FROM research_run_tasks t JOIN research_runs r ON r.id=t.run_id "
        "JOIN research_branches b ON b.id=t.branch_id")}


def project_name(run):
    """Display name of the run's project: the workspace folder's basename."""
    return os.path.basename(run["workspace"].rstrip(os.sep)) or run["workspace"]


def for_session(con, session_id):
    """The runs a conversation started, newest first -- the ones whose mode it is in."""
    if not session_id or not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'").fetchone():
        return []
    return [dict(row) for row in con.execute(
        "SELECT * FROM research_runs WHERE origin_session=? ORDER BY created_at DESC", (session_id,))]


def is_active(con, run_id):
    """Whether a driver is meant to be advancing this run right now."""
    if not run_id or not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'").fetchone():
        return False
    row = con.execute("SELECT status FROM research_runs WHERE id=?", (run_id,)).fetchone()
    return bool(row) and row["status"] in ACTIVE


def ensure_layout(run):
    root = Path(run["workspace"])
    for rel in ("nodes", "final"):
        (root / rel).resolve().relative_to(root.resolve())
        (root / rel).mkdir(parents=True, exist_ok=True)
    return str(root)


def _atomic_write(path, content):
    atomic.write_text(path, content)


def _artifact_name(name):
    if not name or Path(name).name != name or name in {".", ".."} or "\\" in name:
        raise ValueError("Generated research artifacts need a filename, not a directory path.")
    return name


def versioned(name, version):
    """``synthesis.md`` for version 1, ``synthesis-<n>.md`` after: how every per-version product of a
    node is named (plans, conclusions, deliberations, a red team's critique of each version)."""
    stem, ext = os.path.splitext(name)
    return name if int(version) <= 1 else f"{stem}-{int(version)}{ext}"


def version_of(path, name):
    """The version ``versioned(name, n)`` put in ``path``'s file name, or None for another file."""
    stem, ext = os.path.splitext(name)
    base = os.path.basename(str(path))
    if base == name:
        return 1
    match = re.fullmatch(re.escape(stem) + r"-(\d+)" + re.escape(ext), base)
    return int(match.group(1)) if match else None


def generated_path(name, *, node_id):
    """A node's artifact, relative to the project: ``nodes/<node>/<name>``."""
    return os.path.join(node_dir(node_id), _artifact_name(name))


def run_path(run, name):
    """A run-level product (question, clarifications, survey, draft, final, partial, workspace
    index, graph views): ``final/<run>-<name>``, so the run's deliverables and the sources they
    cite sit in one folder and two runs of one project never overwrite each other."""
    return os.path.join("final", f"{run['id']}-{_artifact_name(name)}")


def create(con, *, workspace, question, limits=None, token_start=0, origin_session=None):
    workspace = os.path.realpath(os.path.expanduser(str(workspace or "")))
    if not os.path.isdir(workspace):
        raise ValueError(f"A research run needs an existing project folder: {workspace}")
    question = str(question or "").strip()
    if len(question) < 2:
        raise ValueError("The research question cannot be empty.")
    init(con)
    now = int(time.time())
    run_id = "r_" + secrets.token_hex(5)
    spec = normalize_limits(limits)
    # One unit: a run row without its root node is a run ``workflow.run`` would walk straight to
    # finalize as "every node closed", handing back a final report with no research behind it.
    # An interrupted create must leave no row at all.
    with task_store.write_txn(con):
        con.execute(
            "INSERT INTO research_runs "
            "(id,workspace,question,phase,status,limits_json,token_start,origin_session,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (run_id, workspace, question, "created", "active",
             json.dumps(spec, ensure_ascii=False), int(token_start), origin_session, now, now),
        )
        row = get(con, run_id)
        ensure_layout(row)
        write_text(con, run_id, "question", 'Original research question', run_path(row, "question.md"),
                   f"""# Original research question

{question}
""")
        create_node(con, run_id, question=question, parents=())
    return get(con, run_id)


def get(con, run_id):
    init(con)
    return con.execute("SELECT * FROM research_runs WHERE id=?", (run_id,)).fetchone()


def latest(con, workspace=None, active_only=False):
    init(con)
    q, args = "SELECT * FROM research_runs WHERE 1=1", []
    if workspace:
        q += " AND workspace=?"
        args.append(workspace)
    if active_only:
        q += " AND status IN ('active','waiting_input','stopping')"
    return con.execute(q + " ORDER BY created_at DESC LIMIT 1", args).fetchone()


def listing(con, *, workspace=None):
    init(con)
    if workspace:
        return con.execute(
            "SELECT * FROM research_runs WHERE workspace=? ORDER BY created_at DESC", (workspace,)
        ).fetchall()
    return con.execute("SELECT * FROM research_runs ORDER BY created_at DESC").fetchall()


def limits(run):
    try:
        return normalize_limits(json.loads(run["limits_json"]))
    except (TypeError, ValueError):
        return dict(DEFAULT_LIMITS)


# What `/research limits` and `misaka research --limits` may change on a running run, and when each
# change is first read. The workflow reads them from the database at those points (current_limits),
# not from the run row it started with.
ADJUSTABLE_LIMITS = {
    "sister_parallel": "at once",
    "parallel": "from the next level of nodes",
    "max_depth": "at the next reconciliation",
    "max_nodes": "at the next reconciliation",
    "max_followups": "at each node's next follow-up decision",
    "max_revisions": "at each node's next review",
}


def limits_changed(before, after):
    """What a change of limits did, and when each changed limit is first read."""
    changed = [key for key in ADJUSTABLE_LIMITS if before[key] != after[key]]
    if not changed:
        return "no limit changed"
    return "; ".join(f"{key} {before[key]} → {after[key]} ({ADJUSTABLE_LIMITS[key]})" for key in changed)


def current_limits(con, run):
    """The run's limits as they stand now: a run's limits can change while it runs (update_limits)."""
    return limits(get(con, run["id"]) or run)


def update_limits(con, run_id, changes):
    """Change a run's limits while it runs: ``(before, after)``. The same bounds as a new run's, and
    never below what the run already holds -- a graph of 12 nodes cannot be limited to 10. Raises
    ValueError saying what to change."""
    unknown = sorted(set(changes) - set(ADJUSTABLE_LIMITS))
    if unknown:
        raise ValueError(f"not adjustable: {', '.join(unknown)} (adjustable: {', '.join(ADJUSTABLE_LIMITS)})")
    with task_store.write_txn(con):
        run = get(con, run_id)
        if not run:
            raise ValueError(f"Research run not found: {run_id}")
        if run["status"] == "done":
            raise ValueError(f"Research run {run_id} is done; its limits no longer matter.")
        before = limits(run)
        after = normalize_limits({**json.loads(run["limits_json"] or "{}"), **changes})
        held, deepest = con.execute(
            "SELECT COUNT(*), COALESCE(MAX(depth), 0) FROM research_branches WHERE run_id=?", (run_id,)).fetchone()
        if after["max_nodes"] < held:
            raise ValueError(f"max_nodes {after['max_nodes']} is below the {held} nodes the graph already holds")
        if after["max_depth"] < deepest:
            raise ValueError(f"max_depth {after['max_depth']} is below the depth {deepest} a node already has")
        con.execute("UPDATE research_runs SET limits_json=? WHERE id=?", (json.dumps(after, sort_keys=True), run_id))
    return before, after


def set_state(con, run_id, *, phase=None, status=None, error=None,
              root_session=None, final_artifact=None, wave=None, driver_lock=None):
    """Update run state. With ``driver_lock`` the write lands only while that lease is held:
    a driver that lost its lease cannot fail or finish a run its successor now owns."""
    values, fields = [], []
    for name, value in (("phase", phase), ("status", status), ("last_error", error),
                        ("root_session", root_session and home.stored(root_session)),
                        ("final_artifact", final_artifact)):
        if value is not None:
            fields.append(f"{name}=?")
            values.append(value)
    if wave is not None:
        fields.append("wave=?")
        values.append(int(wave))
    fields.append("updated_at=?")
    values.extend([int(time.time()), run_id])
    where = "id=?"
    if driver_lock is not None:
        where += " AND driver_lock=?"
        values.append(driver_lock)
    cur = con.execute(f"UPDATE research_runs SET {','.join(fields)} WHERE {where}", values)
    if driver_lock is not None and cur.rowcount != 1:
        raise RuntimeError(f"Research run {run_id}: driver lease lost.")
    return get(con, run_id)


def request_stop(con, run_id):
    con.execute(
        "UPDATE research_runs SET stop_requested=1,status='stopping',updated_at=? "
        "WHERE id=? AND status IN ('active','waiting_input','stopping')",
        (int(time.time()), run_id),
    )


def resume(con, run_id, *, driver_lock=None, clarification=""):
    with task_store.write_txn(con):
        return _resume(con, run_id, driver_lock=driver_lock, clarification=clarification)


def _resume(con, run_id, *, driver_lock, clarification):
    """Reopen a stopped, failed, or waiting run: same card generations, nodes pick up where they were.
    A finished run is not resumable: its report is final; start a new run."""
    current = get(con, run_id)
    if current is None:
        raise ValueError(f"Research run not found: {run_id}")
    if current["status"] == "done":
        raise ValueError(f"Research run {run_id} is done; start a new run instead of resuming it.")
    if (current["driver_lock"] and current["driver_lock"] != driver_lock
            and (current["driver_expires"] is None or current["driver_expires"] >= time.time())):
        raise ValueError(f"Research run {run_id} is already being driven by another process.")
    if clarification:
        n = len(artifacts(con, run_id, kind="clarification")) + 1
        write_text(con, run_id, "clarification", f"User clarification {n}",
                   run_path(current, f"clarification-{n}.md"), clarification + "\n")
        con.execute("UPDATE research_runs SET question=question||? WHERE id=?",
                    (f"\n\nUser clarification: {clarification}", run_id))
    for branch in nodes(con, run_id):
        round, previous = current_plan(con, run_id, branch["id"])
        if previous and previous["payload"].get("status") == "clarify":
            delete_action(con, run_id, branch["id"], plan_key(round))
    reopen_cards(con, run_id)
    from misaka.core.research.suspension import resolve_suspensions
    resolve_suspensions(con, run_id)
    # A failed node replans: every phase of ``_expand`` is idempotent over what it already
    # produced (saved plans, cards and project-local artifacts), so it picks up its own work.
    con.execute(
        "UPDATE research_branches SET status='planning',updated_at=? "
        "WHERE run_id=? AND status IN ('waiting_input','awaiting_approval','failed')", (int(time.time()), run_id),
    )
    con.execute(
        "UPDATE research_runs SET stop_requested=0,status='active',phase='active',last_error='',"
        "updated_at=? WHERE id=?", (int(time.time()), run_id),
    )
    return get(con, run_id)


def help_waiting(con, row):
    """True only for a card parked by its own current SendMessage help request."""
    if row["status"] not in {"blocked", "triage"} or row["block_kind"] != "needs_input":
        return False
    try:
        payload = json.loads(task_store.latest_payload(con, row["id"], row["status"], generation=row["generation"])
                             or "{}")
    except (TypeError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("message_id") is not None


def parked(con, row):
    """A card blocked or in triage with no help request of its own waiting on an answer (dispatch's
    "blocked:" verdict, a missing project folder): nothing moves it on by itself. A node used to
    fail on it with no decision of Last Order's -- or as "a dependency cycle" -- and no resume
    reopened it (0.18.10 sweep); it is now a lost card like a failed one."""
    return row["status"] in {"blocked", "triage"} and not help_waiting(con, row)


def reopen_cards(con, run_id, node_id=None):
    """Send the run's (or one node's) stopped, failed and unusable cards back to their Sisters.
    A failed card is retried like a stopped one: without this the node it killed replays the
    identical failure on every resume, and the only way out is editing this database by hand.
    A card its node went on without stays as it is."""
    given_up = given_up_cards(con, run_id, node_id)
    for row in tasks(con, run_id, node_id=node_id):
        if row["id"] in given_up:
            continue
        unusable = row["status"] == "done" and (
            task_store.latest_payload(con, row["id"], "research_review_missing", generation=row["generation"])
            or _drift_after_declaration(con, row["id"], int(row["generation"])))
        if row["status"] not in ("stopped", "failed") and not unusable and not parked(con, row):
            continue
        target = "todo" if task_store.parent_ids(con, row["id"]) else "ready"
        if task_store.reopen_task(
            con, row["id"], target_status=target,
            expected_generation=row["generation"], invalidate_descendants=False,
        ):
            task_store.add_event(
                con, row["id"], "research_resumed",
                {"from_generation": row["generation"]}, generation=int(row["generation"]) + 1,
            )


RETRY_LIMIT = 3     # ponytail: a fixed cap; a node that fails a fourth time needs a person, not a loop


def retry_node(con, run, node_id, *, session_file, tool_call_id):
    """Last Order's retry of a failed node, without waiting for the level to end and the run to
    be resumed: its failed cards go back to their Sisters and it replans -- every phase picks up
    what it already produced, as on a resume. While the level still runs, its driver starts the
    node again as soon as a slot is free; after the level, the resume does. Each retry is the
    node's command ``retry:<call>``; ``RETRY_LIMIT`` of them end the loop."""
    current = node(con, node_id)
    if current is None or current["run_id"] != run["id"]:
        raise ValueError(f"No node {node_id} in run {run['id']}.")
    if current["status"] != "failed":
        raise ValueError(f"Node {node_id} is {current['status']}, not failed; only a failed node is retried.")
    tried = con.execute("SELECT COUNT(*) FROM research_actions WHERE branch_id=? AND action_key LIKE 'retry:%'",
                        (node_id,)).fetchone()[0]
    if tried >= RETRY_LIMIT:
        raise ValueError(f"Node {node_id} was already retried {tried} times; its failure needs the user.")
    with task_store.write_txn(con):
        reopen_cards(con, run["id"], node_id)
        from misaka.core.research.suspension import resolve_suspensions
        resolve_suspensions(con, run["id"], node_id=node_id)
        con.execute("UPDATE research_branches SET status='planning',last_error=NULL,updated_at=? WHERE id=?",
                    (int(time.time()), node_id))
        con.execute("INSERT INTO research_actions VALUES (?,?,?,?,?,?,?)",
                    (run["id"], node_id, f"retry:{tool_call_id}", json.dumps({"attempt": tried + 1}),
                     home.stored(session_file), tool_call_id, int(time.time())))
    return tried + 1


def _drift_after_declaration(con, task_id, generation):
    """A settle found this generation's files changed after its latest declaration. A card that
    declared again since (todo._redeclare_if_done) is not reopened for the older finding."""
    drift = con.execute("SELECT max(id) FROM events WHERE task_id=? AND kind='research_artifact_drift' "
                        "AND generation=?", (task_id, generation)).fetchone()[0]
    declared = con.execute("SELECT max(id) FROM events WHERE task_id=? AND kind='submitted' AND generation=?",
                           (task_id, generation)).fetchone()[0]
    return drift is not None and (declared is None or drift > declared)


def stop_requested(con, run_id):
    row = get(con, run_id)
    return not row or bool(row["stop_requested"])


def task_count(con, run_id):
    return con.execute(
        "SELECT COUNT(*) FROM research_run_tasks WHERE run_id=?", (run_id,)
    ).fetchone()[0]


def link_task(con, run_id, task_id, *, kind, node, local_id=None, dependencies=(), round=1):
    """Attach a card to a node; one project-local output directory protects concurrent cards.
    ``round`` is the card's round within its kind: a research card's planning round, a red-team
    card's review round (a node may plan, and be reviewed, more than once)."""
    run = get(con, run_id)
    if not run:
        raise ValueError(f"Research run not found: {run_id}")
    task = task_store.get(con, task_id)
    if task is None or os.path.realpath(task["workspace"]) != run["workspace"]:
        raise ValueError("Research cards must execute in the run's project folder.")
    # The card lives inside its node's folder: nodes/<node>/cards/<card>.
    output_dir = Path(run["workspace"], node_dir(node["id"]), "cards", task_id)
    output_dir.resolve().relative_to(Path(run["workspace"]).resolve())
    dependencies = list(dependencies)
    con.execute(
        "INSERT INTO research_run_tasks "
        "(task_id,run_id,branch_id,kind,round,local_id,depends_json,created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (task_id, run_id, node["id"], kind, int(round), local_id,
         json.dumps(dependencies, ensure_ascii=False), int(time.time())),
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    con.execute("UPDATE tasks SET output_dir=? WHERE id=?", (str(output_dir), task_id))
    # ``cards.create(after_row=...)`` calls this before the child card file exists;
    # create publishes the complete needs list in its first file. Direct callers link
    # already-created cards here as before.
    task = task_store.get(con, task_id)
    if task is not None:
        from misaka.core.platform import cards as card_files
        card_exists = os.path.isfile(card_files.card_path(task["workspace"], task_id))
    else:
        card_exists = False
    if card_exists:
        parents = []
        for dependency in dependencies:
            parent = con.execute(
                "SELECT task_id FROM research_run_tasks WHERE run_id=? AND branch_id=? AND local_id=?",
                (run_id, node["id"], dependency),
            ).fetchone()
            if parent:
                parents.append(parent["task_id"])
        try:
            task_store.link_dependencies(con, parents, task_id)
        except (ValueError, OSError) as error:
            task_store.add_event(con, task_id, "dependency_unlinked",
                                 {"parents": parents, "reason": str(error)})
            raise RuntimeError(f"Research dependency could not be linked onto {task_id}: {error}") from error


def tasks(con, run_id, *, kind=None, node_id=None, round=None):
    q, args = (
        ("SELECT t.*,rt.branch_id,rt.kind AS research_kind,rt.round,rt.local_id,rt.depends_json "
         "FROM research_run_tasks rt JOIN tasks t ON t.id=rt.task_id WHERE rt.run_id=?"),
        [run_id],
    )
    if kind:
        q += " AND rt.kind=?"
        args.append(kind)
    if node_id is not None:
        q += " AND rt.branch_id=?"
        args.append(node_id)
    if round is not None:
        q += " AND rt.round=?"
        args.append(int(round))
    return con.execute(q + " ORDER BY rt.created_at", args).fetchall()


# --- nodes: the research graph --------------------------------------------------------

def create_node(con, run_id, *, question, parents):
    """A node and its edges, in the caller's transaction. Its depth is one more than its deepest
    parent's (0 for the root, the only node without parents). Every parent already exists when
    its child is written and edges never change, so the graph stays acyclic without a cycle check."""
    run = get(con, run_id)
    if not run:
        raise ValueError(f"Research run not found: {run_id}")
    parent_ids = list(dict.fromkeys(parents))
    rows = [node(con, parent_id) for parent_id in parent_ids]
    if any(row is None or row["run_id"] != run_id for row in rows):
        raise ValueError("A node's parents must be nodes of the same run.")
    existing = con.execute("SELECT COUNT(*) FROM research_branches WHERE run_id=?", (run_id,)).fetchone()[0]
    if not rows and existing:
        raise ValueError("A run has one root; every later node has parents.")
    depth = max(int(row["depth"]) for row in rows) + 1 if rows else 0
    chosen = limits(run)
    if depth > chosen["max_depth"]:
        raise RuntimeError("The research run has reached its depth limit.")
    if existing >= chosen["max_nodes"]:
        raise RuntimeError("The research run has reached its node limit.")
    bid = "b_" + secrets.token_hex(5)
    now = int(time.time())
    con.execute(
        "INSERT INTO research_branches (id,run_id,question,depth,status,created_at,updated_at) "
        "VALUES (?,?,?,?,'queued',?,?)",
        (bid, run_id, " ".join(str(question).split()), depth, now, now),
    )
    con.executemany("INSERT INTO research_edges (run_id,child_id,parent_id) VALUES (?,?,?)",
                    [(run_id, bid, parent_id) for parent_id in parent_ids])
    return node(con, bid)


def node(con, node_id):
    return con.execute("SELECT * FROM research_branches WHERE id=?", (node_id,)).fetchone()


def nodes(con, run_id):
    return con.execute("SELECT * FROM research_branches WHERE run_id=? ORDER BY depth,created_at,rowid",
                       (run_id,)).fetchall()


def is_root(node):
    return int(node["depth"]) == 0


def root(con, run_id):
    return con.execute("SELECT * FROM research_branches WHERE run_id=? AND depth=0", (run_id,)).fetchone()


def parents(con, node_id):
    return con.execute(
        "SELECT b.* FROM research_edges e JOIN research_branches b ON b.id=e.parent_id "
        "WHERE e.child_id=? ORDER BY b.depth,b.created_at,b.rowid", (node_id,)).fetchall()


def children(con, node_id):
    return con.execute(
        "SELECT b.* FROM research_edges e JOIN research_branches b ON b.id=e.child_id "
        "WHERE e.parent_id=? ORDER BY b.depth,b.created_at,b.rowid", (node_id,)).fetchall()


def edges(con, run_id):
    return con.execute("SELECT child_id,parent_id FROM research_edges WHERE run_id=? ORDER BY rowid",
                       (run_id,)).fetchall()


def next_level(con, run_id):
    """The BFS frontier: every node still expanding at the shallowest such depth, oldest first.
    A node deeper than all its parents never runs before them."""
    rows = [n for n in nodes(con, run_id) if n["status"] not in NODE_TERMINAL]
    return [n for n in rows if n["depth"] == rows[0]["depth"]] if rows else []


def set_node(con, node_id, *, status=None, session_file=None, context_artifact=None, owner=None):
    fields, values = [], []
    for name, value in (("status", status), ("session_file", session_file and home.stored(session_file)),
                        ("context_artifact", context_artifact)):
        if value is not None:
            fields.append(f"{name}=?")
            values.append(value)
    fields.append("updated_at=?")
    values.extend([int(time.time()), node_id])
    with task_store.write_txn(con):
        if owner is not None:
            check_owner(con, *owner)
        con.execute(f"UPDATE research_branches SET {','.join(fields)} WHERE id=?", values)
    return node(con, node_id)


def set_fork_entry(con, node_id, entry):
    """Where the node's own conversation begins in its session: the last entry it inherited (a
    fork's parent turns, or the root window's turns before the run). None = the whole session."""
    con.execute("UPDATE research_branches SET fork_entry=?,updated_at=? WHERE id=?",
                (entry, int(time.time()), node_id))


# --- issues: what review cards raised, and what Last Order did with each ------------------

def add_issue(con, run_id, *, node, task_id, round, origin, kind, question, rationale, priority=0):
    """One issue a review card raised: a red-team issue (``origin='critique'``) or a divergence
    proposal (``origin='divergence'``). Only an exact repeat inside the same card's same round,
    case and whitespace aside, is the same issue: the same question from another card or another
    node is its own, answered by its own Last Order, and one a reviewer raises again in a later
    round is answered again -- matched against the earlier round, it was folded into an issue
    already answered and the round looked clean (2026-10-01). Semantic judgement is Last Order's,
    never a match here."""
    question = str(question or "").strip()
    if not question:
        return None
    normalized = " ".join(question.casefold().split())
    for row in con.execute("SELECT id,question FROM research_issues WHERE task_id=? AND round=?",
                           (task_id, int(round))):
        if " ".join(row["question"].casefold().split()) == normalized:
            return row["id"]
    iid = "i_" + secrets.token_hex(5)
    con.execute(
        "INSERT INTO research_issues "
        "(id,run_id,branch_id,task_id,round,origin,kind,question,rationale,priority,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (iid, run_id, node["id"], task_id, int(round), origin, str(kind or "unclassified"), question,
         str(rationale or ""), int(priority or 0), int(time.time())),
    )
    return iid


def issues(con, run_id, *, node_id=None, round=None, origin=None, option_id=None):
    q, args = "SELECT * FROM research_issues WHERE run_id=?", [run_id]
    for column, value in (("branch_id", node_id), ("round", round), ("origin", origin), ("option_id", option_id)):
        if value is not None:
            q += f" AND {column}=?"
            args.append(value)
    return con.execute(q + " ORDER BY round,priority DESC,created_at,rowid", args).fetchall()


def issue(con, issue_id):
    return con.execute("SELECT * FROM research_issues WHERE id=?", (issue_id,)).fetchone()


def dispose(con, issue_id, disposition, *, option=None, covered_by=None, reason=None):
    """What Last Order did with one issue. Recorded from her accepted command, never inferred:
    ``option`` is the option that takes the issue up -- a ``branch`` issue's own, or the option
    waiting to be opened that a ``covered`` one falls under -- ``covered_by`` the node that already
    pursues a ``covered`` one."""
    con.execute("UPDATE research_issues SET disposition=?,option_id=?,covered_by=?,reason=? WHERE id=?",
                (disposition, option, covered_by, reason, issue_id))


def destination(issue):
    """Where an issue went, in words: the option that takes it up or the node that covers it."""
    if issue["option_id"]:
        return f"option {issue['option_id']}"
    if issue["covered_by"]:
        return f"node {issue['covered_by']}"
    return None


def errata(con, run_id):
    """Corrections recorded against conclusions of this run, oldest first. Each is a node's command
    (``erratum:<call>``): ``raised_by`` is that node, ``node`` the one corrected."""
    return [{"raised_by": row["branch_id"], **json.loads(row["payload_json"])} for row in con.execute(
        "SELECT branch_id,payload_json FROM research_actions WHERE run_id=? AND action_key LIKE 'erratum:%' "
        "ORDER BY created_at,rowid", (run_id,))]


# --- decisions and options -------------------------------------------------------------

def _derived_id(prefix, *parts):
    """An id fixed by where the record came from, so recording it again changes nothing."""
    return prefix + hashlib.sha256("\x1f".join(str(part) for part in parts).encode()).hexdigest()[:12]


def add_decision(con, run_id, *, node, round, origin, index, question, stakes, options):
    """One decision a node made -- in its first plan (``origin='plan'``) or after its divergence
    review (``origin='decide'``) -- with its options. An option marked ``own`` is the node's own
    line and is pursued by the node itself; every other option waits for the level's
    reconciliation, which opens it as a node or records why not. Replays are idempotent."""
    did = _derived_id("d_", node["id"], origin, round, index)
    now = int(time.time())
    con.execute(
        "INSERT OR IGNORE INTO research_decisions (id,run_id,node_id,round,origin,question,stakes,created_at) "
        "VALUES (?,?,?,?,?,?,?,?)", (did, run_id, node["id"], int(round), origin, question, stakes, now))
    for position, option in enumerate(options):
        con.execute(
            "INSERT OR IGNORE INTO research_options (id,run_id,decision_id,label,premise,node_id,created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (_derived_id("o_", did, position), run_id, did, option["label"], option["premise"],
             node["id"] if option.get("own") else None, now))
    return did


def decisions(con, run_id, *, node_id=None):
    q, args = "SELECT * FROM research_decisions WHERE run_id=?", [run_id]
    if node_id is not None:
        q += " AND node_id=?"
        args.append(node_id)
    return con.execute(q + " ORDER BY created_at,rowid", args).fetchall()


def options(con, run_id, *, decision_id=None):
    q, args = "SELECT * FROM research_options WHERE run_id=?", [run_id]
    if decision_id is not None:
        q += " AND decision_id=?"
        args.append(decision_id)
    return con.execute(q + " ORDER BY rowid", args).fetchall()


def option(con, option_id):
    return con.execute("SELECT * FROM research_options WHERE id=?", (option_id,)).fetchone()


_OPTION_WITH_DECISION = (
    "SELECT o.*,d.node_id AS decided_at,d.question AS decision_question,d.stakes AS decision_stakes,"
    "d.origin AS decision_origin FROM research_options o JOIN research_decisions d ON d.id=o.decision_id ")


def pending_options(con, run_id):
    """Options no reconciliation has given an outcome yet: neither a node nor a reason."""
    return con.execute(_OPTION_WITH_DECISION + "WHERE o.run_id=? AND o.node_id IS NULL AND o.reason IS NULL "
                       "ORDER BY d.created_at,d.rowid,o.rowid", (run_id,)).fetchall()


def origin_options(con, node_id):
    """The options that led to this node: decided at another node and pursued here."""
    return con.execute(_OPTION_WITH_DECISION + "WHERE o.node_id=? AND d.node_id!=? ORDER BY d.created_at,o.rowid",
                       (node_id, node_id)).fetchall()


def set_option(con, option_id, *, node_id=None, reason=None):
    con.execute("UPDATE research_options SET node_id=?,reason=? WHERE id=?", (node_id, reason, option_id))


# --- relations: what links nodes without scheduling anything ------------------------------

def relations(con, run_id):
    members = {}
    for row in con.execute(
            "SELECT m.relation_id,m.node_id FROM research_relation_nodes m JOIN research_relations r "
            "ON r.id=m.relation_id WHERE r.run_id=? ORDER BY m.relation_id,m.position", (run_id,)):
        members.setdefault(row["relation_id"], []).append(row["node_id"])
    return [{**dict(row), "nodes": members.get(row["id"], [])} for row in con.execute(
        "SELECT * FROM research_relations WHERE run_id=? ORDER BY created_at,rowid", (run_id,))]


def _add_relation(con, relation_id, run_id, kind, note, members, now):
    """One relation and its member nodes, in order; recording the same id again changes nothing."""
    con.execute("INSERT OR IGNORE INTO research_relations (id,run_id,kind,note,created_at) VALUES (?,?,?,?,?)",
                (relation_id, run_id, kind, note, now))
    con.executemany("INSERT OR IGNORE INTO research_relation_nodes (relation_id,node_id,position) VALUES (?,?,?)",
                    [(relation_id, node_id, position) for position, node_id in enumerate(members)])


def add_relations(con, run, items):
    """Record relations seen outside a reconciliation (the survey of a finished run). Each is
    identified by what it says, so recording it again changes nothing. Returns how many are new."""
    with task_store.write_txn(con):
        _owned_run(con, run)
        known = {row["id"] for row in relations(con, run["id"])}
        added = 0
        for item in items:
            members = list(dict.fromkeys(item["nodes"]))
            relation_id = _derived_id("rel_", run["id"], item["kind"], *sorted(members), item["note"])
            added += relation_id not in known
            known.add(relation_id)
            _add_relation(con, relation_id, run["id"], item["kind"], item["note"], members, int(time.time()))
        return added


# --- reconciliation: the level barrier's run-level command -------------------------------

def reconcile(con, run_id, round):
    row = con.execute("SELECT * FROM research_reconciles WHERE run_id=? AND round=?", (run_id, int(round))).fetchone()
    if row is None:
        return None
    return {**dict(row), "payload": json.loads(row["payload_json"]),
            "receipt": json.loads(row["receipt_json"]) if row["receipt_json"] else None}


def reconcile_rounds(con, run_id):
    """Every reconciliation of the run, oldest first."""
    return [reconcile(con, run_id, row[0]) for row in con.execute(
        "SELECT round FROM research_reconciles WHERE run_id=? ORDER BY round", (run_id,))]


def _owned_run(con, run):
    check_owner(con, run, None, allow_stop=True)
    current = get(con, run["id"])
    if current["stop_requested"] or current["status"] != "active":
        raise ValueError("Research command belongs to a stopped or superseded run.")


def record_reconcile(con, run, round, payload, *, session_file, tool_call_id):
    """Accept the root Last Order's reconciliation for ``round``. A second call before it is
    applied replaces the first, and the user's go-ahead for the earlier one no longer counts."""
    with task_store.write_txn(con):
        _owned_run(con, run)
        prior = reconcile(con, run["id"], round)
        if prior is not None and prior["applied_at"] is not None:
            raise ValueError(f"Reconciliation {round} is already applied; the graph has moved on.")
        con.execute(
            "INSERT OR REPLACE INTO research_reconciles "
            "(run_id,round,payload_json,session_file,tool_call_id,approved_call_id,receipt_json,applied_at,created_at) "
            "VALUES (?,?,?,?,?,NULL,NULL,NULL,?)",
            (run["id"], int(round), json.dumps(payload, ensure_ascii=False), home.stored(session_file),
             tool_call_id, int(time.time())))
    return reconcile(con, run["id"], round)


def approve_reconcile(con, run, round):
    """The user's go-ahead, recorded by the root Last Order, for the reconciliation as it stands."""
    with task_store.write_txn(con):
        _owned_run(con, run)
        current = reconcile(con, run["id"], round)
        if current is None:
            raise ValueError("There is no recorded reconciliation to start; record one with misaka_research_reconcile first.")
        con.execute("UPDATE research_reconciles SET approved_call_id=tool_call_id WHERE run_id=? AND round=?",
                    (run["id"], int(round)))
    return reconcile(con, run["id"], round)


def reconcile_approved(con, run_id, round):
    current = reconcile(con, run_id, round)
    return bool(current and current["approved_call_id"] == current["tool_call_id"])


def apply_reconcile(con, run, round, resolved, *, considered):
    """Open what a reconciliation decided, in one transaction: its nodes and their edges, the
    outcome of every option it answered, its relations, and the receipt. Returns the receipt; a
    reconciliation already applied is returned as it was, never applied twice."""
    with task_store.write_txn(con):
        _owned_run(con, run)
        current = reconcile(con, run["id"], round)
        if current is None:
            raise ValueError(f"Reconciliation {round} was never recorded.")
        if current["applied_at"] is not None:
            return current["receipt"]
        opened = {"nodes": [], "joins": []}
        for item in resolved["nodes"]:
            child = create_node(con, run["id"], question=item["question"], parents=item["parents"])
            for option_id in item["options"]:
                set_option(con, option_id, node_id=child["id"])
            opened["nodes"].append(child["id"])
        for item in resolved["joins"]:
            opened["joins"].append(create_node(con, run["id"], question=item["question"], parents=item["parents"])["id"])
        for item in resolved["not_pursued"]:
            set_option(con, item["option"], reason=item["reason"])
        now = int(time.time())
        for position, item in enumerate(resolved["relations"]):
            _add_relation(con, _derived_id("rel_", run["id"], round, position), run["id"], item["kind"], item["note"],
                          item["nodes"], now)
        receipt = {"considered": list(considered), **opened}
        con.execute("UPDATE research_reconciles SET receipt_json=?,applied_at=? WHERE run_id=? AND round=?",
                    (json.dumps(receipt), now, run["id"], int(round)))
    return receipt


def action(con, run_id, node_id, key):
    row = con.execute(
        "SELECT * FROM research_actions WHERE run_id=? AND branch_id=? AND action_key=?",
        (run_id, node_id, key),
    ).fetchone()
    return {**dict(row), "payload": json.loads(row["payload_json"])} if row else None


def check_owner(con, run, branch=None, *, allow_stop=False):
    """Identity is independent of phase: closing/final review and cleanup retain an owner."""
    current = get(con, run["id"])
    owner = node(con, branch["id"]) if branch is not None else None
    if (not current or current["driver_lock"] != run["driver_lock"]
            or (branch is not None and (not owner or owner["run_id"] != run["id"]
                                        or owner["runner_key"] != branch["runner_key"]))):
        raise ValueError("Research execution belongs to a superseded owner.")
    if not allow_stop and current["stop_requested"]:
        raise InterruptedError("Research stopped.")


@contextmanager
def owned_txn(con, run, branch=None, *, allow_stop=False, card_ids=(), field_updates=None, targets=None):
    """Check the captured identity under the same writer lock as its state transition."""
    with task_store.write_txn(con, card_ids=card_ids, field_updates=field_updates, targets=targets):
        check_owner(con, run, branch, allow_stop=allow_stop)
        yield


def _owned(con, run, branch):
    check_owner(con, run, branch, allow_stop=True)
    current, owner = get(con, run["id"]), node(con, branch["id"])
    if current["stop_requested"] or current["status"] != "active" or owner["status"] in NODE_TERMINAL:
        raise ValueError("Research command belongs to a stopped or superseded node.")


def record_action(con, run, branch, key, payload, *, session_file, tool_call_id):
    """Accept one LO command, not prose inferred by the driver. Replays are idempotent."""
    with task_store.write_txn(con):
        _owned(con, run, branch)
        prior = action(con, run["id"], branch["id"], key)
        if prior:
            if prior["payload"] != payload:
                raise ValueError("This research command was already accepted with different arguments.")
            return prior
        con.execute(
            "INSERT INTO research_actions VALUES (?,?,?,?,?,?,?)",
            (run["id"], branch["id"], key, json.dumps(payload, ensure_ascii=False),
             session_file and home.stored(session_file), tool_call_id, int(time.time())),
        )
    return action(con, run["id"], branch["id"], key)


def replace_action(con, run, branch, key, payload, *, session_file, tool_call_id):
    """Accept a command that supersedes the earlier one of its key: a plan revised while it waits
    for the user, or a fresh start after such a revision. Same ownership rule as record_action."""
    with task_store.write_txn(con):
        _owned(con, run, branch)
        con.execute("DELETE FROM research_actions WHERE run_id=? AND branch_id=? AND action_key=?",
                    (run["id"], branch["id"], key))
        con.execute(
            "INSERT INTO research_actions VALUES (?,?,?,?,?,?,?)",
            (run["id"], branch["id"], key, json.dumps(payload, ensure_ascii=False),
             session_file and home.stored(session_file), tool_call_id, int(time.time())),
        )
    return action(con, run["id"], branch["id"], key)


SKIP_KEY = "skip"
DECIDE_KEY = "decide"
# The user's decision on a dissolution of the research question, recorded on the root node.
CONSENT_KEY = "consent:dissolution"


def cards_failed_key(cards):
    """The action key of a node Last Order's decision on ``cards`` that failed for good: the same
    failure is decided once, a card that fails again after a retry is a new decision."""
    return "cards_failed:" + ",".join(f"{card['id']}@{card['generation']}" for card in cards)


def plan_change_key(round):
    """The action-key prefix of the changes Last Order made to a round's cards while they ran."""
    return f"cards:{int(round)}"


def plan_changes(con, run_id, node_id, round):
    """The changes Last Order made to a round's cards while they ran, oldest first."""
    return [json.loads(row["payload_json"]) for row in con.execute(
        "SELECT payload_json FROM research_actions WHERE run_id=? AND branch_id=? AND action_key LIKE ? "
        "ORDER BY created_at,rowid", (run_id, node_id, plan_change_key(round) + ":%"))]


def failed_card_decisions(con, run_id, node_id=None):
    """What node Last Orders decided about cards that failed for good, oldest first: each names
    its ``decision`` and the ``cards`` it covers."""
    return [json.loads(row["payload_json"]) for row in con.execute(
        "SELECT payload_json FROM research_actions WHERE run_id=? AND (? IS NULL OR branch_id=?) "
        "AND action_key LIKE 'cards_failed:%' ORDER BY created_at,rowid", (run_id, node_id, node_id))]


def given_up_cards(con, run_id, node_id=None):
    """Cards a node's Last Order went on without: never reopened, never driven again."""
    return {card for decision in failed_card_decisions(con, run_id, node_id) if decision["decision"] == "conclude"
            for card in decision["cards"]}


def skipped(con, run_id, node_id):
    """The user's decision, recorded by the node's Last Order, to close this node unresearched."""
    return action(con, run_id, node_id, SKIP_KEY)


def delete_action(con, run_id, node_id, key):
    con.execute("DELETE FROM research_actions WHERE run_id=? AND branch_id=? AND action_key=?",
                (run_id, node_id, key))


def plan_key(round):
    """The action key of a round's plan: the first round is the bare ``plan``."""
    return "plan" if int(round) <= 1 else f"plan:{int(round)}"


def start_key(round):
    return "start" if int(round) <= 1 else f"start:{int(round)}"


def dispose_key(round):
    """The action key of Last Order's dispositions for review round ``round``."""
    return f"dispose:{int(round)}"


def gaps_key(version):
    """The action key of Last Order's answer to the divergence review of version ``version``."""
    return f"gaps:{int(version)}"


def dissolve_key(version):
    """The action key saying that conclusion version ``version`` dissolves a question."""
    return f"dissolve:{int(version)}"


def record_run_action(con, run, key, payload, *, session_file, tool_call_id):
    """A run-level command of the root Last Order -- the user's consent to a dissolution, a part of
    the final report -- kept with the root node, whose question it answers. The root has finished its
    own work by then, so ownership is the run's. A later call for the same key replaces the earlier."""
    with task_store.write_txn(con):
        _owned_run(con, run)
        node = root(con, run["id"])
        con.execute("DELETE FROM research_actions WHERE run_id=? AND branch_id=? AND action_key=?",
                    (run["id"], node["id"], key))
        con.execute("INSERT INTO research_actions VALUES (?,?,?,?,?,?,?)",
                    (run["id"], node["id"], key, json.dumps(payload, ensure_ascii=False),
                     home.stored(session_file), tool_call_id, int(time.time())))
    return action(con, run["id"], node["id"], key)


def plan_round(con, run_id, node_id):
    """The highest planning round this node has recorded a plan for; 0 before the first."""
    keys = [row[0] for row in con.execute(
        "SELECT action_key FROM research_actions WHERE run_id=? AND branch_id=? "
        "AND (action_key='plan' OR action_key LIKE 'plan:%')", (run_id, node_id))]
    rounds = [1 if key == "plan" else int(key.split(":", 1)[1]) for key in keys]
    return max(rounds) if rounds else 0


def current_plan(con, run_id, node_id):
    """``(round, plan action)`` for the node's latest round; ``(0, None)`` before the first."""
    round = plan_round(con, run_id, node_id)
    return (round, action(con, run_id, node_id, plan_key(round))) if round else (0, None)


def red_team(con, run_id, node_id):
    """The node's red team as its first plan named her (``{"assignee", "reason"}``), or None
    before a plan does: the same Sister reviews every version and runs the divergence review."""
    plan = action(con, run_id, node_id, plan_key(1)) or current_plan(con, run_id, node_id)[1]
    return (plan["payload"].get("red_team") if plan else None) or None


def plan_started(con, run_id, node_id):
    """True once Last Order has recorded the user's go-ahead for the plan as it stands now: a
    start names the plan it was given for, so a revision after it needs a new start, and each
    round has its own start."""
    round, plan = current_plan(con, run_id, node_id)
    start = action(con, run_id, node_id, start_key(round)) if round else None
    return bool(plan and start and start["payload"].get("plan_tool_call_id") == plan["tool_call_id"])


def reframe(con, run_id, node, question):
    """The user agreed to Last Order's reframed question: the root's is the run's question too."""
    question = " ".join(str(question or "").split())
    if not question:
        return
    with task_store.write_txn(con):
        con.execute("UPDATE research_branches SET question=?,updated_at=? WHERE id=?",
                    (question, int(time.time()), node["id"]))
        if is_root(node):
            con.execute("UPDATE research_runs SET question=?,updated_at=? WHERE id=?",
                        (question, int(time.time()), run_id))


# --- artifacts -------------------------------------------------------------------------

def write_text(con, run_id, kind, title, relative_path, content, *,
               branch_id=None, task_id=None, metadata=None):
    run = get(con, run_id)
    if not run:
        raise ValueError(f"Research run not found: {run_id}")
    root = Path(run["workspace"]).resolve()
    path = (root / relative_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError("Research artifact path is outside the project workspace.") from error
    from misaka.core.research import publication

    content = str(content)
    sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
    # Recover a previous process before entering our own transaction. An in-flight
    # journal of this connection belongs to its outer transaction, not a dead writer.
    if not con.in_transaction:
        publication.recover(con, path)
    try:
        with task_store.write_txn(con):
            old = con.execute(
                "SELECT id FROM research_artifacts WHERE run_id=? AND path=? AND task_id IS ?",
                (run_id, str(path), task_id),
            ).fetchone()
            aid = old["id"] if old else "a_" + secrets.token_hex(5)
            # Register before touching files: an unmanaged outer raw-SQL transaction
            # has no completion hook; its caller should use task_store.write_txn.
            task_store.on_transaction_end(con, lambda: publication.recover(con, path))
            checkpoint = publication.prepare(con, path, aid, sha)
            # Savepoint also restores metadata if a caller catches our I/O error in
            # a larger transaction and decides to commit its other work.
            try:
                with _savepoint(con):
                    if old:
                        con.execute(
                            "UPDATE research_artifacts SET sha256=?,title=?,kind=?,metadata_json=?,created_at=? WHERE id=?",
                            (sha, str(title), str(kind), json.dumps(metadata or {}, ensure_ascii=False), int(time.time()), aid))
                    else:
                        con.execute(
                            "INSERT INTO research_artifacts "
                            "(id,run_id,branch_id,task_id,kind,title,path,sha256,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (aid, run_id, branch_id, task_id, str(kind), str(title), str(path), sha,
                             json.dumps(metadata or {}, ensure_ascii=False), int(time.time())))
                    _atomic_write(path, content)
            except BaseException:
                publication.restore_attempt(path, checkpoint)
                raise
    except BaseException:
        if not con.in_transaction:
            publication.recover(con, path)
        raise
    if not con.in_transaction:
        publication.recover(con, path)
    return aid, str(path)


def register_file(con, run_id, kind, title, path, *, sha256, branch_id=None, task_id=None, metadata=None):
    """Register a project file at its actual, permanent location without copying it."""
    run = get(con, run_id)
    path = str(Path(path).resolve())
    Path(path).relative_to(Path(run["workspace"]).resolve())
    old = con.execute(
        "SELECT id FROM research_artifacts WHERE run_id=? AND path=? AND task_id IS ?",
        (run_id, path, task_id),
    ).fetchone()
    if old:
        con.execute(
            "UPDATE research_artifacts SET sha256=?,title=?,kind=?,branch_id=?,metadata_json=?,created_at=? "
            "WHERE id=?",
            (sha256, str(title), str(kind), branch_id, json.dumps(metadata or {}, ensure_ascii=False),
             int(time.time()), old["id"]),
        )
        return old["id"], path
    aid = "a_" + secrets.token_hex(5)
    con.execute(
        "INSERT INTO research_artifacts "
        "(id,run_id,branch_id,task_id,kind,title,path,sha256,metadata_json,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (aid, run_id, branch_id, task_id, str(kind), str(title), path, sha256,
         json.dumps(metadata or {}, ensure_ascii=False), int(time.time())),
    )
    return aid, path


def artifact_text(row):
    """Read the registered project file, verifying its frozen digest."""
    data = Path(row["path"]).read_bytes()
    if hashlib.sha256(data).hexdigest() != row["sha256"]:
        raise ValueError(f"artifact {row['id']} changed since it was registered: {row['path']}")
    return data.decode("utf-8")


def frozen_refusal(target):
    """Why a file tool may not write ``target``, or None: a file the workflow wrote and froze for
    a run that is not over -- a node's plan, context and conclusions, the run's survey and report
    draft. A hand edit fails the integrity check of the phase that reads it next; a draft edited
    during its final review failed a whole run that way (B126). A card's deliverable is registered
    with its card and stays its Sister's to change, and a finished run's files are anyone's."""
    from misaka.config import CFG, home

    try:
        con = task_store.connect(os.path.expanduser(CFG["db"]))
    except (OSError, sqlite3.Error):
        return None
    try:
        # Compared as the file system compares names (home.fold): a case variant, or on macOS a
        # decomposed Unicode spelling, is the same file there and edited it past this check.
        wanted = home.fold(str(Path(target).resolve()))
        row = next((found for found in con.execute(
            "SELECT a.kind, a.run_id, a.path FROM research_artifacts a JOIN research_runs r ON r.id=a.run_id "
            "WHERE a.task_id IS NULL AND r.status!='done'") if home.fold(found["path"]) == wanted), None)
    except sqlite3.OperationalError:     # a board research has never touched has no such tables
        return None
    finally:
        con.close()
    if row is None:
        return None
    return (f"{target} is the {row['kind']} research run {row['run_id']} saved and froze: an edit here fails "
            "the integrity check of the phase that reads it next. What it should say goes through the phase "
            "that writes it -- a conclusion is revised in the node's next synthesis, the report draft in the "
            "final adjudication.")


def artifact_path(row):
    return row["path"]


def artifacts(con, run_id, *, branch_id=None, kind=None, task_id=None, run_level=False):
    """Registered files of the run: one node's (``branch_id``), the run's own products
    (``run_level``: question, clarifications, survey, draft, final, partial, workspace index),
    or all of them."""
    q, args = "SELECT * FROM research_artifacts WHERE run_id=?", [run_id]
    if branch_id is not None:
        q += " AND branch_id=?"
        args.append(branch_id)
    elif run_level:
        q += " AND branch_id IS NULL"
    if kind:
        q += " AND kind=?"
        args.append(kind)
    if task_id:
        q += " AND task_id=?"
        args.append(task_id)
    return con.execute(q + " ORDER BY created_at,rowid", args).fetchall()


def artifact(con, artifact_id):
    return con.execute("SELECT * FROM research_artifacts WHERE id=?", (artifact_id,)).fetchone()


def recover_publications(con, run):
    """Resume-only recovery; ordinary artifact/viewer reads never mutate the workspace."""
    from misaka.core.research import publication

    root = Path(run["workspace"])
    paths = {Path(row["path"]) for row in artifacts(con, run["id"])}
    # Include an interrupted first write whose registration rolled back completely.
    for branch in nodes(con, run["id"]):
        for journal in (root / node_dir(branch["id"])).glob(".*.research-publish.json"):
            paths.add(journal.with_name(journal.name[1:-len(".research-publish.json")]))
    sample = root / run_path(run, "checkpoint")
    for journal in sample.parent.glob(f".{run['id']}-*.research-publish.json"):
        paths.add(journal.with_name(journal.name[1:-len(".research-publish.json")]))
    for path in paths:
        path.resolve().relative_to(root.resolve())
        with owned_txn(con, run, allow_stop=True):
            publication.recover(con, path)


def read_artifact(con, artifact_id):
    row = artifact(con, artifact_id)
    if not row:
        return None
    try:
        return artifact_text(row)
    except OSError:
        return None


def summary(con, run_id):
    run = get(con, run_id)
    if not run:
        return None
    from misaka.core.research.delivery import snapshot as delivery_snapshot
    activity = con.execute("SELECT MAX(created_at) FROM events WHERE "
                           "(task_id=? OR task_id IN (SELECT task_id FROM research_run_tasks WHERE run_id=?)) "
                           "AND kind NOT IN ('heartbeat','lease_renewed','driver_heartbeat')", (run_id, run_id)).fetchone()[0]
    return {
        # Epoch milliseconds; unlike updated_at this never advances on a polling/lease refresh.
        "lastActivityAt": max(int(run['created_at']), int(activity or 0)) * 1000,
        "reportDelivery": delivery_snapshot(con, run_id),
        "id": run["id"], "workspace": run["workspace"], "phase": run["phase"],
        "status": run["status"], "wave": run["wave"], "limits": limits(run),
        "tasks": task_count(con, run_id), "nodes": len(nodes(con, run_id)),
        "undisposed_issues": con.execute("SELECT COUNT(*) FROM research_issues WHERE run_id=? "
                                         "AND disposition IS NULL", (run_id,)).fetchone()[0],
        "pending_options": len(pending_options(con, run_id)),
        "stop_requested": bool(run["stop_requested"]),
        "final_artifact": run["final_artifact"], "last_error": run["last_error"],
    }
