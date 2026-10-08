"""MISAKA LCM: the project-scoped fork of hermes-lcm.

The upstream compression/retrieval implementation lives in vendor/ and native/;
MISAKA's project ownership, disposable storage and session provenance live in
host/. Upstream notices and pins remain intact. Namespaced imports at existing
host seams are the only relocation changes in the upstream Python sources.
"""
EXTENSION_NAME = "misaka_lcm"

SESSION_KINDS = {"foreground", "dm", "card", "beast", "child", "bare"}

COMMAND = "lcm"


def command(argv):
    """Inspect LCM and run explicit history/backfill operators.

    ``misaka lcm ...`` runs before any session exists or the project layout is created: a dry run
    or a read-only operator must not bootstrap directories or open an engine first."""
    from .host.operators import main
    return main(argv)


def register_native_auth(harn):
    """Keep native OAuth available to strict-model research without auxiliary calls."""
    from .host.nous import flow
    harn.registerProvider('nous', {'oauth': flow})


register_native_auth.extension_name = 'desktop-native-auth'


def activate(spec):
    import os

    from .host import storage
    from .host.extension import register
    # A subagent joins its parent session's project store, which the parent set on subagent_start.
    workspace = (os.environ.get(storage.PROJECT_ENV) if os.environ.get("MISAKA_SUBAGENT_ID") else None) or spec.workspace

    def register_for_session(harn):
        return register(harn, kind=spec.kind, workspace=workspace)

    register_for_session.desktop_research_factory = register_native_auth
    return register_for_session
