import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const port = Number(process.env.CDP_PORT || 9223);
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotPath = path.resolve(
  process.env.MANAGER_SCREENSHOT || "release/manager-window-e2e.png",
);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, message, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) return result;
    await delay(150);
  }
  throw new Error(message);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketUrl);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket.close();
  }
}

async function targets() {
  return fetch(`${baseUrl}/json/list`).then((response) => response.json());
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
  }
  return result.result.value;
}

const mainTarget = await waitFor(
  async () =>
    (await targets()).find(
      (target) =>
        target.type === "page" &&
        target.title === "VibeCoder 加油站" &&
        (target.url.endsWith("/index.html") ||
          target.url.endsWith("index.html")),
    ),
  "没有找到播放器窗口",
);
const mainClient = await new CdpClient(mainTarget.webSocketDebuggerUrl).connect();
await mainClient.send("Runtime.enable");

await waitFor(
  () =>
    evaluate(
      mainClient,
      `Boolean(document.querySelector('button[aria-label="管理内容源"]'))`,
  ),
  "播放器的内容源管理按钮没有出现",
);
await evaluate(
  mainClient,
  `(async () => {
    let media = document.querySelector("#manager-window-e2e-media");
    if (!media) {
      media = document.createElement("video");
      media.id = "manager-window-e2e-media";
      media.src = new URL("./media/maker-workshop.mp4", location.href).href;
      media.muted = true;
      media.loop = true;
      media.style.display = "none";
      document.body.append(media);
    }
    await media.play();
  })()`,
);
const mediaState = async () =>
  evaluate(
    mainClient,
    `(() => {
      const media = document.querySelector("#manager-window-e2e-media");
      return media
        ? { currentTime: media.currentTime, paused: media.paused, readyState: media.readyState }
        : null;
    })()`,
  );
await evaluate(
  mainClient,
  `(async () => {
    const media = document.querySelector("#manager-window-e2e-media");
    if (media?.paused) await media.play();
  })()`,
);
const initialMediaState = await mediaState();
const playingBefore = await waitFor(async () => {
  const state = await mediaState();
  return state && !state.paused && state.readyState >= 2 ? state : null;
}, `播放器未进入播放状态：${JSON.stringify(initialMediaState)}`);

await evaluate(
  mainClient,
  `document.querySelector('button[aria-label="管理内容源"]').click()`,
);

const managerTarget = await waitFor(
  async () =>
    (await targets()).find(
      (target) =>
        target.type === "page" &&
        (target.url.endsWith("/manager.html") ||
          target.url.endsWith("manager.html")),
    ),
  "点击后没有创建内容源管理窗口",
);
const managerClient = await new CdpClient(
  managerTarget.webSocketDebuggerUrl,
).connect();
await managerClient.send("Runtime.enable");
await managerClient.send("Page.enable");

const managerSummary = await waitFor(async () => {
  const summary = await evaluate(
    managerClient,
    `document.querySelector(".manager-titlebar p")?.textContent?.trim()`,
  );
  return summary?.includes("个插件") && summary?.includes("个作品")
    ? summary
    : null;
}, "管理窗口没有显示插件数与作品数");

await delay(1_200);
const playingAfter = await mediaState();
if (playingAfter.currentTime <= playingBefore.currentTime + 0.4) {
  throw new Error("打开管理窗口后播放器时间没有继续前进");
}

const originalBounds = await evaluate(
  managerClient,
  `({
    left: window.screenX,
    top: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  })`,
);
const movedBounds = {
  left: (originalBounds.left ?? 80) + 24,
  top: (originalBounds.top ?? 80) + 18,
  width: Math.max(380, (originalBounds.width ?? 410) + 16),
  height: Math.max(500, (originalBounds.height ?? 580) + 12),
};
await evaluate(
  managerClient,
  `(() => {
    window.moveTo(${movedBounds.left}, ${movedBounds.top});
    window.resizeTo(${movedBounds.width}, ${movedBounds.height});
  })()`,
);
await waitFor(async () => {
  const current = await evaluate(
    managerClient,
    `({
      left: window.screenX,
      top: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight
    })`,
  );
  return Math.abs(current.left - movedBounds.left) <= 2 &&
    Math.abs(current.top - movedBounds.top) <= 2 &&
    Math.abs(current.width - movedBounds.width) <= 2 &&
    Math.abs(current.height - movedBounds.height) <= 2;
}, "管理窗口无法移动或缩放");
await delay(700);

await evaluate(managerClient, `document.querySelector(".manager-close").click()`);
await waitFor(
  () =>
    evaluate(managerClient, `document.visibilityState === "hidden"`),
  "关闭按钮没有隐藏管理窗口",
);

await evaluate(
  mainClient,
  `document.querySelector('button[aria-label="管理内容源"]').click()`,
);
await waitFor(
  () =>
    evaluate(managerClient, `document.visibilityState === "visible"`),
  "再次点击没有恢复管理窗口",
);
const restoredBounds = await evaluate(
  managerClient,
  `({
    left: window.screenX,
    top: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  })`,
);
for (const [key, expected] of Object.entries({
  left: movedBounds.left,
  top: movedBounds.top,
  width: movedBounds.width,
  height: movedBounds.height,
})) {
  if (Math.abs((restoredBounds[key] ?? 0) - expected) > 2) {
    throw new Error(`管理窗口没有记住 ${key}：${restoredBounds[key]} ≠ ${expected}`);
  }
}

await evaluate(
  mainClient,
  `document.querySelector('button[aria-label="管理内容源"]').click()`,
);
await delay(250);
const managerTargetCount = (await targets()).filter(
  (target) =>
    target.type === "page" &&
    (target.url.endsWith("/manager.html") || target.url.endsWith("manager.html")),
).length;
if (managerTargetCount !== 1) {
  throw new Error(`重复点击创建了 ${managerTargetCount} 个管理窗口`);
}

const screenshot = await managerClient.send("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
});
await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
await fs.writeFile(screenshotPath, screenshot.data, "base64");

console.log(
  JSON.stringify({
    result: "passed",
    managerSummary,
    managerTargetCount,
    playbackAdvancedSeconds: Number(
      (playingAfter.currentTime - playingBefore.currentTime).toFixed(2),
    ),
    restoredBounds,
    screenshotPath,
  }),
);

mainClient.close();
managerClient.close();
