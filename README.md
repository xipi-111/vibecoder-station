# VibeCoder 加油站

macOS 与 Windows 通用的极简竖屏作品播放器。播放器本体不包含任何平台内容源；
用户安装 `.vibeplugin` 插件后，才获得对应平台的目录、登录、更新检测和媒体解析
能力。

视频直接播放；图文类作品可以自动轮播图片并播放原声。鼠标不在窗口内时只有作品
内容，移入后才显示播放、下一条、静音、倍速、全屏、关闭窗口、内容源管理与进度
控制。

播放器常驻两路作品画面：当前作品播放时就在后台预载下一条；切换前等待下一条
达到可播放状态，并保留当前最后一帧，随后用整屏向上的推入/推出动画完成交接。
网络变慢时不会为了等待下一条而提前露出黑底。

## 本地运行

```bash
npm install
npm run dev:desktop
```

首次运行没有可播放内容。鼠标移入播放器，点击左上角的插件按钮，在独立“内容源”
窗口中安装 `.vibeplugin` 文件。内容源窗口可拖动、缩放并记住上次位置，不会遮住
或暂停播放器。

播放器将插件安装到自己的用户数据目录：

```text
plugins/<插件 ID>/<版本>/
plugin-data/<插件 ID>/
installed-plugins.json
```

插件代码、配置和运行数据不会被写回播放器安装目录。

## 抖音插件

仓库中的 `plugins/douyin/` 是第一个外置插件，不会进入播放器安装包。构建插件：

```bash
npm run plugin:pack:douyin
```

生成文件：

```text
plugin-dist/com.vibecoder.douyin-<版本>.vibeplugin
```

安装后，抖音插件负责博主主页导入、作品分页、登录、更新检测、播放排序和媒体地址
解析。相关优化只需要修改插件，不需要改播放器核心。

旧版的 `douyin-creators.json`、`douyin-queue-state.json` 和隔离登录会话会在首次
加载抖音插件时迁移并继续使用。

## 插件架构

播放器核心负责：

- 插件包安装、校验、加载和生命周期；
- 多插件之间的新作品优先与随机来源调度；
- 作品 ID 命名空间与媒体请求路由；
- 双缓冲、切换动画、播放设置和窗口；
- `vibecoder-media://` 媒体代理。

插件负责：

- 平台认证和独立会话；
- 内容集合导入与配置；
- 目录同步和更新识别；
- 插件内部的作品排序；
- 将作品解析为标准媒体描述。

完整协议见 [`docs/plugin-contract.md`](docs/plugin-contract.md)。

## 隐私与使用边界

- 平台登录信息由对应插件保存在隔离会话中。
- React 渲染层只接收 `vibecoder-media://` 地址，不接触真实 CDN 地址和 Cookie。
- 当前个人使用阶段将本地安装插件视为可信代码；不要安装来源不明的插件。
- 本项目不隶属于抖音或字节跳动。请仅处理你有权访问和播放的内容，并遵守平台
  规则、内容版权与所在地法律。

## 检查

```bash
npm run test:plugins
npm run test:ordering
npm run test:config
npm run test:transport
npm run build
```

## 构建

```bash
npm run dist:mac
npm run dist:win
```

播放器产物写入 `release/`，不会自动携带 `plugins/` 或 `plugin-dist/`。插件必须
单独安装。正式分发前还需要配置 Apple Developer ID 公证以及 Windows 代码签名。

## License

[MIT](LICENSE) © 2026 xipi-111
