# Changelog

## 0.2.1

- **Delete moves the conversation to the Windows Recycle Bin**: it is exported and verified, removed from OpenCode, and the export folder goes to the Recycle Bin. The extension no longer keeps private backups; a refused delete discards its temporary export. To undo, restore the folder from the Recycle Bin and run **Restore Deleted Session**.
- **Archive moves the conversation out of OpenCode** into `~/.local/share/opencode-history-archive/<id>/`; **Unarchive** imports it back. Only main sessions can be archived; child sessions move with them.
- New **Archived** view with Unarchive, Delete (to the Recycle Bin), **Open Archive Folder** and **Empty Archive**.

## 0.2.0

- **Static sidebar, refresh on demand.** History is read only when you press **Refresh** or run an action that changes sessions (archive, delete, restore, legacy import). The SSE event stream, the 2-second database polling, the periodic reconciliation and the focus, visibility and terminal-close refreshes were removed. The view header shows when it was last refreshed.
- **No resident processes.** An already running OpenCode background service is reused untouched, as before. When none is running, the extension no longer starts the resident background service (`opencode service start`, ~70 MB that stayed after VS Code closed); each read uses a private temporary `opencode serve` on 127.0.0.1 that is stopped, with its whole process tree, right after the read.
- **Instant startup from the last refresh.** The result of the last refresh is saved as a small JSON snapshot in the extension's storage; a new VS Code window shows it without starting any process. Only a first-ever start reads once when the view is first shown.
- **Lighter previews.** The Markdown renderer loads on the first preview, "Load more" renders only new or replaced entries, and hidden preview tabs no longer keep their page alive in memory.

## 0.1.2

- Added an original folder-and-history app icon, a theme-aware activity bar icon, and a matching documentation logo.

## 0.1.1

- English release: extension display name, commands, menus, settings, tree badges and tooltips, preview pages, status labels, and backend errors/warnings are now English (webview HTML uses `lang="en"`); conversation contents, session titles, and file paths are never translated.
- Bilingual source documentation: README.md now carries full equivalent English and Chinese guides; a dedicated English MARKETPLACE.md is the store README (`vsce package --readme-path MARKETPLACE.md`), and the bilingual source README is excluded from the VSIX.
- No behavior changes: IDs, stored state keys, paths, archive/deletion semantics, realtime refresh logic, and engine behavior are unchanged. Test expectations were updated only for the translated owned strings.

## 0.1.0

- Initial public source release of the locally validated Windows extension.
- Workspace grouping, previews, archive management and recoverable removal.
