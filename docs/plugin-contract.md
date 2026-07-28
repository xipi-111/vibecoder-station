# VibeCoder 内容源插件协议 v1

## 1. 插件包

插件是扩展名为 `.vibeplugin` 的 ZIP 文件，清单必须位于压缩包根目录：

```text
plugin.json
main.cjs
其他插件私有文件
```

播放器拒绝绝对路径、`../` 路径、缺失入口文件以及解压后超过 25 MB 的插件包。

最小清单：

```json
{
  "apiVersion": 1,
  "id": "com.example.source",
  "name": "示例内容源",
  "version": "1.0.0",
  "main": "main.cjs",
  "capabilities": {
    "queue": true,
    "authentication": false,
    "collections": true
  }
}
```

- `id` 使用反向域名格式，安装后不可改变。
- `version` 使用 `x.y.z` 格式。
- `main` 必须是插件包内的相对路径。
- 同一个插件 ID 同时只激活一个版本。

## 2. 插件入口

入口使用 CommonJS，并导出异步或同步的 `createPlugin(context)`：

```js
exports.createPlugin = async (context) => ({
  start() {},
  stop() {},
  async getQueueInfo(afterId) {},
  async next(afterId) {},
  async resolve(itemId) {},
  async getStatus() {},
  async login() {},
  async listCollections() {},
  async addCollection(input) {},
  async removeCollection(collectionId) {}
});
```

`context`：

```js
{
  pluginId,
  pluginPath,
  dataPath,
  legacyDataPath
}
```

- `pluginPath` 是当前版本的只读安装目录。
- `dataPath` 是插件持久化配置和状态的专属目录。
- `legacyDataPath` 仅用于插件自己迁移旧版数据。

当前个人使用阶段，插件在 Electron 主进程中作为可信 CommonJS 代码运行，因此插件
拥有与主进程相同的权限。公开插件生态之前必须增加签名验证、权限声明和进程隔离。

## 3. 必需方法

### `next(afterId)`

返回插件内部的下一个作品：

```json
{
  "id": "platform-item-id",
  "authorId": "optional-author-id",
  "publishedAt": "2026-07-28T00:00:00.000Z",
  "priority": "new",
  "kind": "video"
}
```

插件内部执行自己的“新作品优先、历史作品随机”等规则。播放器会在 ID 前添加插件
命名空间，因此不同插件可以返回相同的本地作品 ID。

### `resolve(itemId)`

返回可播放媒体描述：

```json
{
  "id": "platform-item-id",
  "kind": "video",
  "media": {
    "url": "https://cdn.example.com/video.mp4",
    "mimeType": "video/mp4",
    "expiresAt": "2026-07-28T00:10:00.000Z",
    "headers": {
      "Referer": "https://example.com/"
    }
  }
}
```

图文作品使用 `kind: "image"`、`imageMedia[]` 和作为原声的 `media`。真实地址与
请求头只在 Electron 主进程中使用。

## 4. 可选方法

- `getQueueInfo(afterId)`：返回 `{ hasNew, newestPublishedAt }`，帮助播放器在多个
  插件之间优先选择有更新的来源。
- `start()` / `stop()`：启动或停止轮询、窗口等资源。
- `getStatus()` / `login()`：暴露登录与目录同步状态。
- `listCollections()` / `addCollection()` / `removeCollection()`：提供博主、频道、
  文件夹等内容集合的管理能力。

集合统一表示为：

```json
{
  "items": [
    {
      "id": "collection-id",
      "name": "显示名称",
      "subtitle": "辅助信息"
    }
  ]
}
```

## 5. 多插件调度

播放器首先读取所有插件的 `getQueueInfo()`：

1. 有新作品的插件优先；
2. 若多个插件都有更新，优先选择发布时间较新的插件；
3. 没有更新时，在可用插件之间随机选择；
4. 选定插件后，作品内部顺序完全由该插件决定；
5. 一个插件失败时，播放器尝试其他已安装插件。

## 6. 版本升级方向

v1 适用于个人可信插件。公开分发前计划增加：

- 插件签名和发布者身份；
- 域名、登录、存储等权限声明；
- 独立 Utility Process 或受限运行时；
- 插件启用、禁用、升级和卸载；
- 安装前权限确认与来源提示；
- 商店版仅允许审核过的插件。
