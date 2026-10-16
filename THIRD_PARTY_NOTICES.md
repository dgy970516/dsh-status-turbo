# 第三方说明 / Third-Party Notices

## 结论：本包未复制任何第三方源码

`dsh-status-turbo` 的 `lib/`、`test/`、`docs/` 全部为本项目原创。**没有任何文件是从其它项目拷贝、改写或机械转换而来。**

## 为了对接接口而阅读过的第三方产物

开发过程中，为了确认 DSH 的**公开接口形状**（清单字段、槽位注册签名、wire 投影注册结构、客户端 bundle 装载约定），阅读了本机已装插件的运行时代码。这些阅读只用于确定**接口签名的形状**（属于平台公开契约），未取用其业务逻辑或实现代码。

| 包 | 版本 | 许可 | 作者 | 阅读目的 |
| --- | --- | --- | --- | --- |
| `dsh-cache-billing` | 0.1.5 | MIT | betterer | 确认 `sessionProjections.register({ key, stateVersion, stateSchema, init, apply, wire })` 的字段形状；确认客户端 bundle 的 `window.__ModuleLoader__.load({ id, factory })` 装载约定与 `slots.inject → slots.register → disposer` 挂载写法 |
| `dsh-session-actions` | 0.3.1 | MIT | duanyunlun | 确认 `package.json` 中 `dsh.bundle.patch` / `dsh.client.platform` / `engines` 的最小形状；确认 `cordis.patch.yml` 的 `- insert:` 结构 |
| `dsh-client-auto-continue` | 0.14.0 | MIT | — | 同上（可选 `client.inject` 字段的对照） |

以上三包均为 **MIT** 许可，其许可条款与本包兼容。本包**不包含**它们的任何代码，因此其版权声明无需随附；此处列出仅为出处透明。

## 平台

DSH 本体（`@deepseek-ai/dsh` 及其 `@deepseek-ai/*` 运行时包）为 DeepSeek 所有，本包仅通过其公开接口调用，不包含、不再分发其任何代码。
本包的 `peerDependencies` 声明为 `@deepseek-ai/dsh: ^0.2.0-rc.2`。

## 无运行时第三方依赖

本包运行时**不依赖** zod、esbuild、react 之外的任何第三方包。客户端半只从宿主 loader 取 `react`（由宿主提供，不随本包分发）。
因此本包没有需要随附许可的传递依赖。
