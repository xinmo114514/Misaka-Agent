"""Task-local desktop roster and explicit, non-overwriting retention."""
import hashlib
import json
import re
import shutil
import uuid
from copy import deepcopy
from pathlib import Path

from filelock import FileLock

from misaka.core.network import roster

from .model_policy import DesktopTeamModelPolicy, atomic_json

_CREDENTIAL_NAME_PATTERN = (
    r'(?:api[\s_.-]*key|(?:access|refresh|auth|session|id)[\s_.-]*token|'
    r'client[\s_.-]*secret|(?:(?:aws|azure|google|gcp)[\s_.-]*)?'
    r'(?:secret[\s_.-]*)?access[\s_.-]*key(?:[\s_.-]*id)?|'
    r'private[\s_.-]*key|secret[\s_.-]*key|password|passwd|pwd)'
)
_CREDENTIAL_NAME = re.compile(_CREDENTIAL_NAME_PATTERN, re.IGNORECASE)
_CREDENTIAL_LINE = re.compile(
    r'^.*(?:' + _CREDENTIAL_NAME_PATTERN + r'''["']?\s*[:=]|authorization\s*:|bearer\s+|'''
    r'[a-z][a-z0-9+.-]*://[^\s/]*@).*$', re.IGNORECASE | re.MULTILINE,
)


def role_name(name):
    reserved = {'last-order', 'last_order', 'con', 'prn', 'aux', 'nul',
                *(f'com{i}' for i in range(1, 10)), *(f'lpt{i}' for i in range(1, 10))}
    if (not isinstance(name, str) or not re.fullmatch(r'[\w][\w.-]*', name)
            or name.endswith('.') or name.split('.')[0].casefold() in reserved):
        raise ValueError('Invalid role name')
    return name


def references(values, label):
    if values is None:
        return []
    if not isinstance(values, (list, tuple, set)) or any(
            not isinstance(v, str) or not v.strip() or '\n' in v or '\x00' in v for v in values):
        raise ValueError(f'{label} must be string references')
    return sorted(set(values))


def skill_references(values, goal):
    """Skill exports are identifiers, never free-form task or credential text."""
    skills = references(values, 'Skills')
    for skill in skills:
        if (not re.fullmatch(r'(?:[A-Za-z0-9_][A-Za-z0-9_.-]*:)?[A-Za-z0-9_][A-Za-z0-9_.-]*', skill)
                or (goal and goal.casefold() in skill.casefold())
                or _CREDENTIAL_NAME.search(skill)):
            raise ValueError('Skills must be native identifiers without task goals or credential text')
    return skills


def create_owned_sister(name, root, responsibility):
    """Clean native IO failures, but never remove an existing or raced profile."""
    profile = root / name
    if profile.exists() or profile.is_symlink() or any(
            p.name.casefold() == name.casefold() for p in root.iterdir()):
        raise ValueError('Profile already exists')
    try:
        ok, message = roster.create_sister(name, root=str(root), specialty=responsibility)
    except FileExistsError:
        # The native mkdir observed a concurrent owner; those files are not ours.
        raise
    except Exception:
        if profile.is_dir() and not profile.is_symlink():
            shutil.rmtree(profile)
        raise
    if not ok:
        # Native validation/conflict failures return before creating any files.
        raise ValueError(message)
    return profile


class DesktopResearchTeam:
    def __init__(self, session_dir, shared_root, provider, model_id, *, team_id=None, allowed_tools=None):
        self.directory = Path(session_dir).resolve() / 'desktop-team'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.shared_root = Path(shared_root).expanduser().resolve()
        self.profile_root = self.directory / 'profiles'
        self.profile_root.mkdir(exist_ok=True)
        self.path = self.directory / 'team.json'
        self.lock = FileLock(str(self.path) + '.lock', timeout=30)
        self.allowed_tools = None if allowed_tools is None else set(allowed_tools)
        with self.lock:
            if not self.path.exists():
                self._write({'teamId': team_id or uuid.uuid4().hex, 'scene': 'desktop_research',
                             'members': [], 'retentionReceipts': {}})
            elif team_id and self._read()['teamId'] != team_id:
                raise ValueError('Session already belongs to another team')
        self.model_policy = DesktopTeamModelPolicy(self.directory / 'model-policy.json', provider, model_id)

    def _read(self):
        return json.loads(self.path.read_text(encoding='utf-8'))

    def _write(self, state):
        atomic_json(self.path, state)

    def _pin(self, name, pair):
        atomic_json(self.profile_root / name / 'settings.json', {
            'defaultProvider': pair['provider'], 'defaultModel': pair['modelId']})

    def recruit(self, name, responsibility, goal, instructions, tools=None, skills=None, source_id=None):
        name = role_name(name)
        for value in (responsibility, goal, instructions):
            if not isinstance(value, str) or not value.strip():
                raise ValueError('Role responsibility, goal and instructions are required')
        tools, skills = references(tools, 'Tools'), skill_references(skills, goal)
        if self.allowed_tools is not None and not set(tools).issubset(self.allowed_tools):
            raise ValueError('Role tools exceed caller capabilities')
        source_id = role_name(source_id) if source_id is not None else None
        content = {'name': name, 'responsibility': responsibility, 'goal': goal, 'instructions': instructions,
                   'tools': tools, 'skills': skills, 'kind': 'borrowed_sister' if source_id else 'task_agent'}
        if source_id:
            content['sourceId'] = source_id
        with self.lock:
            state = self._read()
            existing = next((m for m in state['members'] if m['name'].casefold() == name.casefold()), None)
            if existing:
                if any(existing.get(k) != v for k, v in content.items()):
                    raise ValueError('Role name already has different content')
                return deepcopy(existing)
            pair = self.model_policy.guard_model()
            source = self.shared_root / source_id if source_id else None
            if source is not None and (not source.is_dir() or source.is_symlink()):
                raise ValueError('Source Sister does not exist or is linked')
            local = create_owned_sister(name, self.profile_root, responsibility)
            try:
                if source:
                    for filename in ('SOUL.md', 'DESCRIBE.md'):
                        candidate = source / filename
                        if candidate.is_file() and not candidate.is_symlink():
                            shutil.copyfile(candidate, local / filename)
                    source_skills = source / 'skills'
                    if source_skills.is_dir() and not source_skills.is_symlink():
                        for candidate in source_skills.rglob('*'):
                            if candidate.is_file() and not candidate.is_symlink() and not any(
                                    p.is_symlink() for p in candidate.parents if p != source):
                                target = local / 'skills' / candidate.relative_to(source_skills)
                                target.parent.mkdir(parents=True, exist_ok=True)
                                shutil.copyfile(candidate, target)
                self._pin(name, pair)
                (local / 'TASK.md').write_text(f'# Responsibility\n{responsibility}\n\n# Goal\n{goal}\n\n'
                                               f'# Instructions\n{instructions}\n', encoding='utf-8')
                member = {**content, 'id': uuid.uuid4().hex, 'status': 'ready',
                          'taskIds': [], 'instances': [], 'effectiveModel': pair}
                state['members'].append(member)
                self._write(state)
                return deepcopy(member)
            except Exception:
                shutil.rmtree(local)
                raise

    def update_member(self, member_id, **fields):
        allowed = {'status', 'taskIds', 'instances', 'effectiveModel'}
        if set(fields) - allowed:
            raise ValueError('Unsupported member update')
        with self.lock:
            state = self._read()
            member = next((m for m in state['members'] if m['id'] == member_id), None)
            if member is None:
                raise ValueError('Unknown member')
            member.update(deepcopy(fields))
            self._write(state)
            return deepcopy(member)

    def snapshot(self):
        with self.lock:
            state = self._read()
        binding = self.model_policy.snapshot()
        members = deepcopy(state['members'])
        for member in members:
            member['effectiveModel'] = {**binding['effective'], 'epoch': binding['epoch']}
        return {'team': {k: state[k] for k in ('teamId', 'scene')} | {'members': members},
                'modelBinding': binding}

    def pin_profiles(self, provider, model_id):
        """Refresh task-local files after commit, never alter a shared Sister pin."""
        with self.lock:
            binding = self.model_policy.guard_model()
            if (provider, model_id) != (binding['provider'], binding['modelId']):
                raise ValueError('Profile pins must match the committed team model')
            state = self._read()
            for member in state['members']:
                self._pin(member['name'], binding)
                member['effectiveModel'] = binding
            self._write(state)
        return binding

    @staticmethod
    def _retained_text(text, goal):
        # Known credential markers and explicit task text are excluded from export;
        # arbitrary unmarked secret prose is not semantically classified here.
        if goal and goal.split():
            goal_pattern = r'\s+'.join(re.escape(part) for part in goal.split())
            text = re.sub(goal_pattern, '', text, flags=re.IGNORECASE)
        text = re.sub(r'-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----.*?'
                      r'-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----',
                      '', text, flags=re.IGNORECASE | re.DOTALL)
        return _CREDENTIAL_LINE.sub('', text).strip()

    def retain_roles(self, selections, *, terminal, request_id):
        if terminal is not True:
            raise ValueError('Retention requires a terminal run')
        if not isinstance(request_id, str) or not request_id:
            raise ValueError('A retention request ID is required')
        if not isinstance(selections, list):
            raise TypeError('Selections must be a list')
        normalized = []
        for selection in selections:
            if not isinstance(selection, dict) or set(selection) != {'id', 'name'}:
                raise ValueError('Selections require only member id and editable name')
            normalized.append({'id': selection['id'], 'name': role_name(selection['name'])})
        fingerprint = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
        with self.lock:
            state = self._read()
            previous = state['retentionReceipts'].get(request_id)
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise ValueError('Retention request was reused with different selections')
                return deepcopy(previous['receipt'])
            if not normalized:
                receipt = {'requestId': request_id, 'retained': []}
                state['retentionReceipts'][request_id] = {'fingerprint': fingerprint, 'receipt': receipt}
                self._write(state)
                return deepcopy(receipt)
            # Validate all exportable content before touching the shared root.
            exports = {}
            for selection in normalized:
                member = next((m for m in state['members'] if m['id'] == selection['id']), None)
                if member is None or member['kind'] != 'task_agent' or member.get('retainedAs'):
                    raise ValueError('Only new unretained task roles can be retained')
                exports[member['id']] = {
                    'responsibility': self._retained_text(member['responsibility'], member['goal']),
                    'instructions': self._retained_text(member['instructions'], member['goal']),
                    'skills': skill_references(member['skills'], member['goal']),
                }
            self.shared_root.mkdir(parents=True, exist_ok=True)
            with FileLock(str(self.shared_root / '.desktop-retention.lock'), timeout=30):
                selected, seen_ids, seen_names = [], set(), set()
                existing_names = {p.name.casefold() for p in self.shared_root.iterdir()}
                for selection in normalized:
                    member = next((m for m in state['members'] if m['id'] == selection['id']), None)
                    name = selection['name']
                    if member is None or member['kind'] != 'task_agent' or member.get('retainedAs'):
                        raise ValueError('Only new unretained task roles can be retained')
                    if selection['id'] in seen_ids or name.casefold() in seen_names or name.casefold() in existing_names:
                        raise ValueError('Selected name conflicts with an existing profile or selection')
                    seen_ids.add(selection['id'])
                    seen_names.add(name.casefold())
                    selected.append((member, name))
                created = []
                try:
                    for member, name in selected:
                        exported = exports[member['id']]
                        responsibility, instructions = exported['responsibility'], exported['instructions']
                        profile = create_owned_sister(name, self.shared_root, responsibility)
                        created.append(profile)
                        (profile / 'SOUL.md').write_text(f'# {name}\n\n{instructions}\n', encoding='utf-8')
                        (profile / 'DESCRIBE.md').write_text(f'# {name}\n\n## Responsibilities\n{responsibility}\n\n'
                                                           '## Skill references\n' + '\n'.join(exported['skills']) + '\n',
                                                           encoding='utf-8')
                    receipt = {'requestId': request_id, 'retained': normalized}
                    for member, name in selected:
                        member['retainedAs'] = name
                    state['retentionReceipts'][request_id] = {'fingerprint': fingerprint, 'receipt': receipt}
                    self._write(state)
                    return deepcopy(receipt)
                except Exception:
                    for profile in created:
                        shutil.rmtree(profile)
                    raise
