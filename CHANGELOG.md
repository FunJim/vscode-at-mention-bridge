# Changelog

All notable changes to the "vscode-at-mention-bridge" extension will be documented in this file.

## [0.0.2] - 2026-07-02

- Added `${realPath}` template variable for symlink-resolved file and folder paths.

## [0.0.1] - 2026-06-25

- Initial implementation with copy/insert commands, configurable templates, terminal target linking, context menus, status bar target selection, tests, docs, icon, and CI packaging workflow.
- Unified copy and insert rendering so both use `atMentionBridge.defaultTemplate` by default.
- Improved dynamic template picking, default-template selection, and template settings documentation.
- Improved terminal target discovery for wrapped agents, process-tree rescans, remote SSH, and tmux panes.
- Clarified target picker and status bar labels, including PID-focused status text and terminal reveal on target switch.
- Removed unused explicit Claude/Codex copy-style commands and the manual active-terminal link command.
- Added clearer agent discovery logging and supported-agent documentation.
- Refined the extension icon and fixed VS Code extension test timeout handling.
