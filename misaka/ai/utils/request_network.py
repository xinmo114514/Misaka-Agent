"""Request-local network settings inherited by provider producer tasks."""

from contextlib import contextmanager
from contextvars import ContextVar

from misaka.ai.utils.network_route import httpx_client_options
from misaka.config.proxy_settings import proxy_request_env

_environment = ContextVar("misaka_request_network", default=None)


@contextmanager
def request_network(env=None):
    frozen = proxy_request_env(env)
    token = _environment.set(frozen)
    try:
        yield frozen
    finally:
        _environment.reset(token)


def proxy_httpx_options(endpoint, env=None):
    frozen = _environment.get()
    return httpx_client_options(endpoint, frozen if frozen is not None else proxy_request_env(env))
