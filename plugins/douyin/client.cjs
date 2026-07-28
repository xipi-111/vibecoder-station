const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_POLL_MINUTES = 15;
const MAX_RECENT_ITEMS = 20;
const FAST_SYNC_CREATOR_THRESHOLD = 12;
const FAST_SYNC_PAGE_LIMIT = 1;
const FAST_SYNC_BATCH_SIZE = 2;
const FAST_SYNC_SLICE_DELAY_MIN_MS = 45_000;
const FAST_SYNC_SLICE_DELAY_MAX_MS = 75_000;
const FAST_SYNC_THROTTLE_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

function compareVideoIdsDescending(left, right) {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  if (leftId === rightId) return 0;
  return leftId > rightId ? -1 : 1;
}

function isVideoIdNewer(candidateId, referenceId) {
  if (!referenceId) return true;
  return BigInt(candidateId) > BigInt(referenceId);
}

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function emptyRateLimitState() {
  return {
    consecutiveFailures: 0,
    nextRetryAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastThrottleAt: null,
    lastErrorKind: null,
    lastHttpStatus: null,
    lastMessage: null,
    totalAttempts: 0,
    totalSuccesses: 0,
    totalThrottles: 0,
  };
}

function normalizeRateLimitState(value) {
  const fallback = emptyRateLimitState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const timestamp = (candidate) =>
    typeof candidate === "string" && Number.isFinite(Date.parse(candidate))
      ? candidate
      : null;
  const count = (candidate) =>
    Number.isInteger(candidate) && candidate >= 0 ? candidate : 0;
  return {
    consecutiveFailures: count(value.consecutiveFailures),
    nextRetryAt: timestamp(value.nextRetryAt),
    lastAttemptAt: timestamp(value.lastAttemptAt),
    lastSuccessAt: timestamp(value.lastSuccessAt),
    lastThrottleAt: timestamp(value.lastThrottleAt),
    lastErrorKind:
      typeof value.lastErrorKind === "string"
        ? value.lastErrorKind
        : null,
    lastHttpStatus: Number.isInteger(value.lastHttpStatus)
      ? value.lastHttpStatus
      : null,
    lastMessage:
      typeof value.lastMessage === "string" ? value.lastMessage : null,
    totalAttempts: count(value.totalAttempts),
    totalSuccesses: count(value.totalSuccesses),
    totalThrottles: count(value.totalThrottles),
  };
}

class LocalDouyinClient {
  constructor({
    source,
    config,
    configPath,
    userDataPath,
    now = () => Date.now(),
    random = Math.random,
  }) {
    this.source = source;
    this.config = config;
    this.configPath = configPath;
    this.statePath = path.join(userDataPath, "douyin-queue-state.json");
    this.now = now;
    this.random = random;
    this.items = new Map();
    this.state = {
      knownIds: [],
      pendingNewIds: [],
      recentIds: [],
      creatorHighWaterMarks: {},
      catalogCompleteCreatorIds: [],
      refreshCursor: 0,
      catalogTransport: "api",
      rateLimit: emptyRateLimitState(),
    };
    this.initialization = null;
    this.refreshPromise = null;
    this.pollTimer = null;
    this.sliceTimer = null;
    this.sliceTimerDueAt = null;
    this.authRequired = false;
    this.partialCount = 0;
    this.lastRefreshError = null;
    this.syncProcessed = 0;
    this.syncTotal = 0;

    for (const item of this.activeSeedVideos()) {
      this.items.set(item.id, { ...item, rank: Number.MAX_SAFE_INTEGER });
    }
  }

  get enabled() {
    return true;
  }

  activeSeedVideos() {
    const activeCreatorIds = new Set(
      (this.config.creators ?? []).map((creator) => creator.secUid),
    );
    return (this.config.seedVideos ?? []).filter(
      (item) => !item.authorId || activeCreatorIds.has(item.authorId),
    );
  }

  async saveConfig() {
    if (!this.configPath) return;
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(
      this.configPath,
      JSON.stringify(
        {
          pollIntervalMinutes: this.config.pollIntervalMinutes,
          creators: this.config.creators ?? [],
          seedVideos: this.config.seedVideos ?? [],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  async resetCatalog() {
    this.items.clear();
    for (const item of this.activeSeedVideos()) {
      this.items.set(item.id, { ...item, rank: Number.MAX_SAFE_INTEGER });
    }
    this.state = {
      knownIds: [],
      pendingNewIds: [],
      recentIds: [],
      creatorHighWaterMarks: {},
      catalogCompleteCreatorIds: [],
      refreshCursor: 0,
      catalogTransport:
        this.state.catalogTransport === "profile_page"
          ? "profile_page"
          : "api",
      rateLimit: normalizeRateLimitState(this.state.rateLimit),
    };
    this.authRequired = false;
    this.partialCount = 0;
    this.lastRefreshError = null;
    await this.saveState();
  }

  async loadState() {
    try {
      const stored = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      this.state = {
        knownIds: Array.isArray(stored.knownIds) ? stored.knownIds : [],
        pendingNewIds: Array.isArray(stored.pendingNewIds)
          ? stored.pendingNewIds
          : [],
        recentIds: Array.isArray(stored.recentIds) ? stored.recentIds : [],
        creatorHighWaterMarks:
          stored.creatorHighWaterMarks &&
          typeof stored.creatorHighWaterMarks === "object" &&
          !Array.isArray(stored.creatorHighWaterMarks)
            ? stored.creatorHighWaterMarks
            : {},
        catalogCompleteCreatorIds: Array.isArray(
          stored.catalogCompleteCreatorIds,
        )
          ? stored.catalogCompleteCreatorIds
          : [],
        refreshCursor: Number.isInteger(stored.refreshCursor)
          ? Math.max(0, stored.refreshCursor)
          : 0,
        catalogTransport:
          stored.catalogTransport === "profile_page"
            ? "profile_page"
            : "api",
        rateLimit: normalizeRateLimitState(stored.rateLimit),
      };

      for (const id of this.state.knownIds) {
        if (/^\d{10,24}$/.test(id) && !this.items.has(id)) {
          this.items.set(id, {
            id,
            shareUrl: `https://www.douyin.com/video/${id}`,
            rank: Number.MAX_SAFE_INTEGER,
          });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[douyin-queue] 无法读取状态，将使用新状态", error);
      }
    }
  }

  async saveState() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(
      this.statePath,
      JSON.stringify(this.state, null, 2),
      { mode: 0o600 },
    );
  }

  async initialize() {
    if (this.initialization) return this.initialization;

    this.initialization = (async () => {
      await this.loadState();

      const retryDelay = this.rateLimitDelayRemaining();
      if (retryDelay > 0) {
        this.scheduleSliceRefresh(retryDelay);
      } else {
        this.refresh().catch((error) => {
          console.warn(
            "[douyin-queue] 首次检查更新失败，使用本地目录",
            error,
          );
        });
      }
    })();

    return this.initialization;
  }

  timestamp() {
    return new Date(this.now()).toISOString();
  }

  randomBetween(minimum, maximum) {
    return Math.round(
      minimum + this.random() * Math.max(0, maximum - minimum),
    );
  }

  rateLimitDelayRemaining() {
    const retryAt = Date.parse(this.state.rateLimit?.nextRetryAt ?? "");
    if (!Number.isFinite(retryAt)) return 0;
    return Math.max(0, retryAt - this.now());
  }

  clearRateLimit() {
    this.state.rateLimit = {
      ...normalizeRateLimitState(this.state.rateLimit),
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastErrorKind: null,
      lastHttpStatus: null,
      lastMessage: null,
    };
  }

  recordBatchTelemetry(results) {
    const rateLimit = normalizeRateLimitState(this.state.rateLimit);
    const attempted = results.filter(
      (result) => result.attempted !== false,
    );
    const successful = attempted.filter(
      (result) => !result.error && !result.throttled,
    );
    const failed = attempted.find(
      (result) => result.error && !result.throttled,
    );
    if (attempted.length) {
      rateLimit.lastAttemptAt = this.timestamp();
      rateLimit.totalAttempts += attempted.length;
    }
    if (successful.length) {
      rateLimit.lastSuccessAt = this.timestamp();
      rateLimit.totalSuccesses += successful.length;
    }

    const throttled = attempted.find((result) => result.throttled);
    if (throttled) {
      rateLimit.consecutiveFailures += 1;
      rateLimit.lastThrottleAt = this.timestamp();
      rateLimit.lastErrorKind =
        throttled.errorKind ?? "rate_limit";
      rateLimit.lastHttpStatus = Number.isInteger(throttled.httpStatus)
        ? throttled.httpStatus
        : null;
      rateLimit.lastMessage =
        throttled.error ?? "抖音暂时限制了目录请求";
      rateLimit.totalThrottles += 1;
      const backoffIndex = Math.min(
        rateLimit.consecutiveFailures - 1,
        FAST_SYNC_THROTTLE_BACKOFF_MS.length - 1,
      );
      const configuredBackoff =
        FAST_SYNC_THROTTLE_BACKOFF_MS[backoffIndex];
      const responseBackoff = Math.max(
        0,
        Number(throttled.retryAfterMs) || 0,
      );
      const delay = Math.max(
        configuredBackoff,
        responseBackoff,
      );
      rateLimit.nextRetryAt = new Date(this.now() + delay).toISOString();
    } else if (successful.length || failed) {
      rateLimit.consecutiveFailures = 0;
      rateLimit.nextRetryAt = null;
      rateLimit.lastErrorKind =
        failed?.errorKind ?? null;
      rateLimit.lastHttpStatus = Number.isInteger(failed?.httpStatus)
        ? failed.httpStatus
        : null;
      rateLimit.lastMessage = failed?.error ?? null;
    }

    this.state.rateLimit = rateLimit;
    return throttled ?? null;
  }

  registerCreatorVideos(
    creator,
    videos,
    { known, pending, creatorHighWaterMarks },
  ) {
    const previousHighWater =
      creatorHighWaterMarks[creator.secUid] ?? null;
    const latestVideo = [...videos].sort(compareVideoIdsDescending)[0];
    let configChanged = false;

    const resolvedName = videos.find((video) => video.authorName)?.authorName;
    if (resolvedName && resolvedName !== creator.name) {
      creator.name = resolvedName;
      configChanged = true;
    }

    videos.forEach((video, rank) => {
      this.items.set(video.id, {
        ...video,
        authorName: creator.name,
        authorId: creator.secUid,
        rank,
      });

      if (!known.has(video.id)) {
        known.add(video.id);
        if (
          previousHighWater
            ? isVideoIdNewer(video.id, previousHighWater)
            : video.id === latestVideo?.id
        ) {
          pending.add(video.id);
        }
      }
    });

    if (
      latestVideo &&
      isVideoIdNewer(latestVideo.id, previousHighWater)
    ) {
      creatorHighWaterMarks[creator.secUid] = latestVideo.id;
    }

    return configChanged;
  }

  updateStoredRefreshState({
    known,
    pending,
    creatorHighWaterMarks,
    catalogCompleteCreatorIds,
  }) {
    this.state.knownIds = [...known];
    this.state.pendingNewIds = [...pending];
    this.state.creatorHighWaterMarks = creatorHighWaterMarks;
    this.state.catalogCompleteCreatorIds = [
      ...catalogCompleteCreatorIds,
    ];
  }

  async refresh({ ignoreBackoff = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const retryDelay = this.rateLimitDelayRemaining();
    if (!ignoreBackoff && retryDelay > 0) {
      this.scheduleSliceRefresh(retryDelay);
      return;
    }
    if (this.sliceTimer) {
      clearTimeout(this.sliceTimer);
      this.sliceTimer = null;
      this.sliceTimerDueAt = null;
    }

    this.refreshPromise = (async () => {
      const configuredCreators = this.config.creators ?? [];
      const fastSync =
        configuredCreators.length >= FAST_SYNC_CREATOR_THRESHOLD;
      const storedCursor = fastSync
        ? Math.min(
            this.state.refreshCursor ?? 0,
            Math.max(0, configuredCreators.length - 1),
          )
        : 0;
      const creators = fastSync
        ? configuredCreators.slice(
            storedCursor,
            storedCursor + FAST_SYNC_BATCH_SIZE,
          )
        : configuredCreators;
      const known = new Set(this.state.knownIds);
      const pending = new Set(this.state.pendingNewIds);
      const creatorHighWaterMarks = {
        ...this.state.creatorHighWaterMarks,
      };
      const activeCreatorIds = new Set(
        configuredCreators.map((creator) => creator.secUid),
      );
      const catalogCompleteCreatorIds = new Set(
        (this.state.catalogCompleteCreatorIds ?? []).filter((id) =>
          activeCreatorIds.has(id),
        ),
      );
      let authRequired = false;
      let partialCount = 0;
      let lastRefreshError = null;
      let configChanged = false;
      let throttled = false;
      let processedCreatorCount = creators.length;
      this.syncProcessed = storedCursor;
      this.syncTotal = configuredCreators.length;

      const registerResult = (creator, videos) => {
        configChanged =
          this.registerCreatorVideos(creator, videos, {
            known,
            pending,
            creatorHighWaterMarks,
          }) || configChanged;
        if (videos.complete) {
          catalogCompleteCreatorIds.add(creator.secUid);
        } else if (!catalogCompleteCreatorIds.has(creator.secUid)) {
          partialCount += videos.length;
        }
      };

      const registerFailure = (creator, error) => {
        lastRefreshError =
          error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[douyin-queue] 检查 ${creator.name ?? creator.secUid} 失败`,
          lastRefreshError.message,
        );
      };

      const persistProgress = async () => {
        this.updateStoredRefreshState({
          known,
          pending,
          creatorHighWaterMarks,
          catalogCompleteCreatorIds,
        });
        await this.saveState();
      };

      if (
        fastSync &&
        typeof this.source.fetchCreatorLatestBatch === "function"
      ) {
        for (
          let offset = 0;
          offset < creators.length;
          offset += FAST_SYNC_BATCH_SIZE
        ) {
          const batch = creators.slice(
            offset,
            offset + FAST_SYNC_BATCH_SIZE,
          );
          try {
            const results = await this.source.fetchCreatorLatestBatch(
              batch,
              {
                stopAfterIds: creatorHighWaterMarks,
                concurrency: 1,
                preferProfile:
                  this.state.catalogTransport === "profile_page",
              },
            );
            if (
              results.some(
                (result) => result.transport === "profile_page",
              )
            ) {
              this.state.catalogTransport = "profile_page";
            }
            const throttleResult = this.recordBatchTelemetry(results);
            if (throttleResult) {
              const firstThrottledIndex = results.findIndex(
                (result) =>
                  result.throttled && result.attempted !== false,
              );
              processedCreatorCount =
                firstThrottledIndex >= 0
                  ? offset + firstThrottledIndex
                  : offset;
            }
            for (const result of results) {
              throttled ||= Boolean(result.throttled);
              if (result.loginRequired) authRequired = true;
              if (!result.error || result.videos.length) {
                registerResult(result.creator, result.videos);
              }
              if (result.error) {
                registerFailure(result.creator, result.error);
              }
            }
          } catch (error) {
            this.recordBatchTelemetry(
              batch.map(() => ({
                attempted: true,
                error: error?.message ?? String(error),
                errorKind:
                  error?.errorKind ??
                  error?.code ??
                  "request_error",
                httpStatus: error?.httpStatus,
                retryAfterMs: error?.retryAfterMs,
                throttled: Boolean(error?.throttled),
              })),
            );
            throttled ||= Boolean(error?.throttled);
            if (throttled) processedCreatorCount = offset;
            for (const creator of batch) {
              registerFailure(creator, error);
            }
          } finally {
            this.syncProcessed =
              storedCursor +
              (throttled
                ? processedCreatorCount
                : offset + batch.length);
            await persistProgress();
          }
        }
      } else {
        for (const creator of creators) {
          try {
            const videos = await this.source.fetchCreatorVideos(
              creator,
              fastSync
                ? {
                    maxPages: FAST_SYNC_PAGE_LIMIT,
                    stopAfterId:
                      creatorHighWaterMarks[creator.secUid] ?? null,
                  }
                : undefined,
            );
            registerResult(creator, videos);
            this.recordBatchTelemetry([
              {
                attempted: true,
                error: null,
                throttled: false,
              },
            ]);
          } catch (error) {
            const failure = {
              attempted: true,
              error: error?.message ?? String(error),
              errorKind: error?.errorKind ?? error?.code ?? "request_error",
              httpStatus: error?.httpStatus,
              retryAfterMs: error?.retryAfterMs,
              throttled: Boolean(error?.throttled),
            };
            this.recordBatchTelemetry([failure]);
            throttled ||= failure.throttled;
            if (
              error?.code === "DOUYIN_LOGIN_REQUIRED" &&
              Array.isArray(error.partialVideos)
            ) {
              authRequired = true;
              partialCount += error.partialVideos.length;
              registerResult(creator, error.partialVideos);
            }
            registerFailure(creator, error);
          } finally {
            if (!throttled) this.syncProcessed += 1;
            if (fastSync) {
              await persistProgress();
            }
          }
          if (throttled) break;
        }
      }

      for (const item of this.activeSeedVideos()) {
        if (!known.has(item.id)) {
          known.add(item.id);
          pending.add(item.id);
        }
      }

      this.updateStoredRefreshState({
        known,
        pending,
        creatorHighWaterMarks,
        catalogCompleteCreatorIds,
      });
      this.authRequired = authRequired;
      this.partialCount = partialCount;
      this.lastRefreshError = lastRefreshError?.message ?? null;
      if (fastSync) {
        const advancedBy = throttled
          ? processedCreatorCount
          : creators.length;
        const reachedEnd =
          storedCursor + advancedBy >= configuredCreators.length;
        this.state.refreshCursor = throttled
          ? storedCursor + advancedBy
          : reachedEnd
            ? 0
            : storedCursor + advancedBy;
      }
      if (configChanged) await this.saveConfig();
      await this.saveState();

      if (throttled) {
        this.scheduleSliceRefresh(this.rateLimitDelayRemaining());
      } else if (fastSync && this.state.refreshCursor > 0) {
        this.scheduleSliceRefresh(
          this.randomBetween(
            FAST_SYNC_SLICE_DELAY_MIN_MS,
            FAST_SYNC_SLICE_DELAY_MAX_MS,
          ),
        );
      }
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  scheduleSliceRefresh(delayMs) {
    const safeDelay = Math.max(1_000, Number(delayMs) || 1_000);
    const dueAt = this.now() + safeDelay;
    if (
      this.sliceTimer &&
      this.sliceTimerDueAt &&
      Math.abs(this.sliceTimerDueAt - dueAt) < 1_000
    ) {
      return;
    }
    if (this.sliceTimer) clearTimeout(this.sliceTimer);
    this.sliceTimerDueAt = dueAt;
    this.sliceTimer = setTimeout(() => {
      this.sliceTimer = null;
      this.sliceTimerDueAt = null;
      this.refresh().catch((error) => {
        console.warn(
          "[douyin-queue] 分段检查更新失败，稍后重试",
          error?.message ?? error,
        );
      });
    }, safeDelay);
    this.sliceTimer.unref();
  }

  async getStatus() {
    const retryInMs = this.rateLimitDelayRemaining();
    const rateLimit = normalizeRateLimitState(this.state.rateLimit);
    return {
      authRequired: this.authRequired,
      authenticated: await this.source.isAuthenticated(),
      refreshing: Boolean(this.refreshPromise),
      throttled: retryInMs > 0,
      retryAt: retryInMs > 0 ? rateLimit.nextRetryAt : null,
      retryInMs,
      lastAttemptAt: rateLimit.lastAttemptAt,
      lastSuccessAt: rateLimit.lastSuccessAt,
      lastThrottleAt: rateLimit.lastThrottleAt,
      lastErrorKind: rateLimit.lastErrorKind,
      lastHttpStatus: rateLimit.lastHttpStatus,
      totalAttempts: rateLimit.totalAttempts,
      totalSuccesses: rateLimit.totalSuccesses,
      totalThrottles: rateLimit.totalThrottles,
      catalogTransport: this.state.catalogTransport ?? "api",
      syncProcessed: this.syncProcessed,
      syncTotal: this.syncTotal,
      completeCreatorCount:
        this.state.catalogCompleteCreatorIds?.length ?? 0,
      catalogCount: this.items.size,
      partialCount: this.partialCount,
      message:
        retryInMs > 0
          ? rateLimit.lastMessage ?? "抖音目录同步正在退避"
          : this.lastRefreshError,
    };
  }

  async login() {
    const result = await this.source.openLoginWindow();
    if (result.authenticated) {
      this.authRequired = false;
      this.lastRefreshError = null;
      this.clearRateLimit();
      await this.saveState();
      this.refresh({ ignoreBackoff: true }).catch((error) => {
        console.warn("[douyin-queue] 登录后的目录刷新失败", error);
      });
    }
    return {
      ...(await this.getStatus()),
      authenticated: result.authenticated,
    };
  }

  listCreators() {
    return {
      creators: (this.config.creators ?? []).map((creator) => ({
        name: creator.name,
        secUid: creator.secUid,
        shareUrl: creator.shareUrl,
      })),
      refreshing: Boolean(this.refreshPromise),
    };
  }

  async addCreator(input) {
    if (this.refreshPromise) await this.refreshPromise;
    const creator = await this.source.resolveCreatorProfile(input);
    const existing = (this.config.creators ?? []).find(
      (item) => item.secUid === creator.secUid,
    );
    if (existing) {
      return { ...this.listCreators(), added: false, creator: existing };
    }

    this.config.creators = [...(this.config.creators ?? []), creator];
    await this.saveConfig();
    await this.resetCatalog();
    await this.refresh();
    return { ...this.listCreators(), added: true, creator };
  }

  async removeCreator(secUid) {
    if (this.refreshPromise) await this.refreshPromise;
    const value = String(secUid ?? "");
    const previous = this.config.creators ?? [];
    const creators = previous.filter((creator) => creator.secUid !== value);
    if (creators.length === previous.length) {
      return { ...this.listCreators(), removed: false };
    }

    this.config.creators = creators;
    await this.saveConfig();
    await this.resetCatalog();
    if (creators.length) {
      await this.refresh();
    }
    return { ...this.listCreators(), removed: true };
  }

  startPolling() {
    if (this.pollTimer) return;

    const configuredMinutes = Number(this.config.pollIntervalMinutes);
    const minutes =
      Number.isFinite(configuredMinutes) && configuredMinutes > 0
        ? configuredMinutes
        : DEFAULT_POLL_MINUTES;

    this.pollTimer = setInterval(() => {
      this.refresh().catch((error) =>
        console.warn("[douyin-queue] 定时检查更新失败", error),
      );
    }, minutes * 60 * 1_000);
    this.pollTimer.unref();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sliceTimer) {
      clearTimeout(this.sliceTimer);
      this.sliceTimer = null;
      this.sliceTimerDueAt = null;
    }
    this.source.close?.();
  }

  async getQueueInfo(afterId) {
    await this.initialize();
    const pendingIds = new Set(this.state.pendingNewIds);
    const newest = [...this.items.values()]
      .filter((item) => pendingIds.has(item.id) && item.id !== afterId)
      .sort(compareVideoIdsDescending)[0];
    return {
      hasNew: Boolean(newest),
      newestPublishedAt: newest?.publishedAt ?? null,
      pendingCount: this.state.pendingNewIds.length,
      itemCount: this.items.size,
    };
  }

  async next(afterId) {
    await this.initialize();

    const availableItems = [...this.items.values()];
    const pendingIds = new Set(this.state.pendingNewIds);
    const newItems = availableItems
      .filter((item) => pendingIds.has(item.id) && item.id !== afterId)
      .sort(compareVideoIdsDescending);

    let item = newItems[0];
    let priority = "new";

    if (!item) {
      priority = "shuffle";
      const recent = new Set(this.state.recentIds);
      const freshPool = availableItems.filter(
        (candidate) =>
          candidate.id !== afterId && !recent.has(candidate.id),
      );
      const fallbackPool = availableItems.filter(
        (candidate) => candidate.id !== afterId,
      );
      item = randomItem(freshPool.length ? freshPool : fallbackPool);
    }

    if (!item) item = availableItems[0];
    if (!item) throw new Error("没有可播放的抖音作品");

    pendingIds.delete(item.id);
    this.state.pendingNewIds = [...pendingIds];
    this.state.recentIds = [
      item.id,
      ...this.state.recentIds.filter((id) => id !== item.id),
    ].slice(0, MAX_RECENT_ITEMS);
    await this.saveState();

    return {
      id: item.id,
      authorId: item.authorId ?? null,
      publishedAt: item.publishedAt ?? null,
      kind: item.kind ?? null,
      priority,
    };
  }

  async resolve(videoId) {
    const result = await this.source.resolve(videoId);
    const existing = this.items.get(videoId) ?? { id: videoId };
    this.items.set(videoId, {
      ...existing,
      authorName: result.authorName,
      authorId: result.authorId,
      publishedAt: result.publishedAt,
      kind: result.kind,
    });
    return result;
  }
}

module.exports = {
  LocalDouyinClient,
  compareVideoIdsDescending,
};
