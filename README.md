# koishi-plugin-maibot

舞萌 DX 相关功能的 Koishi 插件（绑定、状态、B50 上传、票券查询等）。

## 公共 API 与文档链接

- **申请 API / 令牌**：[https://api.awmc.team](https://api.awmc.team)
- **购买额度**：[https://store.awmc.team](https://store.awmc.team)
- **开放接口与计费说明（在线）**：[https://wiki.awmc.team/dev/awmc-api](https://wiki.awmc.team/dev/awmc-api) · 仓库内 [`awmc-api.md`](./awmc-api.md) 为摘要（默认网关 `https://api.awmc.team`）

使用公共网关时，在插件配置中将 **apiMode** 设为 `public`，填写 **publicGatewayToken**，并将 **apiBaseURL** 设为 `https://api.awmc.team`（或提供方给出的网关根地址）。无需配置 **machineInfo**、**turnstileToken**。若接口返回 **403**，多为账户 Token 余额不足，请到 [store.awmc.team](https://store.awmc.team) 充值后再试。

更完整的安装步骤、进阶功能与排错说明请见 **项目 Wiki**（GitHub 仓库主页文档区）。

## 功能特性

- ✅ 用户绑定（通过 SGWCMAID 二维码）
- ✅ 用户解绑
- ✅ 状态查询（含票券查询等，取决于所选 API 模式）
- ✅ 水鱼 Token 绑定/解绑与 B50 上传
- ✅ 落雪代码绑定/解绑与 B50 上传
- ✅ B50 任务状态轮询与提示
- ✅ 按配置可选：发票、收藏品、改版本号等（仅 **团队内部 / 自建 API** 模式）
- ✅ 账号状态提醒、用户 ID 掩码、操作日志等
- ✅ 数据库存储（SQLite/MySQL/PostgreSQL）

## 安装

```bash
npm install koishi-plugin-maibot
```

## 配置概要

在 `koishi.yml` 中（字段以控制台表单为准）：

**公共网关示例：**

```yaml
plugins:
  maibot:
    apiMode: public
    apiBaseURL: https://api.awmc.team
    publicGatewayToken: <在 api.awmc.team 获取的令牌>
```

**自建 / 团队内部服务示例：**

```yaml
plugins:
  maibot:
    apiMode: team
    apiBaseURL: http://你的服务:端口
    machineInfo:
      clientId: ...
      regionId: ...
      placeId: ...
      placeName: ...
      regionName: ...
    turnstileToken: ...
```

未显式填写 **apiMode** 时默认为 `team`，与旧版配置兼容；仅当你明确使用公共网关时才设为 `public`。

### 跨平台绑定（推荐）

如需在多个平台（QQ/Discord/Telegram 等）共享同一份绑定数据，建议同时启用 Koishi 官方 `bind` 插件。本插件会优先使用 bind 统一后的用户 ID，并兼容历史的平台原始 ID。

### 群白名单跨平台配置

`whitelist.targets` 支持 `platform:guildId` 格式（例如 `qq:1072033605`、`discord:1234567890`），也支持仅填写 `guildId`（兼容旧配置）。

## 使用（节选）

### 绑定账号

```
/mai绑定 SGWCMAIDxxxxxxxxxxxxx
```

### 查询状态

```
/mai状态
```

### 帮助

```
/mai
/mai帮助
/mai帮助 --advanced
```

公共 API 模式下，`--advanced` 会说明哪些功能仅在 `team` 模式下可用。

更多子命令见游戏内帮助或 Wiki。

## API 说明

本插件通过 HTTP 调用后端网关：

- **apiMode: public** 时，使用网关的 **`/v1/...`** 路径，请求头携带 `Authorization: Bearer <令牌>`，详见 [Wiki 文档](https://wiki.awmc.team/dev/awmc-api) 或 [`awmc-api.md`](./awmc-api.md)。
- **apiMode: team** 时，使用自建服务上既有路径（如 `/api/public/...` 等），与历史部署一致。

## 许可证

MIT
