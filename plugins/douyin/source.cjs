const { BrowserWindow, session } = require("electron");
const https = require("node:https");

const DETAIL_API_PATH = "/aweme/v1/web/aweme/detail";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CREATOR_TIMEOUT_MS = 120_000;
const CATALOG_SESSION_WARMUP_MS = 6_000;
const CATALOG_PAGE_DELAY_MS = 600;
const MAX_CATALOG_PAGES = 200;
const MEDIA_FALLBACK_TTL_MS = 5 * 60 * 1_000;
const LOGIN_COOKIE_NAMES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_tt",
]);
const DOUYIN_PROFILE_HOSTS = new Set([
  "douyin.com",
  "iesdouyin.com",
  "www.douyin.com",
  "www.iesdouyin.com",
  "v.douyin.com",
]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertVideoId(videoId) {
  const value = String(videoId ?? "");
  if (!/^\d{10,24}$/.test(value)) {
    throw new Error(`无效的抖音作品 ID：${value}`);
  }
  return value;
}

function firstHttpsUrl(values) {
  return (values ?? []).find((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
}

function getPlayUrl(aweme) {
  const direct = firstHttpsUrl(aweme?.video?.play_addr?.url_list);
  if (direct) return direct;

  for (const variant of aweme?.video?.bit_rate ?? []) {
    const candidate = firstHttpsUrl(variant?.play_addr?.url_list);
    if (candidate) return candidate;
  }

  return firstHttpsUrl(aweme?.video?.download_addr?.url_list);
}

function isImagePost(aweme) {
  return (
    Number(aweme?.aweme_type) === 68 ||
    (Array.isArray(aweme?.images) && aweme.images.length > 0)
  );
}

function getImageUrls(aweme) {
  const urls = [];
  const seen = new Set();

  for (const image of aweme?.images ?? []) {
    const url =
      firstHttpsUrl(image?.url_list) ??
      firstHttpsUrl(image?.download_url_list);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}

function getMusicUrl(aweme) {
  return firstHttpsUrl(aweme?.music?.play_url?.url_list);
}

function inferExpiry(url) {
  try {
    const parsed = new URL(url);
    const queryExpiry = Number(
      parsed.searchParams.get("x-expires") ??
        parsed.searchParams.get("expires"),
    );
    if (
      Number.isFinite(queryExpiry) &&
      queryExpiry * 1_000 > Date.now() &&
      queryExpiry * 1_000 < Date.now() + 365 * 24 * 60 * 60 * 1_000
    ) {
      return queryExpiry * 1_000;
    }

    const segments = parsed.pathname.split("/");
    const hexTimestamp = segments.find((segment) =>
      /^[0-9a-f]{8}$/i.test(segment),
    );
    if (hexTimestamp) {
      const milliseconds = Number.parseInt(hexTimestamp, 16) * 1_000;
      if (
        milliseconds > Date.now() &&
        milliseconds < Date.now() + 7 * 24 * 60 * 60 * 1_000
      ) {
        return milliseconds;
      }
    }
  } catch {
    // Use the conservative fallback below.
  }

  return Date.now() + MEDIA_FALLBACK_TTL_MS;
}

function uniqueVideoLinks(values) {
  const links = [];
  const seen = new Set();

  for (const value of values ?? []) {
    const match = String(value).match(
      /^https:\/\/www\.douyin\.com\/video\/(\d+)/,
    );
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    links.push({ id: match[1], url: match[0] });
  }

  return links;
}

function extractProfileInput(value) {
  const text = String(value ?? "").trim();
  if (/^MS4wLjAB[A-Za-z0-9_-]+$/.test(text)) {
    return { secUid: text, shareUrl: null };
  }

  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) {
    throw new Error("请粘贴抖音博主主页分享链接");
  }

  let parsed;
  try {
    parsed = new URL(urlMatch[0].replace(/[，。；、)\]}>]+$/u, ""));
  } catch {
    throw new Error("博主主页链接格式无效");
  }
  if (!DOUYIN_PROFILE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("只支持 douyin.com 或 v.douyin.com 的博主主页链接");
  }

  const directMatch = parsed.pathname.match(
    /^\/(?:share\/)?user\/([^/?#]+)/,
  );
  return {
    secUid: directMatch ? decodeURIComponent(directMatch[1]) : null,
    shareUrl: parsed.toString(),
  };
}

function requestRedirect(url, userAgent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": userAgent,
        },
      },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location ?? null,
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("解析抖音主页分享链接超时"));
    });
    request.on("error", reject);
  });
}

async function followDouyinRedirects(initialUrl, userAgent, timeoutMs) {
  let current = new URL(initialUrl);
  for (let redirectCount = 0; redirectCount < 8; redirectCount += 1) {
    if (!DOUYIN_PROFILE_HOSTS.has(current.hostname.toLowerCase())) {
      throw new Error("抖音分享链接跳转到了不受支持的站点");
    }
    const response = await requestRedirect(
      current,
      userAgent,
      timeoutMs,
    );
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.location
    ) {
      current = new URL(response.location, current);
      continue;
    }
    return current;
  }
  throw new Error("抖音主页分享链接跳转次数过多");
}

class DouyinLoginRequiredError extends Error {
  constructor(creatorName, partialVideos) {
    super(
      `抖音访客模式只返回了 ${partialVideos.length} 个作品；登录应用内的隔离抖音会话后才能继续加载 ${creatorName} 的全部作品`,
    );
    this.name = "DouyinLoginRequiredError";
    this.code = "DOUYIN_LOGIN_REQUIRED";
    this.partialVideos = partialVideos;
  }
}

class DouyinLocalSource {
  constructor({
    partition = "persist:vibecoder-douyin-public",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    creatorTimeoutMs = DEFAULT_CREATOR_TIMEOUT_MS,
  } = {}) {
    this.partition = partition;
    this.timeoutMs = timeoutMs;
    this.creatorTimeoutMs = creatorTimeoutMs;
    this.operation = Promise.resolve();
    this.catalogOperation = Promise.resolve();
    this.windows = new Set();
    this.loginWindow = null;
  }

  runSerially(task) {
    const result = this.operation.then(task, task);
    this.operation = result.catch(() => undefined);
    return result;
  }

  runCatalogSerially(task) {
    const result = this.catalogOperation.then(task, task);
    this.catalogOperation = result.catch(() => undefined);
    return result;
  }

  async createPage() {
    const resolverSession = session.fromPartition(this.partition);
    resolverSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );

    const userAgent = resolverSession
      .getUserAgent()
      .replace(/\sElectron\/[\d.]+/, "")
      .replace(/\sVibeCoder[^/]*\/[\d.]+/, "");

    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.windows.add(window);

    window.webContents.setUserAgent(userAgent);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadURL("data:text/html,<title>resolver</title>");

    return { window, userAgent };
  }

  async isAuthenticated() {
    const cookies = await session
      .fromPartition(this.partition)
      .cookies.get({ url: "https://www.douyin.com/" });
    return cookies.some((cookie) => LOGIN_COOKIE_NAMES.has(cookie.name));
  }

  async openLoginWindow() {
    if (await this.isAuthenticated()) return { authenticated: true };
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.show();
      this.loginWindow.focus();
      return { authenticated: false, opened: true };
    }

    const resolverSession = session.fromPartition(this.partition);
    resolverSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    const userAgent = resolverSession
      .getUserAgent()
      .replace(/\sElectron\/[\d.]+/, "")
      .replace(/\sVibeCoder[^/]*\/[\d.]+/, "");
    const loginWindow = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      title: "登录抖音 · VibeCoder 加油站",
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.loginWindow = loginWindow;
    loginWindow.webContents.setUserAgent(userAgent);
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    loginWindow.once("ready-to-show", () => loginWindow.show());

    return new Promise((resolve) => {
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        clearInterval(statusTimer);
        const authenticated = await this.isAuthenticated().catch(
          () => false,
        );
        if (authenticated && !loginWindow.isDestroyed()) {
          loginWindow.destroy();
        }
        if (this.loginWindow === loginWindow) this.loginWindow = null;
        resolve({ authenticated });
      };
      const statusTimer = setInterval(async () => {
        if (await this.isAuthenticated().catch(() => false)) finish();
      }, 1_500);

      loginWindow.on("closed", finish);
      loginWindow
        .loadURL("https://www.douyin.com/", { userAgent })
        .catch(() => undefined);
    });
  }

  async resolveCreatorProfile(input) {
    return this.runCatalogSerially(async () => {
      const parsedInput = extractProfileInput(input);
      const resolverSession = session.fromPartition(this.partition);
      const userAgent = resolverSession
        .getUserAgent()
        .replace(/\sElectron\/[\d.]+/, "")
        .replace(/\sVibeCoder[^/]*\/[\d.]+/, "");
      let secUid = parsedInput.secUid;
      let shareUrl = parsedInput.shareUrl;

      if (!secUid && shareUrl) {
        const finalUrl = await followDouyinRedirects(
          shareUrl,
          userAgent,
          this.timeoutMs,
        );
        const match = finalUrl.pathname.match(
          /^\/(?:share\/)?user\/([^/?#]+)/,
        );
        if (!match) {
          throw new Error("这个分享链接没有跳转到抖音博主主页");
        }
        secUid = decodeURIComponent(match[1]);
      }

      if (!/^MS4wLjAB[A-Za-z0-9_-]+$/.test(secUid ?? "")) {
        throw new Error("没有从主页链接中识别出有效的博主 ID");
      }

      const { window, userAgent: pageUserAgent } = await this.createPage();
      try {
        await Promise.race([
          window
            .loadURL(
              `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
              { userAgent: pageUserAgent },
            )
            .catch(() => undefined),
          wait(this.timeoutMs),
        ]);
        await wait(2_000);
        const title = window.getTitle();
        const name =
          title
            .replace(/\s*的抖音\s*-\s*抖音\s*$/u, "")
            .replace(/\s*-\s*抖音\s*$/u, "")
            .trim();
        return {
          name: !name || name === "resolver" ? "抖音博主" : name,
          secUid,
          shareUrl:
            shareUrl ??
            `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
        };
      } finally {
        if (!window.isDestroyed()) window.destroy();
        this.windows.delete(window);
      }
    });
  }

  async loadVideoDetail(videoId) {
    return this.runSerially(async () => {
      const id = assertVideoId(videoId);
      const { window, userAgent } = await this.createPage();
      const debuggerApi = window.webContents.debugger;
      let settled = false;
      let resolveDetail;
      const detailPromise = new Promise((resolve) => {
        resolveDetail = resolve;
      });
      const interestingRequests = new Set();

      const onMessage = async (_event, method, params) => {
        if (
          method === "Network.responseReceived" &&
          params.response.url.includes(DETAIL_API_PATH)
        ) {
          interestingRequests.add(params.requestId);
        }

        if (
          method === "Network.loadingFinished" &&
          interestingRequests.has(params.requestId)
        ) {
          try {
            const body = await debuggerApi.sendCommand(
              "Network.getResponseBody",
              { requestId: params.requestId },
            );
            const decoded = body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body;
            const response = JSON.parse(decoded);
            if (response?.aweme_detail && !settled) {
              settled = true;
              resolveDetail(response.aweme_detail);
            }
          } catch (error) {
            // Douyin may repeat the request and occasionally expose an empty
            // body for one copy. Wait for the next valid response.
          }
        }
      };

      try {
        debuggerApi.attach("1.3");
        await debuggerApi.sendCommand("Network.enable");
        debuggerApi.on("message", onMessage);

        const targetUrl = `https://www.douyin.com/video/${id}`;
        window
          .loadURL(targetUrl, { userAgent })
          .catch(() => undefined);

        return await withTimeout(
          detailPromise,
          this.timeoutMs,
          `解析抖音作品 ${id} 超时`,
        );
      } finally {
        debuggerApi.removeListener("message", onMessage);
        if (debuggerApi.isAttached()) debuggerApi.detach();
        if (!window.isDestroyed()) window.destroy();
        this.windows.delete(window);
      }
    });
  }

  async fetchCreatorVideos(creator) {
    return this.runCatalogSerially(async () => {
      if (!creator?.secUid) throw new Error("博主配置缺少 secUid");

      const { window, userAgent } = await this.createPage();
      const discovered = new Map();

      try {
        await Promise.race([
          window
            .loadURL(
              `https://www.douyin.com/user/${encodeURIComponent(
                creator.secUid,
              )}`,
              { userAgent },
            )
            .catch(() => undefined),
          wait(20_000),
        ]);
        await wait(CATALOG_SESSION_WARMUP_MS);

        const startedAt = Date.now();
        let cursor = "0";
        let loginRequired = false;

        for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber += 1) {
          if (Date.now() - startedAt > this.creatorTimeoutMs) {
            throw new Error(
              `检查博主 ${creator.name ?? creator.secUid} 更新超时`,
            );
          }

          const page = await window.webContents.executeJavaScript(
            `(async () => {
              const url =
                "https://www.douyin.com/aweme/v1/web/aweme/post/?" +
                new URLSearchParams({
                  device_platform: "webapp",
                  aid: "6383",
                  channel: "channel_pc_web",
                  sec_user_id: ${JSON.stringify(creator.secUid)},
                  max_cursor: ${JSON.stringify(cursor)},
                  count: "18",
                });
              const response = await fetch(url, { credentials: "include" });
              const data = await response.json();
              return {
                statusCode: data.status_code,
                hasMore:
                  Object.prototype.hasOwnProperty.call(data, "has_more")
                    ? Boolean(data.has_more)
                    : null,
                nextCursor:
                  data.max_cursor === undefined ||
                  data.max_cursor === null
                    ? null
                    : String(data.max_cursor),
                loginRequired: Boolean(
                  data.not_login_module?.guide_login_tip_exist,
                ),
                videos: (data.aweme_list || []).map((aweme) => ({
                  id: String(aweme.aweme_id || ""),
                  title: aweme.desc || "",
                  authorId: aweme.author?.sec_uid || "",
                  authorName: aweme.author?.nickname || "",
                  createTime: aweme.create_time || null,
                  kind:
                    Number(aweme.aweme_type) === 68 ||
                    (Array.isArray(aweme.images) && aweme.images.length > 0)
                      ? "image"
                      : "video",
                  imageCount: Array.isArray(aweme.images)
                    ? aweme.images.length
                    : 0,
                })),
              };
            })()`,
            true,
          );

          loginRequired ||= page.loginRequired;
          for (const video of page.videos ?? []) {
            if (!/^\d{10,24}$/.test(video.id)) continue;
            if (video.authorId && video.authorId !== creator.secUid) continue;
            discovered.set(video.id, {
              id: video.id,
              url: `https://www.douyin.com/video/${video.id}`,
              title: video.title,
              authorName: video.authorName,
              kind: video.kind,
              imageCount: video.imageCount,
              publishedAt: video.createTime
                ? new Date(video.createTime * 1_000).toISOString()
                : null,
            });
          }

          if (page.hasMore === false) return [...discovered.values()];
          if (
            page.hasMore === null ||
            !page.nextCursor ||
            page.nextCursor === cursor
          ) {
            if (loginRequired || !(await this.isAuthenticated())) {
              throw new DouyinLoginRequiredError(
                creator.name ?? creator.secUid,
                [...discovered.values()],
              );
            }
            throw new Error(
              `博主 ${creator.name ?? creator.secUid} 的分页响应不完整；已发现 ${discovered.size} 个作品`,
            );
          }

          cursor = page.nextCursor;
          await wait(CATALOG_PAGE_DELAY_MS);
        }

        throw new Error(
          `博主 ${creator.name ?? creator.secUid} 的作品页数超过安全上限`,
        );
      } finally {
        if (!window.isDestroyed()) window.destroy();
        this.windows.delete(window);
      }
    });
  }

  async resolve(videoId) {
    const aweme = await this.loadVideoDetail(videoId);
    const headers = {
      Referer: "https://www.douyin.com/",
    };
    const common = {
      id: aweme.aweme_id,
      title: aweme.desc ?? "",
      authorName: aweme.author?.nickname ?? "",
      authorId: aweme.author?.sec_uid ?? "",
      publishedAt: aweme.create_time
        ? new Date(aweme.create_time * 1_000).toISOString()
        : null,
    };

    if (isImagePost(aweme)) {
      const imageUrls = getImageUrls(aweme);
      const musicUrl = getMusicUrl(aweme);
      if (!imageUrls.length) {
        throw new Error(`图文作品 ${videoId} 没有可显示的图片`);
      }
      if (!musicUrl) {
        throw new Error(`图文作品 ${videoId} 没有可播放的原声`);
      }

      const imageMedia = imageUrls.map((url) => ({
        url,
        mimeType: "image/webp",
        expiresAt: inferExpiry(url),
        headers,
      }));

      return {
        ...common,
        kind: "image",
        durationMs:
          Number(aweme?.music?.duration ?? aweme?.music?.audition_duration) *
            1_000 || null,
        media: {
          url: musicUrl,
          mimeType: "audio/mpeg",
          expiresAt: inferExpiry(musicUrl),
          headers,
        },
        imageMedia,
        posterMedia: imageMedia[0],
      };
    }

    const mediaUrl = getPlayUrl(aweme);
    if (!mediaUrl) {
      throw new Error(`作品 ${videoId} 没有可播放的公开 MP4 地址`);
    }

    const coverUrl = firstHttpsUrl(aweme?.video?.cover?.url_list);
    return {
      ...common,
      kind: "video",
      media: {
        url: mediaUrl,
        mimeType: "video/mp4",
        expiresAt: inferExpiry(mediaUrl),
        headers,
      },
      posterMedia: coverUrl
        ? {
            url: coverUrl,
            mimeType: "image/jpeg",
            expiresAt: Date.now() + MEDIA_FALLBACK_TTL_MS,
            headers,
          }
        : null,
    };
  }
}

module.exports = {
  DouyinLocalSource,
  DouyinLoginRequiredError,
  assertVideoId,
  extractProfileInput,
  getImageUrls,
  getMusicUrl,
  inferExpiry,
  isImagePost,
  uniqueVideoLinks,
};
