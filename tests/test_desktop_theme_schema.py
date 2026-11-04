"""Shared theme validation accepts the desktop overlay without relaxing TUI validation."""
import json
from pathlib import Path

import pytest

from misaka.modes.interactive.theme import theme_schema


def _theme():
    path = Path(theme_schema.__file__).with_name("dark.json")
    return json.loads(path.read_text(encoding="utf-8"))


def test_native_theme_validator_accepts_desktop_colors_and_palette():
    theme = _theme()
    theme["desktop"] = {"surface0": "#123456", "chart": [16, "accent"]}
    assert theme_schema.validateThemeJson("desktop", theme)["desktop"] == theme["desktop"]


@pytest.mark.parametrize("desktop", [{"unknownToken": "#ffffff"}, {"chart": "#ffffff"}, {"surface0": 300}])
def test_native_theme_validator_keeps_desktop_token_validation(desktop):
    theme = _theme()
    theme["desktop"] = desktop
    with pytest.raises(ValueError, match="/desktop"):
        theme_schema.validateThemeJson("desktop", theme)
