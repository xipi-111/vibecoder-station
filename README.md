# VibeCoder 加油站

macOS 与 Windows 通用的极简竖屏视频播放器。鼠标不在窗口内时只有视频；移入后
才显示播放、下一条、静音、倍速、全屏、关闭窗口、博主管理与进度控制。

播放器常驻两路视频元素：当前视频播放时就在后台预载下一条；切换前等待下一条
达到可播放状态，并保留当前最后一帧，随后用整屏向上的推入/推出动画完成交接。
网络变慢时不会为了等待下一条而提前露出黑底。系统开启“减少动态效果”时会改为
无位移的即时切换。

## 本地运行

```bash
npm install
npm run dev:desktop
```

默认不需要另建解析服务。应用会读取
[`electron/config/creators.json`](electron/config/creators.json)，在隔离的 Electron
会话中检查博主作品，并在播放时解析公开作品的临时 MP4 地址。

鼠标移入视频后，左上角的博主按钮可以直接粘贴抖音主页分享链接并增删博主。
修改后的配置保存在应用数据目录的 `douyin-creators.json`，升级或重新打包不会
覆盖它。

抖音访客模式只开放部分作品。检测到“登录后查看更多”时，鼠标移入视频会出现
“登录抖音”按钮；扫码登录后应用继续分页到 `has_more=false`，再把完整目录用于
“新视频优先、其余无序播放”。这个会话只保存在应用自己的数据目录，不读取或
复制 Chrome Cookie。

## 隐私与使用边界

- 登录信息只保存在应用自己的 Electron 会话中，不读取浏览器 Cookie。
- 为解析媒体地址，应用可能在该隔离会话中加载抖音作品页，因此抖音账号侧可能
  产生浏览记录。
- 本项目不隶属于抖音或字节跳动。请仅处理你有权访问和播放的公开视频，并遵守
  平台规则、内容版权与所在地法律。

## 媒体链路

`video 元素 → vibecoder-media:// → Electron 主进程 → 抖音 CDN`

主进程会转发 Range、透传 206 响应、按需附带 Referer，并在临时地址失效时重新
解析。真实 CDN 地址和会话信息不会进入 React 渲染层。

以下检查均可独立执行：

```bash
npm run test:douyin-catalog
npm run test:douyin-creator
npm run test:douyin
npm run test:config
npm run test:transport
```

## 可选：外部解析服务

如需把目录和解析规则放在自己的服务端，可按
[`docs/stream-resolver-contract.md`](docs/stream-resolver-contract.md) 接入：

```bash
VIBECODER_RESOLVER_URL=https://your-resolver.example.com \
VIBECODER_RESOLVER_TOKEN=your-token \
npm run dev:desktop
```

## 构建

```bash
npm run dist:mac
npm run dist:win
```

产物写入 `release/`。正式分发前还需要配置 Apple Developer ID 公证以及 Windows 代码签名证书。

## License

[MIT](LICENSE) © 2026 xipi-111
