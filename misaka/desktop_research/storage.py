"""Stable per-transcript desktop namespaces; native cwd buckets are not team IDs."""
from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from pathlib import Path

import psutil
from filelock import FileLock


def _has_live_executors(directory):
    path = directory / 'model-policy.json'
    if not path.exists():
        return False
    state = json.loads(path.read_text(encoding='utf-8'))
    for executor in state.get('executors', {}).values():
        try:
            process = psutil.Process(executor['pid'])
            if executor.get('birth') is None or process.create_time() == executor['birth']:
                return True
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            return True
    return False


def root_team_directory(manager, session_id):
    if (not isinstance(session_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', session_id)
            or session_id in {'.', '..'}):
        raise ValueError('Invalid desktop root session identity')
    transcript = getattr(manager, 'sessionFile', None)
    if not transcript:
        raise ValueError('A desktop research root requires a persisted transcript address')
    bucket = Path(transcript).expanduser().resolve().parent
    root = bucket / 'desktop-roots' / session_id
    root.mkdir(parents=True, exist_ok=True)
    with FileLock(str(root.parent / '.team-migration.lock'), timeout=30):
        destination = root / 'desktop-team'
        legacy = bucket / 'desktop-team'
        state_file = legacy / 'team.json'
        if not destination.exists() and state_file.is_file():
            previous = json.loads(state_file.read_text(encoding='utf-8'))
            if previous.get('teamId') == session_id:
                if _has_live_executors(legacy):
                    raise ValueError('The original desktop team still has live executors; reopen its owning process')
                temporary = root / ('.team-migration-' + uuid.uuid4().hex)
                try:
                    shutil.copytree(legacy, temporary)
                    os.replace(temporary, destination)
                finally:
                    # Checked root-local staging path, never the original team.
                    if temporary.exists() and temporary.resolve().parent == root.resolve():
                        shutil.rmtree(temporary)
    return root
