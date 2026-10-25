"""Release locally owned HTTPX resources when synchronous SDK setup fails."""

from __future__ import annotations

import asyncio
from typing import Any


def close_after_setup_failure(*resources: Any) -> None:
    """No requests have started; close sync pools now and async pools on their loop."""
    for resource in resources:
        close = getattr(resource, "aclose", None)
        if callable(close):
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                asyncio.run(close())
            else:
                loop.create_task(close())
        else:
            resource.close()
