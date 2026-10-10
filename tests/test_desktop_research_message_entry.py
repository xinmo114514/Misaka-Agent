import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from misaka.core.platform import tasks
from misaka.core.research import ingress as ingress_module
from misaka.core.research import runs
from misaka.core.research.ingress import ResearchMessageIngress
from misaka.core.research.wiring.research import ResearchPart
from misaka.desktop_research import runtime


@pytest.mark.asyncio
async def test_plain_message_reaches_research_ingress(monkeypatch):
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = SimpleNamespace(sessionId='session-1')
    controller.scope = SimpleNamespace(current_config=dict)
    controller.ingress = SimpleNamespace(send=AsyncMock(return_value={'accepted': True}))
    controller.intake_requests = set()
    monkeypatch.setattr(runtime, 'session_run', lambda *_: {'id': 'run-1'})
    result = await controller.send_message(
        {'sessionId': 'session-1', 'runId': 'run-1', 'requestId': 'input-1', 'text': '掌权30年吧'}, None)
    assert result == {'accepted': True}
    assert controller.ingress.send.await_args.args[0]['text'] == '掌权30年吧'


@pytest.mark.parametrize(('text', 'run_id', 'answer'), [
    (' /ReSeArCh ReSuMe  掌权30年吧， yes!  ', None, '掌权30年吧， yes!'),
    ('/research RESUME r_fixture   first-token  keeps   spaces?!', 'r_fixture',
     'first-token  keeps   spaces?!'),
])
def test_research_resume_parser_preserves_first_answer_token_and_punctuation(text, run_id, answer):
    assert ingress_module.parse_research_control(text) == {
        'action': 'resume', 'run_id': run_id, 'clarification': answer, 'here': False,
    }


@pytest.mark.parametrize(('text', 'expected'), [
    ('/RESEARCH STATUS', '/research status'),
    ('/Research ReSuMe r_fixture   第一个词  keep?!', '/research resume r_fixture   第一个词  keep?!'),
    ('/research help', '/research help'),
])
def test_command_normalization_only_folds_the_keyword_case(text, expected):
    assert ingress_module.normalize_research_command(text) == expected


@pytest.mark.parametrize('text', [
    'ordinary prose',
    '/research 关于 Stalin 的宪法',
    '/research',
    '/research   ',
    '/tree',
    None,
])
def test_prose_is_never_a_research_command(text):
    assert ingress_module.normalize_research_command(text) is None


def test_control_commands_are_rendered_in_one_place():
    assert ingress_module.render_research_command('stop', 'r_1') == '/research stop r_1'
    assert ingress_module.render_research_command('resume', 'r_1', '') == '/research resume r_1'
    assert ingress_module.render_research_command('resume', None, '第一个词') == '/research resume 第一个词'
    assert ingress_module.render_research_command('resume', 'r_1', 'a  b') == '/research resume r_1 a  b'


class _Control:
    def __init__(self):
        self.accepting = True
        self.catalog = SimpleNamespace(instance='fixture-instance')
        self.commands = []

    def _owns(self, _command):
        return True

    def _check_input_owner(self):
        return None

    async def _execute(self, command):
        self.commands.append(dict(command))


class _Manager:
    def __init__(self, workspace, session_file):
        self.workspace = str(workspace)
        self.sessionFile = str(session_file)
        self.entries = []
        self.flushed = True

    def getCwd(self):
        return self.workspace

    def getEntries(self):
        return list(self.entries)

    def appendCustomEntry(self, customType, data):
        entry_id = f'receipt-{len(self.entries)}'
        self.entries.append({'type': 'custom', 'customType': customType, 'data': data, 'id': entry_id})
        return entry_id


class _Session:
    def __init__(self, workspace, session_file):
        self.sessionId = 'root-session'
        self.sessionManager = _Manager(workspace, session_file)
        part = object.__new__(ResearchPart)
        part._drivers = {}
        part._resume_inputs = set()
        self.moments = SimpleNamespace(parts=[part])
        self.custom_messages = []

    async def sendCustomMessage(self, message, options):
        self.custom_messages.append((message, options))
        details = {**(message.get('details') or {})}
        if options.get('_deliveryId'):
            details['delivery_id'] = options['_deliveryId']
        self.sessionManager.entries.append({
            'type': 'custom_message', 'customType': message.get('customType'),
            'content': message.get('content'), 'details': details,
        })


@pytest.fixture
def waiting_root(tmp_path, monkeypatch):
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    root_file = workspace / 'root.jsonl'
    root_file.write_text('{}', encoding='utf-8')
    con = tasks.connect(str(tmp_path / 'board.db'))
    runs.init(con)
    run = runs.create(con, workspace=str(workspace), question='Fixture question')
    runs.set_state(con, run['id'], status='waiting_input', phase='waiting_input',
                   root_session=str(root_file))
    session = _Session(workspace, root_file)
    control = _Control()
    from misaka.core import session_control
    monkeypatch.setattr(session_control, 'for_session', lambda value: control if value is session else None)
    try:
        yield SimpleNamespace(con=con, run=runs.get(con, run['id']), session=session, control=control)
    finally:
        con.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('explicit', [False, True])
async def test_resume_with_or_without_id_targets_the_owned_root(waiting_root, explicit):
    case = waiting_root
    run_id = case.run['id']
    text = f'/Research ReSuMe {run_id} 第一个词，keep it!' if explicit else '/Research ReSuMe 第一个词，keep it!'
    ingress = ResearchMessageIngress(case.session)

    ack = await ingress.send({'sessionId': case.session.sessionId, 'requestId': f'resume-{explicit}',
                              'text': text}, case.con)

    assert ack['mode'] == 'resume' and ack['runId'] == run_id
    assert case.control.commands[-1]['text'] == f'/research resume {run_id} 第一个词，keep it!'
    assert case.session.custom_messages[-1][0]['content'] == '第一个词，keep it!'


@pytest.mark.asyncio
async def test_explicit_resume_id_must_match_owned_root(waiting_root):
    ingress = ResearchMessageIngress(waiting_root.session)
    with pytest.raises(ValueError, match='workspace and root session'):
        await ingress.send({'sessionId': waiting_root.session.sessionId, 'requestId': 'wrong-run',
                            'text': '/research resume r_not_this_run answer'}, waiting_root.con)
    assert waiting_root.control.commands == []


@pytest.mark.asyncio
async def test_empty_resume_is_control_only_not_a_blank_clarification(waiting_root):
    case = waiting_root
    ingress = ResearchMessageIngress(case.session)
    ack = await ingress.send({'sessionId': case.session.sessionId, 'requestId': 'control-resume',
                              'text': '/RESEARCH RESUME'}, case.con)

    assert ack['mode'] == 'resume' and ack['runId'] == case.run['id']
    assert case.control.commands[-1]['text'] == f"/research resume {case.run['id']}"
    assert case.session.custom_messages == []


@pytest.mark.asyncio
async def test_stop_uses_root_session_control_instead_of_board_connection(waiting_root):
    case = waiting_root
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = case.session
    controller.scope = SimpleNamespace(current_config=dict)
    controller.ingress = ResearchMessageIngress(case.session)
    controller.intake_requests = set()

    ack = await controller.send_message({
        'sessionId': case.session.sessionId, 'runId': case.run['id'],
        'requestId': 'stop-waiting', 'text': '/Research STOP',
    }, case.con)

    assert ack['mode'] == 'stop' and ack['runId'] == case.run['id']
    assert case.control.commands[-1]['text'] == f"/research stop {case.run['id']}"
    assert runs.get(case.con, case.run['id'])['status'] == 'waiting_input'


@pytest.mark.asyncio
@pytest.mark.parametrize('text', ['/StOp', '/stop {run_id}'])
async def test_stop_alias_reaches_the_same_owned_runtime_control(waiting_root, text):
    case = waiting_root
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = case.session
    controller.scope = SimpleNamespace(current_config=dict)
    controller.ingress = ResearchMessageIngress(case.session)
    controller.intake_requests = set()
    ack = await controller.send_message({'sessionId': case.session.sessionId,
        'requestId': 'stop-alias', 'text': text.format(run_id=case.run['id'])}, case.con)
    assert ack['mode'] == 'stop' and ack['runId'] == case.run['id']
    assert case.control.commands[-1]['text'] == f"/research stop {case.run['id']}"


@pytest.mark.asyncio
@pytest.mark.parametrize('changed', [
    {'startNew': True},
    {'limits': {'max_depth': 0}},
    {'limits': {'max_depth': 0}, 'startNew': False},
])
async def test_rejected_start_receipt_rejects_omitted_limits_or_changed_lifecycle(waiting_root, changed):
    from misaka.core.research import submissions
    case = waiting_root
    runs.set_state(case.con, case.run['id'], status='stopped')
    original = {'sessionId': case.session.sessionId, 'requestId': 'immutable-start',
                'text': 'Original question', 'limits': {'max_depth': 0}, 'startNew': True}
    submissions.record(case.session, original['requestId'], 'rejected',
        textHash=submissions.text_fingerprint(original['text']), initialRunId=None, runId=None,
        mode='start', controlAction=None, limits=original['limits'], input=original)
    retry = {'sessionId': case.session.sessionId, 'requestId': original['requestId'],
             'text': original['text'], **changed}
    with pytest.raises(submissions.ResearchInputError) as caught:
        await ResearchMessageIngress(case.session).send(retry, case.con)
    assert caught.value.errorCode == 'RESEARCH_REQUEST_CONFLICT'
    assert case.control.commands == []


@pytest.mark.asyncio
async def test_fresh_start_replay_returns_its_receipt_after_the_run_has_been_created(waiting_root):
    from misaka.core.research import submissions
    case = waiting_root
    original = {'sessionId': case.session.sessionId, 'requestId': 'started-once',
                'text': 'Original question', 'limits': {'max_depth': 0}, 'startNew': True}
    ack = {'accepted': True, 'sessionId': case.session.sessionId, 'requestId': original['requestId'],
           'runId': None, 'mode': 'start'}
    submissions.record(case.session, original['requestId'], 'applied',
        textHash=submissions.text_fingerprint(original['text']), initialRunId=None, runId=case.run['id'],
        mode='start', controlAction=None, limits=original['limits'], input=original, ack=ack)
    replay = await ResearchMessageIngress(case.session).send(original, case.con)
    assert replay == {**ack, 'runId': case.run['id']}
    assert case.control.commands == []


@pytest.mark.asyncio
async def test_duplicate_clarification_request_is_durable_across_ingress_recreation(waiting_root):
    case = waiting_root
    payload = {'sessionId': case.session.sessionId, 'runId': case.run['id'],
               'requestId': 'same-answer', 'text': '保留第一个词'}
    first = await ResearchMessageIngress(case.session).send(dict(payload), case.con)
    replay = await ResearchMessageIngress(case.session).send(dict(payload), case.con)

    assert replay == first
    assert len(case.control.commands) == 1
    assert len(case.session.custom_messages) == 1


async def test_accepted_resume_records_control_application_not_a_permanent_queue(waiting_root):
    from misaka.core.research import submissions
    case = waiting_root
    await ResearchMessageIngress(case.session).send({
        'sessionId': case.session.sessionId, 'runId': case.run['id'],
        'requestId': 'completed-control', 'text': '补充原始研究要求'}, case.con)
    assert submissions.lookup(case.session, 'completed-control')['state'] == 'applied'


@pytest.mark.asyncio
async def test_duplicate_start_request_does_not_launch_a_second_run_after_reopen(waiting_root):
    case = waiting_root
    case.session.sessionManager.entries.append({
        'type': 'custom_message', 'customType': 'research-question',
        'content': 'Research question | Original question',
        'details': {'question': 'Original question', 'requestId': 'start-once'},
    })

    ack = await ResearchMessageIngress(case.session).send({
        'sessionId': case.session.sessionId, 'requestId': 'start-once',
        'text': 'Original question',
    }, case.con)

    assert ack['mode'] == 'start' and ack['runId'] is None
    assert case.control.commands == []


@pytest.mark.asyncio
async def test_a_used_request_id_with_different_text_is_a_permanent_conflict(waiting_root):
    """The transcript already recorded another input: the desktop must not offer a resend."""
    from misaka.core.research import submissions
    case = waiting_root
    case.session.sessionManager.entries.append({
        'type': 'custom_message', 'customType': 'research-question',
        'content': 'Research question | 原始问题',
        'details': {'question': '原始问题', 'requestId': 'start-once'},
    })

    with pytest.raises(submissions.ResearchInputError) as caught:
        await ResearchMessageIngress(case.session).send({
            'sessionId': case.session.sessionId, 'requestId': 'start-once',
            'text': '改写后的另一个问题'}, case.con)

    assert caught.value.errorCode == 'RESEARCH_REQUEST_CONFLICT'
    assert caught.value.retryable is False
    assert case.control.commands == []


def test_control_parser_does_not_turn_a_research_question_into_resume():
    assert ingress_module.parse_research_control('/research stop studying state capacity') is None


@pytest.mark.asyncio
async def test_recorded_clarification_retries_failed_control_without_duplicate_input(waiting_root):
    case = waiting_root
    original = case.control._execute
    failures = 1

    async def execute(command):
        nonlocal failures
        if failures:
            failures -= 1
            raise ValueError('preflight rejected')
        return await original(command)

    case.control._execute = execute
    payload = {'sessionId': case.session.sessionId, 'runId': case.run['id'],
               'requestId': 'failed-clarification', 'text': '第一段\n\n1. 保留档案\n2. 核对证据'}
    with pytest.raises(ValueError, match='preflight rejected'):
        await ResearchMessageIngress(case.session).send(dict(payload), case.con)
    replay = await ResearchMessageIngress(case.session).send(dict(payload), case.con)
    assert replay['accepted'] is True
    assert len(case.control.commands) == 1
    assert len(case.session.custom_messages) == 1


@pytest.mark.asyncio
async def test_duplicate_start_allows_the_run_created_by_its_request(waiting_root):
    case = waiting_root
    case.session.sessionManager.entries.append({
        'type': 'custom_message', 'customType': 'research-question',
        'content': 'Research question | 原始问题',
        'details': {'question': '原始问题', 'requestId': 'original-start'},
    })
    ack = await ResearchMessageIngress(case.session).send({
        'sessionId': case.session.sessionId, 'requestId': 'original-start',
        'runId': case.run['id'], 'text': '原始问题',
    }, case.con)
    assert ack['accepted'] is True and ack['mode'] == 'start'
    assert case.control.commands == []


@pytest.mark.asyncio
async def test_done_followup_is_not_redelivered_after_ingress_recreation(waiting_root):
    case = waiting_root
    runs.set_state(case.con, case.run['id'], status='done')
    payload = {'sessionId': case.session.sessionId, 'runId': case.run['id'],
               'requestId': 'done-followup', 'text': '补充证据'}
    first = await ResearchMessageIngress(case.session).send(dict(payload), case.con)
    second = await ResearchMessageIngress(case.session).send(dict(payload), case.con)
    assert first == second
    assert len(case.control.commands) == 1
    assert case.control.commands[0]['streamingBehavior'] == 'followUp'


@pytest.mark.asyncio
@pytest.mark.parametrize('value, code', [(None, 'RESEARCH_TEXT_TYPE'), ('  ', 'RESEARCH_TEXT_EMPTY'),
                                       ('/tree', 'RESEARCH_CONTROL_REQUIRED')])
async def test_research_input_error_identifies_the_actual_validation_branch(monkeypatch, value, code):
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = SimpleNamespace(sessionId='session-1')
    with pytest.raises(ValueError) as error:
        await controller.send_message({'sessionId': 'session-1', 'text': value, 'requestId': 'diagnostic'}, None)
    assert error.value.errorCode == code
    assert error.value.errorStage == 'validation'


@pytest.mark.asyncio
@pytest.mark.parametrize('text', ['简短中文', '## 研究问题\n\n1. 档案\n2. 证据', '中文段落\n' * 10000,
                                  "Study Stalin's constitution.\n\n1. Sources\n2. Critique"],
                         ids=['chinese', 'markdown', 'long-chinese', 'english'])
async def test_text_format_is_preserved_by_the_controller(monkeypatch, text):
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = SimpleNamespace(sessionId='session-1')
    controller.scope = SimpleNamespace(current_config=dict)
    controller.ingress = SimpleNamespace(send=AsyncMock(return_value={'accepted': True}))
    controller.intake_requests = set()
    monkeypatch.setattr(runtime, 'session_run', lambda *_: {'id': 'run-1'})
    await controller.send_message({'sessionId': 'session-1', 'runId': 'run-1', 'text': text,
                                   'requestId': 'format-check'}, None)
    assert controller.ingress.send.await_args.args[0]['text'] == text.strip()


async def test_recruitment_retry_continues_without_repeating_original_intent(monkeypatch, tmp_path):
    from misaka.core import session_control
    session = _Session(tmp_path, tmp_path / 'root.jsonl')
    session.waitForIdle = AsyncMock()
    members = []
    calls = []
    original = session.sendCustomMessage

    async def deliver(message, options):
        calls.append(message['customType'])
        recorded = any((entry.get('details') or {}).get('delivery_id') == options['_deliveryId']
                       for entry in session.sessionManager.entries)
        if recorded:
            return
        await original(message, options)
        if message['customType'] == 'desktop-intake':
            raise ValueError('provider rejected intake')
        members.append({'name': 'archivist'})

    session.sendCustomMessage = deliver
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = session
    controller.scope = SimpleNamespace(current_config=dict)
    controller.ingress = SimpleNamespace(starting=False, send=AsyncMock(return_value={'accepted': True}))
    controller.intake_requests = set()
    controller.scene = SimpleNamespace(intake=False)
    controller.team = SimpleNamespace(snapshot=lambda: {'team': {'members': members}})
    monkeypatch.setattr(runtime, 'session_run', lambda *_: None)
    monkeypatch.setattr(session_control, 'for_session', lambda _: _Control())
    payload = {'sessionId': session.sessionId, 'requestId': 'intake-retry', 'text': '原始研究问题'}
    with pytest.raises(ValueError, match='provider rejected intake'):
        await controller.send_message(dict(payload), None)
    result = await controller.send_message(dict(payload), None)
    assert result['accepted'] is True
    assert calls == ['desktop-intake', 'desktop-intake-resume']
    assert len([entry for entry in session.sessionManager.entries
                if entry.get('customType') == 'desktop-intake']) == 1
