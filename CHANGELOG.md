# Changelog

## 0.1.1

- English release: extension display name, commands, menus, settings, tree badges and tooltips, preview pages, status labels, and backend errors/warnings are now English (webview HTML uses `lang="en"`); conversation contents, session titles, and file paths are never translated.
- Bilingual source documentation: README.md now carries full equivalent English and Chinese guides; a dedicated English MARKETPLACE.md is the store README (`vsce package --readme-path MARKETPLACE.md`), and the bilingual source README is excluded from the VSIX.
- No behavior changes: IDs, stored state keys, paths, archive/deletion semantics, realtime refresh logic, and engine behavior are unchanged. Test expectations were updated only for the translated owned strings.

## 0.1.0

- Initial public source release of the locally validated Windows extension.
- Workspace grouping, previews, archive management and recoverable removal.
