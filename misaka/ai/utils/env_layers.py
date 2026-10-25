"""Merge scoped env layers without losing cross-case network overrides."""

from collections.abc import Mapping

_NETWORK_NAMES = ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir")


def merge_env_layers(*layers: Mapping[str, str] | None) -> dict[str, str]:
    """Later sources win, including empty values; lowercase wins within a source.

    Normalize each source *before* merging. Normalizing a flattened dictionary
    would let an earlier lowercase alias silently defeat a later uppercase one.
    Unrelated provider environment values are left untouched.
    """
    merged: dict[str, str] = {}
    for layer in layers:
        if layer is None:
            continue
        normalized = dict(layer)
        for name in _NETWORK_NAMES:
            if name in layer or name.upper() in layer:
                value = layer[name] if name in layer else layer[name.upper()]
                normalized[name] = normalized[name.upper()] = value
        merged.update(normalized)
    return merged
