const { BrowserWindow, session } = require("electron");
const https = require("node:https");

const DETAIL_API_PATH = "/aweme/v1/web/aweme/detail";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CREATOR_TIMEOUT_MS = 120_000;
const CATALOG_SESSION_WARMUP_MS = 6_000;
const CATALOG_REQUEST_TIMEOUT_MS = 12_000;
const CATALOG_REQUEST_DELAY_MIN_MS = 4_000;
const CATALOG_REQUEST_DELAY_MAX_MS = 8_000;
const CATALOG_CREATOR_DELAY_MS = 2_000;
const CATALOG_BATCH_CONCURRENCY = 4;
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

function randomCatalogDelay() {
  return Math.round(
    CATALOG_REQUEST_DELAY_MIN_MS +
      Math.random() *
        (CATALOG_REQUEST_DELAY_MAX_MS - CATALOG_REQUEST_DELAY_MIN_MS),
  );
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

function catalogResult(
  videos,
  { complete = false, reachedKnown = false, truncated = false } = {},
) {
  Object.defineProperties(videos, {
    complete: {
      value: Boolean(complete),
      enumerable: false,
    },
    reachedKnown: {
      value: Boolean(reachedKnown),
      enumerable: false,
    },
    truncated: {
      value: Boolean(truncated),
      enumerable: false,
    },
  });
  return videos;
}

function normalizeCatalogVideos(videos, creator) {
  const discovered = new Map();

  for (const video of videos ?? []) {
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

  return discovered;
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

class DouyinCatalogRequestError extends Error {
  constructor(
    message,
    {
      errorKind = "request_error",
      httpStatus = null,
      retryAfterMs = null,
      throttled = false,
      verificationRequired = false,
      verificationAvailable = false,
    } = {},
  ) {
    super(message);
    this.name = "DouyinCatalogRequestError";
    this.code = verificationRequired
      ? "DOUYIN_HUMAN_VERIFICATION"
      : throttled
        ? "DOUYIN_RATE_LIMITED"
        : "DOUYIN_CATALOG_REQUEST_FAILED";
    this.errorKind = errorKind;
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
    this.retryAfterMs = Number.isFinite(Number(retryAfterMs))
      ? Math.max(0, Number(retryAfterMs))
      : null;
    this.throttled = Boolean(throttled);
    this.verificationRequired = Boolean(verificationRequired);
    this.verificationAvailable = Boolean(
      verificationAvailable || verificationRequired,
    );
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
    this.catalogPagePromise = null;
    this.preferProfileCatalog = false;
    this.windows = new Set();
    this.loginWindow = null;
    this.verificationPromise = null;
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

  async createPage({ backgroundThrottling = false } = {}) {
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
        backgroundThrottling,
      },
    });
    this.windows.add(window);

    window.webContents.setUserAgent(userAgent);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadURL("data:text/html,<title>resolver</title>");

    return { window, userAgent };
  }

  async getCatalogPage(creator) {
    if (this.catalogPagePromise) {
      const existing = await this.catalogPagePromise;
      if (!existing.window.isDestroyed()) return existing;
      this.catalogPagePromise = null;
    }

    this.catalogPagePromise = (async () => {
      const page = await this.createPage({
        backgroundThrottling: true,
      });
      try {
        await Promise.race([
          page.window
            .loadURL(
              `https://www.douyin.com/user/${encodeURIComponent(
                creator.secUid,
              )}`,
              { userAgent: page.userAgent },
            )
            .catch(() => undefined),
          wait(20_000),
        ]);
        await wait(CATALOG_SESSION_WARMUP_MS);
        page.window.once("closed", () => {
          this.windows.delete(page.window);
          this.catalogPagePromise = null;
        });
        return page;
      } catch (error) {
        if (!page.window.isDestroyed()) page.window.destroy();
        this.windows.delete(page.window);
        this.catalogPagePromise = null;
        throw error;
      }
    })();

    return this.catalogPagePromise;
  }

  async detectHumanVerification(pageContext) {
    const window = pageContext?.window;
    if (!window || window.isDestroyed()) {
      return { required: false, available: false, reason: null };
    }

    try {
      const result = await withTimeout(
        window.webContents.executeJavaScript(
          `(() => {
            const isVisible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || 1) > 0 &&
                rect.width >= 80 &&
                rect.height >= 40
              );
            };
            const urlPattern =
              /(rc-verifycenter|verifycenter|rmc-nocaptcha|\\/captcha\\/|verify\\.snssdk|secsdk-captcha)/i;
            const frames = [...document.querySelectorAll("iframe[src]")];
            const challengeFrame = frames.find((frame) =>
              urlPattern.test(frame.src),
            );
            const visibleChallengeFrame = frames.find(
              (frame) => isVisible(frame) && urlPattern.test(frame.src),
            );
            const challengeUrl = [location.href].find((url) =>
              urlPattern.test(url),
            );
            const challengeElements = [
              ...document.querySelectorAll(
                '[class*="captcha" i], [id*="captcha" i], ' +
                '[class*="verify" i], [id*="verify" i]',
              ),
            ].filter(isVisible);
            const challengeText = challengeElements
              .map((element) =>
                (
                  element.innerText ||
                  element.getAttribute("aria-label") ||
                  ""
                ).trim(),
              )
              .join(" ")
              .slice(0, 2_000);
            const textChallenge =
              /(请完成.{0,8}验证|安全验证|真人验证|拖动.{0,8}滑块|按住.{0,8}滑块|验证后继续)/u.test(
                challengeText,
              );
            return {
              required: Boolean(
                challengeUrl || visibleChallengeFrame || textChallenge,
              ),
              available: Boolean(
                challengeUrl || challengeFrame || textChallenge,
              ),
              reason:
                challengeUrl || visibleChallengeFrame
                  ? "challenge_frame"
                  : textChallenge
                    ? "challenge_text"
                    : challengeFrame
                      ? "challenge_frame_hidden"
                      : null,
              challengeUrl:
                challengeUrl ||
                visibleChallengeFrame?.src ||
                challengeFrame?.src ||
                null,
            };
          })()`,
          true,
        ),
        4_000,
        "检测抖音真人验证超时",
      );
      return {
        required: Boolean(result?.required),
        available: Boolean(result?.available),
        reason: result?.reason ?? null,
        challengeUrl: result?.challengeUrl ?? null,
      };
    } catch {
      return {
        required: false,
        available: false,
        reason: null,
        challengeUrl: null,
      };
    }
  }

  async recoverCatalogServiceError(pageContext) {
    const window = pageContext?.window;
    if (!window || window.isDestroyed()) {
      return { found: false, refreshed: false };
    }

    try {
      const result = await withTimeout(
        window.webContents.executeJavaScript(
          `(() => {
            const isVisible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || 1) > 0 &&
                rect.width > 0 &&
                rect.height > 0
              );
            };
            const serviceError = [...document.querySelectorAll("div, p")]
              .filter((element) => {
                const text = (element.textContent || "").trim();
                return (
                  isVisible(element) &&
                  /服务异常/.test(text) &&
                  /刷新/.test(text)
                );
              })
              .sort(
                (left, right) =>
                  left.textContent.trim().length -
                  right.textContent.trim().length,
              )[0];
            if (!serviceError) {
              return { found: false, refreshed: false };
            }
            const refreshControl = [
              ...serviceError.querySelectorAll(
                'button, [role="button"], a, span',
              ),
            ].find(
              (element) =>
                isVisible(element) &&
                (element.textContent || "").trim() === "刷新",
            );
            (refreshControl || serviceError).click();
            return { found: true, refreshed: true };
          })()`,
          true,
        ),
        4_000,
        "恢复抖音服务异常页面超时",
      );
      return {
        found: Boolean(result?.found),
        refreshed: Boolean(result?.refreshed),
      };
    } catch {
      return { found: false, refreshed: false };
    }
  }

  isVerificationWindowOpen() {
    if (!this.catalogPagePromise) return false;
    return this.catalogPagePromise
      .then(
        ({ window }) =>
          !window.isDestroyed() && window.isVisible(),
        () => false,
      );
  }

  async openVerificationWindow(creator, { force = false } = {}) {
    if (!creator?.secUid) {
      return { completed: false, verificationRequired: true };
    }
    if (this.verificationPromise) {
      const page = await this.catalogPagePromise?.catch(() => null);
      if (page?.window && !page.window.isDestroyed()) {
        page.window.show();
        page.window.focus();
      }
      return this.verificationPromise;
    }

    const pageContext = await this.getCatalogPage(creator);
    const { window } = pageContext;
    let initialStatus = await this.detectHumanVerification(pageContext);
    if (!initialStatus.required && force) {
      if (
        !window.isVisible() &&
        !window.webContents.getURL().includes(creator.secUid)
      ) {
        await Promise.race([
          window
            .loadURL(
              `https://www.douyin.com/user/${encodeURIComponent(
                creator.secUid,
              )}`,
              { userAgent: pageContext.userAgent },
            )
            .catch(() => undefined),
          wait(20_000),
        ]);
        await wait(CATALOG_SESSION_WARMUP_MS);
        initialStatus =
          await this.detectHumanVerification(pageContext);
      }
      if (!initialStatus.required) {
        const recovery =
          await this.recoverCatalogServiceError(pageContext);
        if (recovery.refreshed) await wait(800);
        window.setMinimumSize(760, 620);
        window.setTitle("检查抖音状态 · VibeCoder 加油站");
        window.show();
        window.focus();
        return {
          completed: false,
          verificationRequired: false,
          inspectionOpened: true,
        };
      }
    }
    if (!initialStatus.required && !force) {
      return { completed: true, verificationRequired: false };
    }

    window.setMinimumSize(760, 620);
    window.setTitle("完成抖音真人验证 · VibeCoder 加油站");
    window.show();
    window.focus();

    const promise = new Promise((resolve) => {
      let settled = false;
      let clearChecks = 0;
      let checking = false;
      let challengeSeen = initialStatus.required;
      const finish = (completed) => {
        if (settled) return;
        settled = true;
        clearInterval(statusTimer);
        window.removeListener("closed", onClosed);
        if (completed && !window.isDestroyed()) window.hide();
        resolve({
          completed,
          verificationRequired: !completed,
        });
      };
      const onClosed = () => finish(false);
      const check = async () => {
        if (checking) return;
        if (window.isDestroyed()) {
          finish(false);
          return;
        }
        checking = true;
        try {
          const status = await this.detectHumanVerification(pageContext);
          if (status.required) {
            challengeSeen = true;
            clearChecks = 0;
          } else if (challengeSeen) {
            clearChecks += 1;
            if (clearChecks >= 2) finish(true);
          }
        } finally {
          checking = false;
        }
      };
      const statusTimer = setInterval(check, 1_000);
      window.once("closed", onClosed);
      statusTimer.unref();
    });
    this.verificationPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.verificationPromise === promise) {
        this.verificationPromise = null;
      }
    }
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

  async fetchCreatorVideos(
    creator,
    {
      maxPages = MAX_CATALOG_PAGES,
      stopAfterId = null,
    } = {},
  ) {
    return this.runCatalogSerially(async () => {
      if (!creator?.secUid) throw new Error("博主配置缺少 secUid");

      const pageLimit = Math.max(
        1,
        Math.min(MAX_CATALOG_PAGES, Number(maxPages) || 1),
      );
      const knownId = /^\d{10,24}$/.test(String(stopAfterId ?? ""))
        ? String(stopAfterId)
        : null;
      const { window } = await this.getCatalogPage(creator);
      const discovered = new Map();
      const startedAt = Date.now();
      let cursor = "0";
      let loginRequired = false;

      for (let pageNumber = 0; pageNumber < pageLimit; pageNumber += 1) {
        if (Date.now() - startedAt > this.creatorTimeoutMs) {
          throw new Error(
            `检查博主 ${creator.name ?? creator.secUid} 更新超时`,
          );
        }

        const responsePage = await withTimeout(
          window.webContents.executeJavaScript(
          `(async () => {
              const controller = new AbortController();
              const timeout = setTimeout(
                () => controller.abort(),
                ${CATALOG_REQUEST_TIMEOUT_MS},
              );
              try {
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
              const response = await fetch(url, {
                credentials: "include",
                signal: controller.signal,
              });
              const retryAfterHeader = response.headers.get("retry-after");
              const retryAfterSeconds = Number(retryAfterHeader);
              const retryAfterMs = Number.isFinite(retryAfterSeconds)
                ? Math.max(0, retryAfterSeconds * 1_000)
                : null;
              if (response.status === 403 || response.status === 429) {
                return {
                  error: "抖音暂时限制了目录请求",
                  errorKind: "rate_limit",
                  httpStatus: response.status,
                  retryAfterMs,
                  throttled: true,
                };
              }
              if (!response.ok) {
                return {
                  error: "抖音目录接口 HTTP " + response.status,
                  errorKind:
                    response.status === 401
                      ? "authentication"
                      : "http_error",
                  httpStatus: response.status,
                  retryAfterMs,
                  loginRequired: response.status === 401,
                  throttled: false,
                };
              }
              const responseText = await response.text();
              if (!responseText.trim()) {
                return {
                  error: "抖音目录接口返回空响应",
                  errorKind: "empty_response",
                  httpStatus: response.status,
                  retryAfterMs,
                  throttled: true,
                };
              }
              let data;
              try {
                data = JSON.parse(responseText);
              } catch {
                return {
                  error: "抖音目录响应无法解析",
                  errorKind: "invalid_response",
                  httpStatus: response.status,
                  retryAfterMs,
                  throttled: true,
                };
              }
              return {
                attempted: true,
                httpStatus: response.status,
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
              } finally {
                clearTimeout(timeout);
              }
            })()`,
            true,
          ),
          CATALOG_REQUEST_TIMEOUT_MS + 2_000,
          `读取博主 ${creator.name ?? creator.secUid} 的作品超时`,
        );

        if (responsePage.error) {
          const verification =
            await this.detectHumanVerification({ window });
          if (verification.required) {
            throw new DouyinCatalogRequestError(
              "抖音需要先完成人机验证",
              {
                errorKind: "human_verification",
                httpStatus: responsePage.httpStatus,
                throttled: true,
                verificationRequired: true,
                verificationAvailable: true,
              },
            );
          }
          if (responsePage.loginRequired) {
            throw new DouyinLoginRequiredError(
              creator.name ?? creator.secUid,
              [...discovered.values()],
            );
          }
          throw new DouyinCatalogRequestError(responsePage.error, {
            errorKind: responsePage.errorKind,
            httpStatus: responsePage.httpStatus,
            retryAfterMs: responsePage.retryAfterMs,
            throttled: responsePage.throttled,
            verificationAvailable: verification.available,
          });
        }
        loginRequired ||= responsePage.loginRequired;
        if (
          Number.isFinite(Number(responsePage.statusCode)) &&
          Number(responsePage.statusCode) !== 0 &&
          !responsePage.loginRequired
        ) {
          throw new DouyinCatalogRequestError(
            `抖音目录接口状态异常：${responsePage.statusCode}`,
            {
              errorKind: "api_status",
              httpStatus: responsePage.httpStatus,
              throttled: true,
            },
          );
        }
        for (const [id, video] of normalizeCatalogVideos(
          responsePage.videos,
          creator,
        )) {
          discovered.set(id, video);
        }

        if (responsePage.hasMore === false) {
          await wait(CATALOG_CREATOR_DELAY_MS);
          return catalogResult([...discovered.values()], {
            complete: true,
          });
        }
        if (knownId && discovered.has(knownId)) {
          await wait(CATALOG_CREATOR_DELAY_MS);
          return catalogResult([...discovered.values()], {
            reachedKnown: true,
          });
        }
        if (
          responsePage.hasMore === null ||
          !responsePage.nextCursor ||
          responsePage.nextCursor === cursor
        ) {
          if (!loginRequired && discovered.size === 0) {
            throw new DouyinCatalogRequestError(
              "抖音返回的目录响应不完整",
              {
                errorKind: "invalid_response",
                httpStatus: responsePage.httpStatus,
                throttled: true,
              },
            );
          }
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

        cursor = responsePage.nextCursor;
        await wait(randomCatalogDelay());
      }

      if (pageLimit < MAX_CATALOG_PAGES) {
        await wait(CATALOG_CREATOR_DELAY_MS);
        return catalogResult([...discovered.values()], {
          truncated: true,
        });
      }

      throw new Error(
        `博主 ${creator.name ?? creator.secUid} 的作品页数超过安全上限`,
      );
    });
  }

  async fetchCreatorProfilePageVideos(creator, pageContext) {
    const { window, userAgent } = pageContext;
    const targetUrl =
      `https://www.douyin.com/user/${encodeURIComponent(creator.secUid)}`;
    const currentUrl = window.webContents.getURL();
    if (!currentUrl.includes(creator.secUid)) {
      await Promise.race([
        window
          .loadURL(targetUrl, { userAgent })
          .catch(() => undefined),
        wait(20_000),
      ]);
      await wait(CATALOG_SESSION_WARMUP_MS);
    } else {
      await wait(1_000);
    }

    const verification =
      await this.detectHumanVerification(pageContext);
    if (verification.required) {
      return {
        creator,
        videos: catalogResult([]),
        error: "抖音需要先完成人机验证",
        errorKind: "human_verification",
        httpStatus: null,
        retryAfterMs: null,
        attempted: true,
        loginRequired: false,
        throttled: true,
        verificationRequired: true,
        verificationAvailable: true,
        transport: "profile_page",
      };
    }
    const recovery =
      await this.recoverCatalogServiceError(pageContext);
    if (recovery.refreshed) await wait(800);

    const pageResult = await withTimeout(
      window.webContents.executeJavaScript(
        `(() => {
          const videos = [];
          const seen = new Set();
          for (const anchor of document.querySelectorAll("a[href]")) {
            let parsed;
            try {
              parsed = new URL(anchor.href, location.href);
            } catch {
              continue;
            }
            const match = parsed.pathname.match(
              /^\\/(video|note)\\/(\\d{10,24})/,
            );
            if (!match || seen.has(match[2])) continue;
            seen.add(match[2]);
            const image = anchor.querySelector("img");
            const paragraph = anchor.querySelector("p");
            videos.push({
              id: match[2],
              title:
                image?.getAttribute("alt") ||
                paragraph?.textContent?.trim() ||
                anchor.getAttribute("aria-label") ||
                "",
              authorId: ${JSON.stringify(creator.secUid)},
              authorName: document.title
                .replace(/\\s*的抖音\\s*-\\s*抖音\\s*$/u, "")
                .replace(/\\s*-\\s*抖音\\s*$/u, "")
                .trim(),
              createTime: null,
              kind: match[1] === "note" ? "image" : "video",
              imageCount: match[1] === "note" ? null : 0,
            });
          }
          return {
            pageUrl: location.href,
            pageTitle: document.title,
            videos,
          };
        })()`,
        true,
      ),
      CATALOG_REQUEST_TIMEOUT_MS,
      `读取 ${creator.name ?? creator.secUid} 的主页作品超时`,
    );

    const videos = [
      ...normalizeCatalogVideos(pageResult.videos, creator).values(),
    ];
    if (!videos.length) {
      return {
        creator,
        videos: catalogResult([]),
        error: "抖音主页没有返回可读取的作品",
        errorKind: "profile_page_empty",
        httpStatus: null,
        retryAfterMs: null,
        attempted: true,
        loginRequired: false,
        throttled: true,
        verificationAvailable: verification.available,
        transport: "profile_page",
      };
    }

    return {
      creator,
      videos: catalogResult(videos, { truncated: true }),
      error: null,
      errorKind: null,
      httpStatus: null,
      retryAfterMs: null,
      attempted: true,
      loginRequired: false,
      throttled: false,
      transport: "profile_page",
    };
  }

  async fetchCreatorProfileBatch(creators, pageContext, fallbackResults = []) {
    const results = [];
    let throttledResult = null;

    for (let index = 0; index < creators.length; index += 1) {
      const creator = creators[index];
      if (throttledResult) {
        results.push({
          creator,
          videos: catalogResult([]),
          error: throttledResult.error,
          errorKind: throttledResult.errorKind,
          httpStatus: throttledResult.httpStatus,
          retryAfterMs: throttledResult.retryAfterMs,
          attempted: false,
          loginRequired: false,
          throttled: true,
          verificationRequired:
            Boolean(throttledResult.verificationRequired),
          verificationAvailable:
            Boolean(throttledResult.verificationAvailable),
          transport: "profile_page",
        });
        continue;
      }

      try {
        const result = await this.fetchCreatorProfilePageVideos(
          creator,
          pageContext,
        );
        const fallback = fallbackResults[index];
        results.push({
          ...result,
          fallbackReason: fallback?.errorKind ?? null,
        });
        if (result.throttled) throttledResult = result;
      } catch (error) {
        const result = {
          creator,
          videos: catalogResult([]),
          error: error?.message ?? String(error),
          errorKind: "profile_page_error",
          httpStatus: null,
          retryAfterMs: null,
          attempted: true,
          loginRequired: false,
          throttled: true,
          verificationRequired: Boolean(error?.verificationRequired),
          verificationAvailable:
            Boolean(error?.verificationAvailable),
          transport: "profile_page",
        };
        results.push(result);
        throttledResult = result;
      }

      if (!throttledResult && index + 1 < creators.length) {
        await wait(randomCatalogDelay());
      }
    }

    return results;
  }

  async fetchCreatorLatestBatch(
    creators,
    {
      stopAfterIds = {},
      concurrency = CATALOG_BATCH_CONCURRENCY,
      preferProfile = false,
    } = {},
  ) {
    return this.runCatalogSerially(async () => {
      const validCreators = (creators ?? []).filter(
        (creator) => creator?.secUid,
      );
      if (!validCreators.length) return [];

      const workerCount = Math.max(
        1,
        Math.min(
          CATALOG_BATCH_CONCURRENCY,
          Number(concurrency) || 1,
          validCreators.length,
        ),
      );
      const requests = validCreators.map((creator) => ({
        secUid: creator.secUid,
        knownId: /^\d{10,24}$/.test(
          String(stopAfterIds[creator.secUid] ?? ""),
        )
          ? String(stopAfterIds[creator.secUid])
          : null,
      }));
      const pageContext = await this.getCatalogPage(validCreators[0]);
      const { window } = pageContext;
      if (preferProfile || this.preferProfileCatalog) {
        this.preferProfileCatalog = true;
        return this.fetchCreatorProfileBatch(
          validCreators,
          pageContext,
        );
      }
      const requestBudget =
        Math.ceil(requests.length / workerCount) *
          (CATALOG_REQUEST_TIMEOUT_MS +
            CATALOG_REQUEST_DELAY_MAX_MS) +
        3_000;

      const responsePages = await withTimeout(
        window.webContents.executeJavaScript(
          `(async () => {
            const requests = ${JSON.stringify(requests)};
            const results = new Array(requests.length);
            let nextIndex = 0;
            let throttledResult = null;

            const fetchOne = async (request) => {
              const controller = new AbortController();
              const timeout = setTimeout(
                () => controller.abort(),
                ${CATALOG_REQUEST_TIMEOUT_MS},
              );
              try {
                const url =
                  "https://www.douyin.com/aweme/v1/web/aweme/post/?" +
                  new URLSearchParams({
                    device_platform: "webapp",
                    aid: "6383",
                    channel: "channel_pc_web",
                    sec_user_id: request.secUid,
                    max_cursor: "0",
                    count: "18",
                  });
                const response = await fetch(url, {
                  credentials: "include",
                  signal: controller.signal,
                });
                const retryAfterHeader =
                  response.headers.get("retry-after");
                const retryAfterSeconds = Number(retryAfterHeader);
                const retryAfterMs = Number.isFinite(retryAfterSeconds)
                  ? Math.max(0, retryAfterSeconds * 1_000)
                  : null;
                if (response.status === 403 || response.status === 429) {
                  return {
                    error: "抖音暂时限制了目录请求",
                    errorKind: "rate_limit",
                    httpStatus: response.status,
                    retryAfterMs,
                    throttled: true,
                    attempted: true,
                  };
                }
                if (!response.ok) {
                  return {
                    error: "抖音目录接口 HTTP " + response.status,
                    errorKind:
                      response.status === 401
                        ? "authentication"
                        : "http_error",
                    httpStatus: response.status,
                    retryAfterMs,
                    loginRequired: response.status === 401,
                    throttled: false,
                    attempted: true,
                  };
                }
                const responseText = await response.text();
                if (!responseText.trim()) {
                  return {
                    error: "抖音目录接口返回空响应",
                    errorKind: "empty_response",
                    httpStatus: response.status,
                    retryAfterMs,
                    throttled: true,
                    attempted: true,
                  };
                }
                let data;
                try {
                  data = JSON.parse(responseText);
                } catch {
                  return {
                    error: "抖音目录响应无法解析",
                    errorKind: "invalid_response",
                    httpStatus: response.status,
                    retryAfterMs,
                    throttled: true,
                    attempted: true,
                  };
                }
                return {
                  attempted: true,
                  httpStatus: response.status,
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
                      (Array.isArray(aweme.images) &&
                        aweme.images.length > 0)
                        ? "image"
                        : "video",
                    imageCount: Array.isArray(aweme.images)
                      ? aweme.images.length
                      : 0,
                  })),
                };
              } catch (error) {
                return {
                  error:
                    error?.name === "AbortError"
                      ? "请求超时"
                      : error?.message || String(error),
                  errorKind:
                    error?.name === "AbortError"
                      ? "timeout"
                      : "request_error",
                  attempted: true,
                  throttled: false,
                };
              } finally {
                clearTimeout(timeout);
              }
            };

            const worker = async () => {
              while (nextIndex < requests.length) {
                const index = nextIndex;
                nextIndex += 1;
                if (throttledResult) {
                  results[index] = {
                    error: throttledResult.error,
                    errorKind: throttledResult.errorKind,
                    httpStatus: throttledResult.httpStatus,
                    retryAfterMs: throttledResult.retryAfterMs,
                    throttled: true,
                    attempted: false,
                  };
                  continue;
                }
                const result = await fetchOne(requests[index]);
                results[index] = result;
                if (result.throttled) {
                  throttledResult = result;
                } else if (nextIndex < requests.length) {
                  const delay =
                    ${CATALOG_REQUEST_DELAY_MIN_MS} +
                    Math.round(
                      Math.random() *
                        ${
                          CATALOG_REQUEST_DELAY_MAX_MS -
                          CATALOG_REQUEST_DELAY_MIN_MS
                        },
                    );
                  await new Promise((resolve) =>
                    setTimeout(resolve, delay),
                  );
                }
              }
            };

            await Promise.all(
              Array.from(
                { length: ${workerCount} },
                () => worker(),
              ),
            );
            return results;
          })()`,
          true,
        ),
        requestBudget,
        "批量读取抖音博主作品超时",
      );

      const verification =
        await this.detectHumanVerification(pageContext);
      if (verification.required) {
        return validCreators.map((creator, index) => ({
          creator,
          videos: catalogResult([]),
          error: "抖音需要先完成人机验证",
          errorKind: "human_verification",
          httpStatus: null,
          retryAfterMs: null,
          attempted: index === 0,
          loginRequired: false,
          throttled: true,
          verificationRequired: true,
          verificationAvailable: true,
          transport: "profile_page",
        }));
      }

      const apiResults = validCreators.map((creator, index) => {
        const page = responsePages[index] ?? {};
        if (page.error) {
          return {
            creator,
            videos: catalogResult([]),
            error: page.error,
            errorKind: page.errorKind ?? "request_error",
            httpStatus: Number.isInteger(page.httpStatus)
              ? page.httpStatus
              : null,
            retryAfterMs: Number.isFinite(Number(page.retryAfterMs))
              ? Number(page.retryAfterMs)
              : null,
            attempted: page.attempted !== false,
            loginRequired: Boolean(page.loginRequired),
            throttled: Boolean(page.throttled),
            verificationRequired: false,
            verificationAvailable: verification.available,
          };
        }

        const videos = [
          ...normalizeCatalogVideos(page.videos, creator).values(),
        ];
        const knownId = requests[index].knownId;
        const reachedKnown = Boolean(
          knownId && videos.some((video) => video.id === knownId),
        );
        const complete = page.hasMore === false;
        const malformed =
          page.hasMore === null ||
          (page.hasMore && !page.nextCursor);
        const apiStatusError =
          Number.isFinite(Number(page.statusCode)) &&
          Number(page.statusCode) !== 0;
        const suspiciousEmpty =
          malformed &&
          !page.loginRequired &&
          videos.length === 0;
        const responseError = apiStatusError
          ? `抖音目录接口状态异常：${page.statusCode}`
          : malformed && !page.loginRequired
            ? "抖音返回的目录响应不完整"
            : null;

        return {
          creator,
          videos: catalogResult(videos, {
            complete,
            reachedKnown,
            truncated: !complete && !reachedKnown,
          }),
          error: responseError,
          errorKind:
            apiStatusError
              ? "api_status"
              : malformed && !page.loginRequired
                ? "invalid_response"
              : null,
          httpStatus: Number.isInteger(page.httpStatus)
            ? page.httpStatus
            : null,
          retryAfterMs: null,
          attempted: page.attempted !== false,
          loginRequired: Boolean(page.loginRequired),
          throttled: Boolean(
            page.throttled ||
              suspiciousEmpty ||
              (apiStatusError && !page.loginRequired),
          ),
          verificationRequired: false,
          verificationAvailable: verification.available,
        };
      });
      if (apiResults.some((result) => result.throttled)) {
        this.preferProfileCatalog = true;
        return this.fetchCreatorProfileBatch(
          validCreators,
          pageContext,
          apiResults,
        );
      }
      return apiResults;
    });
  }

  close() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.destroy();
    }
    this.loginWindow = null;
    this.verificationPromise = null;
    this.catalogPagePromise = null;
    for (const window of this.windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
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
