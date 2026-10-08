import asyncio
import json
import subprocess
import sys

import pytest

from misaka.desktop_research.model_policy import (
    DesktopTeamModelPolicy,
    ModelPolicyPaused,
)


def policy(tmp_path):
    return DesktopTeamModelPolicy(tmp_path / 'model-policy.json', 'a', 'same')


async def test_switch_drains_and_pauses_then_all_requests_use_exact_new_pair(tmp_path):
    first, second = policy(tmp_path), policy(tmp_path)
    staged = []

    async def prepare(provider, model_id, epoch):
        staged.append((provider, model_id, epoch))

    first.register_executor('worker', prepare)
    old = first.begin_request('worker')
    switch = asyncio.create_task(second.switch('b', 'org/same', timeout=2))
    await asyncio.sleep(.03)
    assert second.snapshot()['state'] == 'switching'
    with pytest.raises(ModelPolicyPaused):
        first.begin_request('worker')
    assert staged == []
    first.end_request(old)
    await first.synchronize_executor('worker')
    assert (await switch)['effective'] == {'provider': 'b', 'modelId': 'org/same'}
    async with first.request('worker') as binding:
        assert binding == {'provider': 'b', 'modelId': 'org/same', 'epoch': 1}
    assert staged == [('b', 'org/same', 1)]
    assert policy(tmp_path).guard_model() == {'provider': 'b', 'modelId': 'org/same', 'epoch': 1}


async def test_failed_prepare_keeps_old_model_paused_cancel_restores_consistency(tmp_path):
    p = policy(tmp_path)
    bound = []

    async def prepare(provider, model_id, epoch):
        bound.append(provider)
        if provider == 'b':
            raise ValueError('Invalid provider credentials')

    p.register_executor('worker', prepare)
    result = await p.switch('b', 'same', timeout=1)
    assert result['state'] == 'failed' and result['effective'] == {'provider': 'a', 'modelId': 'same'}
    with pytest.raises(ModelPolicyPaused):
        p.begin_request('worker')
    assert (await p.cancel_switch())['state'] == 'ready'
    assert p.begin_request('worker')['provider'] == 'a'
    assert bound == ['b', 'a']


async def test_timeout_is_paused_and_cancel_does_not_interrupt_old_request(tmp_path):
    p = policy(tmp_path)
    p.register_executor('worker')
    old = p.begin_request('worker')
    assert (await p.switch('b', 'same', timeout=.03))['state'] == 'failed'
    assert (await p.cancel_switch())['effective']['provider'] == 'a'
    p.end_request(old)
    assert p.begin_request('worker')['epoch'] == 0


def test_guard_rejects_stale_epoch_and_unregister_active_executor(tmp_path):
    p = policy(tmp_path)
    p.register_executor('worker')
    ticket = p.begin_request('worker')
    with pytest.raises(ValueError):
        p.unregister_executor('worker')
    with pytest.raises(ValueError):
        p.begin_request('worker', expected_epoch=5)
    p.end_request(ticket)
    p.unregister_executor('worker')
    with pytest.raises(ValueError):
        p.begin_request('worker')


WORKER_CODE = '''
import asyncio, json, sys
from pathlib import Path
from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
async def work():
    p = DesktopTeamModelPolicy(sys.argv[1], 'a', 'same')
    p.register_executor('remote')
    first = p.begin_request('remote')
    print(json.dumps(['before', first['provider'], first['epoch']]), flush=True)
    while not Path(sys.argv[2]).exists():
        await asyncio.sleep(.01)
    p.end_request(first)
    async with p.request('remote') as binding:
        print(json.dumps(['after', binding['provider'], binding['epoch']]), flush=True)
    p.unregister_executor('remote')
asyncio.run(work())
'''


def start_worker(p, release):
    script = release.parent / 'worker.py'
    script.write_text(WORKER_CODE, encoding='utf-8')
    command = [sys.executable, str(script), str(p.path), str(release)]
    try:
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
    except PermissionError as error:
        pytest.skip(f'Host denied creating the real subprocess: {error}')


async def test_real_process_obeys_staged_boundary_and_persisted_epoch(tmp_path):
    p = policy(tmp_path)
    release = tmp_path / 'release'
    child = start_worker(p, release)
    try:
        assert (await asyncio.wait_for(asyncio.to_thread(child.stdout.readline), 10)).strip() == '["before", "a", 0]'
        switch = asyncio.create_task(p.switch('b', 'same', timeout=5))
        await asyncio.sleep(.03)
        assert p.snapshot()['effective']['provider'] == 'a'
        release.touch()
        assert (await switch)['state'] == 'ready'
        assert (await asyncio.wait_for(asyncio.to_thread(child.stdout.readline), 10)).strip() == '["after", "b", 1]'
        assert await asyncio.to_thread(child.wait, 10) == 0
        assert policy(tmp_path).guard_model() == {'provider': 'b', 'modelId': 'same', 'epoch': 1}
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait()
        child.stdout.close()
        child.stderr.close()


async def test_dead_process_requests_are_reaped_before_next_switch(tmp_path):
    p = policy(tmp_path)
    child = start_worker(p, tmp_path / 'release')
    try:
        assert (await asyncio.wait_for(asyncio.to_thread(child.stdout.readline), 10)).strip() == '["before", "a", 0]'
        child.terminate()
        await asyncio.to_thread(child.wait, 10)
        assert (await p.switch('b', 'same', timeout=.2))['state'] == 'ready'
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait()
        child.stdout.close()
        child.stderr.close()


async def test_restart_can_cancel_failed_staged_boundary_without_mixed_requests(tmp_path):
    original = policy(tmp_path)
    original.register_executor('worker')
    old = original.begin_request('worker')
    assert (await original.switch('b', 'same', timeout=.01))['state'] == 'failed'
    restarted = policy(tmp_path)
    with pytest.raises(ModelPolicyPaused):
        restarted.guard_model()
    assert (await restarted.cancel_switch())['effective'] == {'provider': 'a', 'modelId': 'same'}
    original.end_request(old)
    assert original.begin_request('worker')['epoch'] == 0


async def test_cancellation_during_staged_prepare_restores_old_session(tmp_path):
    p = policy(tmp_path)
    preparing, release = asyncio.Event(), asyncio.Event()
    observed = []

    async def prepare(provider, model_id, epoch):
        if provider == 'b':
            preparing.set()
            await release.wait()
        observed.append(provider)

    p.register_executor('worker', prepare)
    switch = asyncio.create_task(p.switch('b', 'same', timeout=2))
    await preparing.wait()
    cancel = asyncio.create_task(p.cancel_switch(timeout=2))
    await asyncio.sleep(.02)
    release.set()
    await switch
    assert (await cancel)['state'] == 'ready'
    assert observed == ['b', 'a']
    assert p.begin_request('worker')['provider'] == 'a'


async def test_hung_prepare_obeys_switch_timeout_and_stays_paused(tmp_path):
    p = policy(tmp_path)

    async def prepare(provider, model_id, epoch):
        await asyncio.Event().wait()

    p.register_executor('worker', prepare)
    result = await asyncio.wait_for(p.switch('b', 'same', timeout=.03), .3)
    assert result['state'] == 'failed'
    assert result['effective']['provider'] == 'a'


async def test_subscribers_receive_persisted_switch_failure_cancel_and_unsubscribe(tmp_path):
    p = policy(tmp_path)
    events = []

    def changed(binding):
        # A UI notification describes the state already atomically persisted.
        persisted = json.loads(p.path.read_text())
        assert {k: persisted[k] for k in binding} == binding
        events.append(binding['state'])

    unsubscribe = p.subscribe(changed)

    async def prepare(provider, model_id, epoch):
        if provider == 'b':
            raise ValueError('Bad model')

    p.register_executor('worker', prepare)
    await p.switch('b', 'same')
    assert events == ['switching', 'failed']
    await p.cancel_switch()
    assert events == ['switching', 'failed', 'switching', 'ready']
    unsubscribe()
    await p.switch('c', 'same')
    assert events[-1] == 'ready'


async def test_failed_switch_retry_reprepares_every_executor_and_commits_one_epoch(tmp_path):
    p = policy(tmp_path)
    attempts = []
    fail = True

    async def prepared(provider, model_id, epoch):
        attempts.append(('prepared', provider, epoch))

    async def unreliable(provider, model_id, epoch):
        attempts.append(('unreliable', provider, epoch))
        if fail:
            raise ValueError('Temporary model failure')

    p.register_executor('first', prepared)
    p.register_executor('second', unreliable)
    assert (await p.switch('b', 'same'))['state'] == 'failed'
    assert p.snapshot()['effective'] == {'provider': 'a', 'modelId': 'same'}
    fail = False
    result = await p.switch('b', 'same')
    assert result['state'] == 'ready' and result['epoch'] == 1
    assert attempts == [('prepared', 'b', 1), ('unreliable', 'b', 1),
                        ('prepared', 'b', 1), ('unreliable', 'b', 1)]
    assert p.begin_request('first')['provider'] == 'b'
    assert p.begin_request('second')['provider'] == 'b'


async def test_timed_out_switch_retry_waits_old_request_then_commits_new_target(tmp_path):
    p = policy(tmp_path)
    p.register_executor('worker')
    old = p.begin_request('worker')
    assert (await p.switch('b', 'same', timeout=.01))['state'] == 'failed'
    retry = asyncio.create_task(p.switch('c', 'org/same', timeout=1))
    await asyncio.sleep(.02)
    with pytest.raises(ModelPolicyPaused):
        p.begin_request('worker')
    assert p.snapshot()['effective']['provider'] == 'a'
    p.end_request(old)
    assert (await retry)['effective'] == {'provider': 'c', 'modelId': 'org/same'}
