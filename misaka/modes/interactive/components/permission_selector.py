"""Bordered selector for interactive permission-mode changes."""

from __future__ import annotations

from collections.abc import Callable

from misaka.ui.tui import (
    Container,
    SelectItem,
    SelectList,
    SelectListLayoutOptions,
    Spacer,
    Text,
)
from misaka.modes.interactive.components.dynamic_border import DynamicBorder
from misaka.modes.interactive.theme.theme import getSelectListTheme, theme

PERMISSION_SELECT_LIST_LAYOUT = SelectListLayoutOptions(minPrimaryColumnWidth=18, maxPrimaryColumnWidth=36)

PERMISSION_DESCRIPTIONS = {
    "default": "标准模式 · 敏感与高危操作需人工审批确认（推荐）",
    "plan": "只读规划 · 严格只读，禁止写文件/破坏命令，文献研读/大纲论证专用",
    "acceptEdits": "自动编辑 · 工作区内文件自由读写修改，无需逐次审批",
    "bypassPermissions": "完全放行 · 完全自主执行，跳过所有权限询问（自主执行）",
}


class PermissionSelectorComponent(Container):
    def __init__(
        self,
        currentMode: str,
        onSelect: Callable[[str], None],
        onCancel: Callable[[], None],
    ) -> None:
        super().__init__()

        modes = ["default", "plan", "acceptEdits", "bypassPermissions"]
        labels = {
            "default": "default (标准审批)",
            "plan": "plan (只读规划)",
            "acceptEdits": "acceptEdits (自动编辑)",
            "bypassPermissions": "bypassPermissions (完全放行)",
        }
        items = [
            SelectItem(
                value=mode,
                label=labels.get(mode, mode),
                description=PERMISSION_DESCRIPTIONS.get(mode, ""),
            )
            for mode in modes
        ]

        self.addChild(DynamicBorder())
        self.selectList = SelectList(items, len(items), getSelectListTheme(), PERMISSION_SELECT_LIST_LAYOUT)
        current_index = next((index for index, item in enumerate(items) if item.value == currentMode), 0)
        self.selectList.setSelectedIndex(current_index)
        self.selectList.onSelect = lambda item: onSelect(item.value)
        self.selectList.onCancel = onCancel
        self.addChild(self.selectList)
        self.addChild(Spacer(1))
        self.addChild(Text(theme.fg("dim", "  Current session only · Enter to select · Esc to cancel"), 0, 0))
        self.addChild(DynamicBorder())

    def handleInput(self, data: str) -> None:
        self.selectList.handleInput(data)

    def getSelectList(self) -> SelectList:
        return self.selectList


__all__ = [
    "PermissionSelectorComponent",
]
