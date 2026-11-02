# OpenCode History Sidebar

Unofficial community VS Code extension for browsing and managing local OpenCode conversation history by workspace folder. This project is independently maintained and is not an official extension from the engine vendor.

- Workspace folders, parent/child conversations, title/path search and paginated read-only previews.
- Archive management and recoverable removal; see the Chinese guide below for the different recovery behavior of each engine.
- Resume a main conversation in its original working directory and switch back to its verified terminal.
- Windows x64; VS Code 1.144.0 or later. Validated with OpenCode 2.2.5. The engine must be installed separately.
- Preview does not fetch remote transcript images or links. No conversation data, account credentials, or recovery backups are included in this repository.

Install the Windows VSIX from [GitHub Releases](https://github.com/Great-us/opencode-history-sidebar/releases). The publisher IDs in local packages are `AlexWonton`; Marketplace packages use the AlexWonton publisher identity.

MIT licensed; upstream attribution is retained in `LICENSE`.

---

# OpenCode 历史记录

本地定制的 VS Code 扩展，扩展 ID 为 `AlexWonton.opencode-history-sidebar`。按文件夹管理本机 OpenCode 会话，可与 Muse Desktop 和 Muse 历史侧栏共存。当前版本面向 OpenCode 2.2.5、VS Code 1.144.0。

## 使用

- 打开活动栏的 **OpenCode 历史记录**，展开文件夹查看主会话与子会话。
- 用标题栏的放大镜搜索标题或目录，用漏斗筛选归档状态。
- 右键会话选择 **只读预览**。内容分页加载；出现新内容提示时，点 **加载到最新**。
- 右键主会话可在原目录打开 OpenCode 终端；子会话提供打开父主会话的入口。
- 右键归档或取消归档。归档保留正文。
- **删除（可恢复）**会列出受影响的会话，并先生成本地备份、验证恢复能力。检测到未完成消息、排队输入、已知运行任务或备份期间的变化时会拒绝删除。
- 点标题栏的 **恢复备份**选择记录还原。恢复范围是已验证的对话正文、父子关系、原目录及归档等元数据，项目文件不在此备份范围。

下次打开会重新读取当前记录。侧栏或预览可见时，每两秒检测本机数据变化，变化后自动更新；同时定期核对完整清单。断线时保留上次内容并标出状态和最后更新时间，重连后重新读取。其他进程的运行状态无法确认时保留为未知。

删除前请先停止其他窗口中相关会话的任务，删除过程中不要继续写入。OpenCode 2.2.5 无法提供跨进程的原子删除；无法确认其他任务已停止时，请先归档或取消。本扩展会报告已知的部分成功或未确认结果，无法保证发现最终复核之后所有并发变化。

旧版遗留记录会单独标注，支持只读预览和本地归档。需要继续会话或删除时，先选 **将旧版记录导入新版**并确认；仅导入经过验证的格式，其他格式仍可预览。安装和普通浏览不会自动导入旧数据。

本扩展不上传对话，预览不会自动访问外链或图片。恢复备份含原始正文，保存在扩展的本地私有目录中，不自动清除。安装包与源码包不包含你的历史或备份。

如果读取失败，可先点刷新，再使用齿轮选择本机 `opencode.exe`。界面会保留上次成功读取的内容并显示错误。

## 开发

保留 `package-lock.json`，使用锁定依赖：

```powershell
npm ci
npm test
node test/run-backend.cjs
$env:OPENCODE_TEST_ENGINE = '<本机 opencode.exe 的绝对路径>'
npm run test:extension
npm run package
```

后端原生测试可通过 `OPENCODE_BACKEND_TEST_ENGINE` 指定引擎路径。原生测试使用隔离的合成数据，不发送模型请求。打包目标为 Windows x64。

## 许可

MIT。复用部分 Muse 历史侧栏的分组、分页、渲染与终端管理实现；版权和署名见随包提供的 `LICENSE` 文件。

## 从本地构建切换

商店版本使用 AlexWonton 发布者，与此前 local-opencode-tools 本地构建是不同扩展 ID。本地视图归档标记和终端认回记录不会自动迁移；切换前请保留旧版，并关闭其对应终端后再使用商店版。引擎中的对话文件仍在原处。
