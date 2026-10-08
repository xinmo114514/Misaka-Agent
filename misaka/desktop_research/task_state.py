"""Read-only desktop team projection from the owning native research board.

Definitions/retention stay in the team file. Work facts stay in native task rows;
this projection never stamps invented task completion into a role definition.
"""
from __future__ import annotations

import sqlite3
from copy import deepcopy
from pathlib import Path

from misaka.core.research.ingress import session_run


def _member_status(statuses):
    if any(status in {'running', 'review'} for status in statuses):
        return 'running'
    if any(status in {'failed', 'error'} for status in statuses):
        return 'failed'
    if any(status in {'blocked', 'triage', 'parked'} for status in statuses):
        return 'waiting'
    if any(status in {'ready', 'todo', 'queued'} for status in statuses):
        return 'ready'
    if all(status in {'done', 'closed'} for status in statuses):
        return 'done'
    if all(status in {'cancelled', 'canceled', 'skipped', 'stopped'} for status in statuses):
        return 'stopped'
    return statuses[-1]


def project_controller_snapshot(controller):
    snapshot = deepcopy(controller.team.snapshot())
    con = getattr(controller, '_research_con', None)
    opened = False
    if con is None:
        database = getattr(controller, 'config', {}).get('db')
        if not database:
            return snapshot
        path = Path(database).expanduser().resolve()
        if not path.is_file():
            return snapshot
        con = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        con.row_factory = sqlite3.Row
        opened = True
    try:
        run = session_run(controller.session, con)
        if run is None:
            return snapshot
        rows = con.execute('SELECT t.* FROM tasks AS t JOIN research_run_tasks AS linked '
                           'ON linked.task_id=t.id WHERE linked.run_id=? ORDER BY t.created_at,t.id',
                           (run['id'],)).fetchall()
        for member in snapshot['team']['members']:
            assigned = [row for row in rows if row['assignee'] == member['name']]
            if not assigned:
                continue
            member['taskIds'] = list(dict.fromkeys([*member.get('taskIds', []), *(row['id'] for row in assigned)]))
            instances = [row['agent_id'] or row['session_file'] for row in assigned
                         if row['agent_id'] or row['session_file']]
            member['instances'] = list(dict.fromkeys([*member.get('instances', []), *instances]))
            statuses = [row['status'] for row in assigned]
            if member.get('status') == 'running':
                statuses.append('running')
            member['status'] = _member_status(statuses)
        return snapshot
    except sqlite3.Error as error:
        # Startup may precede board schema publication. Preserve definitions and
        # explicitly diagnose unknown work facts instead of writing fake states.
        snapshot['team']['taskProjectionError'] = str(error)
        return snapshot
    finally:
        if opened:
            con.close()
