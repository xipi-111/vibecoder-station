# 流媒体解析服务契约

本文描述可选的外部解析服务模式。无外部服务时，应用使用内置的隔离抖音会话；
两种模式都由 Electron 主进程转发真实媒体请求，React 渲染层只能看到内部的
`vibecoder-media://stream/<videoId>` 地址。

## 1. 取得下一个视频

`POST /v1/queue/next`

请求：

```json
{
  "afterId": "previous-video-id"
}
```

首个视频的 `afterId` 为 `null`。你的服务在这里执行“新视频优先，旧视频无序播放”的规则。

响应：

```json
{
  "id": "douyin-item-id",
  "authorId": "creator-id",
  "publishedAt": "2026-07-27T08:00:00.000Z",
  "priority": "new",
  "media": {
    "url": "https://example.douyin-cdn.com/video.mp4?...",
    "mimeType": "video/mp4",
    "expiresAt": "2026-07-27T08:10:00.000Z",
    "headers": {
      "Referer": "https://www.douyin.com/",
      "User-Agent": "your-approved-user-agent",
      "Cookie": "only-if-your-authorized-source-requires-it"
    }
  }
}
```

`media` 可以省略。播放器真正开始读取时会调用解析接口，以得到最新短链。

## 2. 刷新媒体地址

`POST /v1/media/resolve`

请求：

```json
{
  "videoId": "douyin-item-id"
}
```

响应：

```json
{
  "media": {
    "url": "https://example.douyin-cdn.com/video.mp4?...",
    "mimeType": "video/mp4",
    "expiresAt": "2026-07-27T08:10:00.000Z",
    "headers": {
      "Referer": "https://www.douyin.com/"
    }
  }
}
```

## 3. 传输约束

- v1 使用 HTTPS 的渐进式 MP4（H.264 + AAC），必须支持 `Range` 请求。
- 上游应正确返回 `206 Partial Content`、`Content-Range`、`Content-Length`、`Accept-Ranges: bytes` 和 `Content-Type: video/mp4`。
- 媒体短链失效时，上游常返回 401、403 或 410；桌面端会强制重新解析并重试一次。
- `expiresAt` 使用 ISO 8601 字符串或 Unix 毫秒。
- 桌面端只允许解析服务提供 `Authorization`、`Cookie`、`Origin`、`Referer` 和 `User-Agent` 五类上游头；不会把渲染层的 Cookie 转发给抖音。
- 为保证 Windows 与 macOS 一致，v1 不直接播放 HLS。若你的接口只返回 `.m3u8`，建议解析服务转封装为 MP4；否则下一阶段需要增加 HLS 清单与分片代理。

## 4. 桌面端配置

开发环境：

```bash
VIBECODER_RESOLVER_URL=https://your-resolver.example.com \
VIBECODER_RESOLVER_TOKEN=your-token \
npm run dev:desktop
```

第一次提供的 Token 会使用 macOS Keychain 或 Windows DPAPI 加密后写入应用数据目录。后续启动可以只提供 `VIBECODER_RESOLVER_URL`。

未设置 `VIBECODER_RESOLVER_URL` 时，应用读取
`electron/config/creators.json` 并使用内置抖音源。抖音要求登录才能继续作品分页
时，用户只需在播放器悬浮控制中打开应用内登录窗口；该会话不与 Chrome 共用。
