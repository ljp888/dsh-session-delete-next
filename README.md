# dsh-session-delete-next

DSH（DeepSeek Harness）侧栏**会话删除**插件 —— 为当前运行时（`0.2.0-rc.2`）重写的版本，
替代插件市场里因 peer 版本范围（`^0.1.0-rc.5`）不兼容而装不上的 `dsh-session-delete`。

仓库：<https://github.com/ljp888/dsh-session-delete-next>

[English](#english) | 中文

---

## 中文

### 功能

| 入口 | 菜单项 | 行为 |
|---|---|---|
| 会话行 `…` 菜单 | **删除会话** | 永久删除该会话的全部本地记录，不可恢复 |

要点：

- 危险操作，红色菜单项 + 独立确认对话框（明示「不可恢复」并显示会话标题）。
- **运行中的会话一律拒绝删除**（含当前会话）——宿主端返回 `409 live`，对话框给出提示。
- 删除后立即从侧栏消失，**无需刷新**（复用官方已转发的 `api-session/removed` 事件）。
- 菜单文案跟随 GUI 语言（中文 / 英文），走官方 locale 服务。

### 技术实现

与旧版插件的关键差异：**不再用 DOM 注入**。`0.2.0-rc.2` 已开放官方扩展点，本插件走
标准 slot 机制，不会随侧栏结构变化而静默失效。

**Host 半**（`index.js`，纯 ESM）

- 只 `inject: ['webServer']`，其余服务（`sessionPersistence` / `workspaceRegistry` /
  `sessions` / `storageDomain`）按请求用 `ctx.get()` 惰性获取，缺失时降级而不是拒绝加载。
- 注册同源路由 `POST /dsh-session-delete-next/delete`，请求体 `{ sessionId }`。
- 删除顺序（**先删文件，后记账**，失败绝不留下「已隐藏但未删除」的半删状态）：
  1. 拒绝 live / 已创建未落盘的会话；
  2. `ctx.sessionPersistence.stat(id)` 定位日志，`locate(header).path` 取路径，
     删除其所在目录（含 `session.lock`）；
  3. 安全校验：文件名必须匹配后端自己的 `session.v<N>.jsonl[.zst|.zstd|.gz]`，
     且目录必须位于持久化后端的 `root` 之内，否则拒绝；
  4. 清理 `session_projcache` 投影缓存；
  5. 从 workspace 账目 `detachSession`，并清除归档标记；
  6. `ctx.emit('api-session/removed', id)` 通知浏览器。
- 同源校验：跨站 `Origin` 直接 `403`。

**Client 半**（`client.js`，手写浏览器 bundle，无需构建）

- `window.__ModuleLoader__.load({ id: '<包名>', factory })` 懒注册。
- 注册到官方 slot：
  - `sidebar.workspaces.session.menu.item`（会话 `…` 菜单，`order: 500`，排在
    pin/rename/fork/archive 之后）；
  - `shell.overlay`（确认对话框，独立于菜单生命周期）。
- 复用宿主注入的 `useMenuOpenState()` 关闭菜单；`t()` 来自 `ctx.locale.register`。
- 若宿主缺少所需 UI primitives，只告警并跳过注册，不会让 slot 渲染崩溃。

### 安装

最省事的方式是直接 clone 成 profile 的插件目录（`<profile>` 默认为 `~/.dsh/profiles/desktop`）：

```bash
git clone https://github.com/ljp888/dsh-session-delete-next.git \
  ~/.dsh/profiles/desktop/node_modules/dsh-session-delete-next
```

Windows PowerShell 对应写法：

```powershell
git clone https://github.com/ljp888/dsh-session-delete-next.git `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-delete-next"
```

然后手动复制文件也可以，步骤：

1. 把整个包目录复制到 `<profile>/node_modules/dsh-session-delete-next/`
   （`<profile>` 默认为 `~/.dsh/profiles/desktop`）。
2. 在 `<profile>/cordis.patch.yml` **追加**一行挂载（此文件被 HMR 监听，保存后即热加载）：

   ```yaml
   - insert:
       - id: dsh-session-delete-next
         name: dsh-session-delete-next
   ```

3. 浏览器刷新一次即可看到菜单项。

> 不写入 profile 的 `package.json`：本包不在 npm 上，写成 `dependencies` 会让后续
> `pnpm install` / `dsh plugin` 操作去 registry 拉取而失败。代价是将来在 profile 里跑
> `pnpm install` 可能把这个目录剪掉，重装即可。

### 已知限制

- **不能删除 live 会话。** 官方没有公开的「驱逐运行中会话」API，所以正在运行或已打开的
  会话会被拒绝。先关掉它（或重启 DSH）再删。
- **子智能体会话**也可删除；删除后父会话的子智能体目录会少一项，界面会随
  `api-session/removed` 自行收敛。
- **附件不删。** `~/.dsh/attachments/**` 是内容寻址、跨会话共享的，删除会话不会动它。
- Windows 上若另一个进程仍持有 `session.lock`，`rm` 可能报 `EBUSY`；此时对话框会显示
  原始错误且**磁盘状态不变**，重试即可。
- 全量删除（按工作区批量）未实现——只做单个会话删除，减少不可验证的失败路径。

### 实测验证状态（本机）

| 项目 | 结果 |
|---|---|
| 宿主端加载 + 路由注册 | ✅ `~/.dsh/logs/desktop-next.log`：`[dsh-session-delete-next] host ready: POST /dsh-session-delete-next/delete` |
| profile 热加载（无需重启） | ✅ 追加 patch 行后 Loader 自动刷新，日志即出现上述行 |
| 侧栏 `…` 菜单出现「删除会话」 | ✅ 红色危险样式 + 分隔线，排在官方「归档会话」之后 |
| 中文 locale 解析 | ✅ 显示「删除会话」，不是原始 key |
| 确认对话框 | ✅ 标题、含会话名插值的正文、红色「永久删除」、取消 |
| 执行真正删除（成功路径） | ⚠️ **未执行** —— 原因见下 |

**为什么没做破坏性实测**：验证时侧栏只有一条会话，正是承载那次对话的活跃会话。
官方在 `0.2.0-rc.2` 没有公开「驱逐运行中会话」的 API，所以插件会拒绝删除它；
跑通「删除成功」路径需要一个**非活跃**会话当靶子，我不拿真实对话历史去赌。
想自行确认：新开一个会话 → 随便发一条消息 → 切回原会话 → 对那个测试会话执行删除。
删除成功的判据是 `~/.dsh/sessions/<项目目录>/<会话 id>/` 整个目录消失，且侧栏该行立即消失。

> 注：`index.js` 的 fail-closed 安全加固（`sessions` 服务不可用时拒绝删除）不在 HMR
> 模块监听根内，需**重启 DSH** 才在运行实例中生效；之前的运行实例行为一致。

## English

Adds the missing **Delete session** action to the sidebar session row menu of DSH
`0.2.0-rc.2`, replacing the marketplace `dsh-session-delete` whose peer range
(`^0.1.0-rc.5`) no longer resolves.

- Permanently removes the session's local records; red danger styling plus a
  confirmation dialog that states the action is irreversible.
- Running/open sessions are refused (`409 live`) — they are never deleted.
- The row disappears immediately, with no refresh, by re-emitting the official
  `api-session/removed` forwarded event.
- Localized through the client locale service (zh/en).

Unlike the original plugin this uses the **official slots** rather than DOM
injection: `sidebar.workspaces.session.menu.item` for the menu row and
`shell.overlay` for the dialog. Files are removed before any bookkeeping, so a
failure never leaves a session that is hidden but still on disk.

Install: clone this repository straight into the profile's plugin directory —
`git clone https://github.com/ljp888/dsh-session-delete-next.git ~/.dsh/profiles/desktop/node_modules/dsh-session-delete-next`
— then append the `- insert:` row to `<profile>/cordis.patch.yml` and refresh the
page. The profile `package.json` is deliberately left untouched because this
package is not published to npm.

## License

MIT
