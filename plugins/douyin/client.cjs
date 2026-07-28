const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_POLL_MINUTES = 180;
const LEGACY_POLL_MINUTES = 15;
const CATALOG_SCHEMA_VERSION = 1;
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

function normalizeTimestamp(candidate) {
  return typeof candidate === "string" &&
    Number.isFinite(Date.parse(candidate))
    ? candidate
    : null;
}

function serializeCatalogItem(item) {
  const id = String(item?.id ?? "");
  if (!/^\d{10,24}$/.test(id)) return null;
  const serialized = { id };
  for (const key of [
    "authorName",
    "authorId",
    "publishedAt",
    "kind",
    "shareUrl",
  ]) {
    if (typeof item?.[key] === "string" && item[key]) {
      serialized[key] = item[key];
    }
  }
  if (
    Number.isInteger(item?.imageCount) &&
    item.imageCount >= 0
  ) {
    serialized.imageCount = item.imageCount;
  }
  return serialized;
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
    verificationRequired: false,
    verificationAvailable: false,
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
  const count = (candidate) =>
    Number.isInteger(candidate) && candidate >= 0 ? candidate : 0;
  return {
    consecutiveFailures: count(value.consecutiveFailures),
    nextRetryAt: normalizeTimestamp(value.nextRetryAt),
    lastAttemptAt: normalizeTimestamp(value.lastAttemptAt),
    lastSuccessAt: normalizeTimestamp(value.lastSuccessAt),
    lastThrottleAt: normalizeTimestamp(value.lastThrottleAt),
    lastErrorKind:
      typeof value.lastErrorKind === "string"
        ? value.lastErrorKind
        : null,
    lastHttpStatus: Number.isInteger(value.lastHttpStatus)
      ? value.lastHttpStatus
      : null,
    lastMessage:
      typeof value.lastMessage === "string" ? value.lastMessage : null,
    verificationRequired: Boolean(value.verificationRequired),
    verificationAvailable: Boolean(
      value.verificationAvailable || value.verificationRequired,
    ),
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
    this.catalogPath = path.join(userDataPath, "douyin-catalog.json");
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
      catalogImportedAt: null,
      lastCatalogCheckAt: null,
      rateLimit: emptyRateLimitState(),
    };
    this.catalogLoaded = false;
    this.catalogUpdatedAt = null;
    this.catalogSaveOperation = Promise.resolve();
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
    this.verificationPromise = null;
    this.stopped = false;

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

  effectivePollMinutes() {
    const configuredMinutes = Number(this.config.pollIntervalMinutes);
    if (configuredMinutes === LEGACY_POLL_MINUTES) {
      return DEFAULT_POLL_MINUTES;
    }
    return Number.isFinite(configuredMinutes) && configuredMinutes > 0
      ? configuredMinutes
      : DEFAULT_POLL_MINUTES;
  }

  catalogRefreshDelayRemaining() {
    const lastCheckAt = Date.parse(
      this.state.lastCatalogCheckAt ?? "",
    );
    if (!Number.isFinite(lastCheckAt)) return 0;
    return Math.max(
      0,
      lastCheckAt +
        this.effectivePollMinutes() * 60 * 1_000 -
        this.now(),
    );
  }

  async loadCatalog() {
    try {
      const stored = JSON.parse(
        await fs.readFile(this.catalogPath, "utf8"),
      );
      if (
        stored?.schemaVersion !== CATALOG_SCHEMA_VERSION ||
        !Array.isArray(stored.items)
      ) {
        throw new Error("本地目录版本不受支持");
      }
      const activeCreatorIds = new Set(
        (this.config.creators ?? []).map((creator) => creator.secUid),
      );
      for (const candidate of stored.items) {
        const item = serializeCatalogItem(candidate);
        if (
          !item ||
          (item.authorId && !activeCreatorIds.has(item.authorId))
        ) {
          continue;
        }
        this.items.set(item.id, {
          ...this.items.get(item.id),
          ...item,
          rank: Number.MAX_SAFE_INTEGER,
        });
      }
      this.catalogLoaded = true;
      this.catalogUpdatedAt = normalizeTimestamp(stored.updatedAt);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(
          "[douyin-queue] 无法读取本地作品目录，将从旧状态恢复",
          error,
        );
      }
    }
  }

  async saveCatalog() {
    const save = async () => {
      const updatedAt = this.timestamp();
      const items = [...this.items.values()]
        .map(serializeCatalogItem)
        .filter(Boolean)
        .sort(compareVideoIdsDescending);
      await fs.mkdir(path.dirname(this.catalogPath), {
        recursive: true,
      });
      await fs.writeFile(
        this.catalogPath,
        JSON.stringify(
          {
            schemaVersion: CATALOG_SCHEMA_VERSION,
            updatedAt,
            creators: (this.config.creators ?? []).map((creator) => ({
              name: creator.name,
              secUid: creator.secUid,
              shareUrl: creator.shareUrl,
            })),
            items,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      this.catalogLoaded = true;
      this.catalogUpdatedAt = updatedAt;
    };
    const result = this.catalogSaveOperation.then(save, save);
    this.catalogSaveOperation = result.catch(() => undefined);
    return result;
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
      catalogImportedAt: this.state.catalogImportedAt,
      lastCatalogCheckAt: null,
      rateLimit: normalizeRateLimitState(this.state.rateLimit),
    };
    this.authRequired = false;
    this.partialCount = 0;
    this.lastRefreshError = null;
    await this.saveState();
    await this.saveCatalog();
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
        catalogImportedAt: normalizeTimestamp(stored.catalogImportedAt),
        lastCatalogCheckAt: normalizeTimestamp(
          stored.lastCatalogCheckAt,
        ),
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
      await this.loadCatalog();

      let configChanged = false;
      let stateChanged = false;
      if (
        Number(this.config.pollIntervalMinutes) === LEGACY_POLL_MINUTES
      ) {
        this.config.pollIntervalMinutes = DEFAULT_POLL_MINUTES;
        configChanged = true;
      }
      if (!this.catalogLoaded && this.state.knownIds.length > 0) {
        const importedAt = this.timestamp();
        this.state.catalogImportedAt =
          this.state.catalogImportedAt ?? importedAt;
        this.state.lastCatalogCheckAt =
          this.state.lastCatalogCheckAt ?? importedAt;
        stateChanged = true;
        await this.saveCatalog();
      } else if (
        this.catalogLoaded &&
        !this.state.lastCatalogCheckAt &&
        this.catalogUpdatedAt
      ) {
        this.state.lastCatalogCheckAt = this.catalogUpdatedAt;
        stateChanged = true;
      }
      if (configChanged) await this.saveConfig();
      if (stateChanged) await this.saveState();

      const retryDelay = this.rateLimitDelayRemaining();
      const catalogDelay = this.catalogRefreshDelayRemaining();
      if (this.state.rateLimit?.verificationRequired) {
        this.beginHumanVerification();
      } else if (retryDelay > 0 || catalogDelay > 0) {
        this.scheduleSliceRefresh(
          Math.max(retryDelay, catalogDelay),
        );
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
      verificationRequired: false,
      verificationAvailable: false,
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
      const verificationRequired = Boolean(
        throttled.verificationRequired ||
          throttled.errorKind === "human_verification",
      );
      const verificationAvailable = Boolean(
        verificationRequired || throttled.verificationAvailable,
      );
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
      rateLimit.verificationRequired = verificationRequired;
      rateLimit.verificationAvailable = verificationAvailable;
      if (verificationRequired) {
        rateLimit.nextRetryAt = null;
      } else {
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
        rateLimit.nextRetryAt = new Date(
          this.now() + delay,
        ).toISOString();
      }
    } else if (successful.length || failed) {
      rateLimit.consecutiveFailures = 0;
      rateLimit.nextRetryAt = null;
      rateLimit.lastErrorKind =
        failed?.errorKind ?? null;
      rateLimit.lastHttpStatus = Number.isInteger(failed?.httpStatus)
        ? failed.httpStatus
        : null;
      rateLimit.lastMessage = failed?.error ?? null;
      rateLimit.verificationRequired = false;
      rateLimit.verificationAvailable = false;
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

  async refresh({
    ignoreBackoff = false,
    onlyCreators = null,
    fullCatalog = false,
  } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    if (
      !ignoreBackoff &&
      this.state.rateLimit?.verificationRequired
    ) {
      this.beginHumanVerification();
      return;
    }
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
      const targeted = Array.isArray(onlyCreators);
      const requestedCreatorIds = new Set(
        targeted
          ? onlyCreators.map((creator) => creator.secUid)
          : [],
      );
      const scopedCreators = targeted
        ? configuredCreators.filter((creator) =>
            requestedCreatorIds.has(creator.secUid),
          )
        : configuredCreators;
      const fastSync =
        !targeted &&
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
        : scopedCreators;
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
      this.syncProcessed = targeted ? 0 : storedCursor;
      this.syncTotal = targeted
        ? scopedCreators.length
        : configuredCreators.length;

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
        await this.saveCatalog();
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
                verificationRequired:
                  Boolean(error?.verificationRequired),
                verificationAvailable:
                  Boolean(error?.verificationAvailable),
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
            const needsInitialCatalog =
              !this.state.catalogImportedAt &&
              !creatorHighWaterMarks[creator.secUid] &&
              !catalogCompleteCreatorIds.has(creator.secUid);
            const videos = await this.source.fetchCreatorVideos(
              creator,
              fullCatalog || needsInitialCatalog
                ? undefined
                : {
                    maxPages: FAST_SYNC_PAGE_LIMIT,
                    stopAfterId:
                      creatorHighWaterMarks[creator.secUid] ?? null,
                  },
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
              verificationRequired:
                Boolean(error?.verificationRequired),
              verificationAvailable:
                Boolean(error?.verificationAvailable),
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
            if (fastSync || targeted) {
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
      let reachedEnd = false;
      if (fastSync) {
        const advancedBy = throttled
          ? processedCreatorCount
          : creators.length;
        reachedEnd =
          storedCursor + advancedBy >= configuredCreators.length;
        this.state.refreshCursor = throttled
          ? storedCursor + advancedBy
          : reachedEnd
            ? 0
            : storedCursor + advancedBy;
      }
      if (
        !targeted &&
        !throttled &&
        !lastRefreshError &&
        (!fastSync || reachedEnd)
      ) {
        const completedAt = this.timestamp();
        this.state.catalogImportedAt =
          this.state.catalogImportedAt ?? completedAt;
        this.state.lastCatalogCheckAt = completedAt;
      }
      if (configChanged) await this.saveConfig();
      await this.saveState();
      await this.saveCatalog();

      if (this.state.rateLimit.verificationRequired) {
        this.beginHumanVerification(
          configuredCreators[
            Math.min(
              this.state.refreshCursor ?? 0,
              Math.max(0, configuredCreators.length - 1),
            )
          ],
        );
      } else if (throttled) {
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

  beginHumanVerification(creator = null, { force = false } = {}) {
    if (this.verificationPromise) return this.verificationPromise;
    if (typeof this.source.openVerificationWindow !== "function") {
      return Promise.resolve({
        completed: false,
        verificationRequired: true,
      });
    }
    const configuredCreators = this.config.creators ?? [];
    const selectedCreator =
      creator ??
      configuredCreators[
        Math.min(
          this.state.refreshCursor ?? 0,
          Math.max(0, configuredCreators.length - 1),
        )
      ] ??
      configuredCreators[0];
    if (!selectedCreator) {
      return Promise.resolve({
        completed: false,
        verificationRequired: true,
      });
    }

    const promise = this.source
      .openVerificationWindow(selectedCreator, { force })
      .then(async (result) => {
        if (result?.completed && !result.verificationRequired) {
          this.lastRefreshError = null;
          this.clearRateLimit();
          await this.saveState();
          if (!this.stopped) {
            const retryTimer = setTimeout(() => {
              this.refresh({ ignoreBackoff: true }).catch((error) => {
                console.warn(
                  "[douyin-queue] 验证后的目录刷新失败",
                  error,
                );
              });
            }, 0);
            retryTimer.unref();
          }
        }
        return result;
      })
      .catch((error) => {
        console.warn(
          "[douyin-queue] 无法打开抖音检查或验证窗口",
          error?.message ?? error,
        );
        return {
          completed: false,
          verificationRequired: !force,
        };
      });
    this.verificationPromise = promise;
    promise.finally(() => {
      if (this.verificationPromise === promise) {
        this.verificationPromise = null;
      }
    });
    return promise;
  }

  async getStatus() {
    const retryInMs = this.rateLimitDelayRemaining();
    const rateLimit = normalizeRateLimitState(this.state.rateLimit);
    const sourceWindowOpen =
      (await this.source.isVerificationWindowOpen?.()) ?? false;
    return {
      authRequired: this.authRequired,
      authenticated: await this.source.isAuthenticated(),
      refreshing: Boolean(this.refreshPromise),
      throttled:
        retryInMs > 0 || rateLimit.verificationRequired,
      verificationRequired: rateLimit.verificationRequired,
      verificationAvailable: rateLimit.verificationAvailable,
      verificationWindowOpen: sourceWindowOpen,
      sourceWindowOpen,
      inspectionAvailable:
        typeof this.source.openVerificationWindow === "function",
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
      catalogCached: this.catalogLoaded,
      catalogUpdatedAt: this.catalogUpdatedAt,
      lastCatalogCheckAt: this.state.lastCatalogCheckAt,
      nextCatalogCheckInMs: this.catalogRefreshDelayRemaining(),
      syncProcessed: this.syncProcessed,
      syncTotal: this.syncTotal,
      completeCreatorCount:
        this.state.catalogCompleteCreatorIds?.length ?? 0,
      catalogCount: this.items.size,
      partialCount: this.partialCount,
      message:
        rateLimit.verificationRequired
          ? rateLimit.lastMessage ?? "抖音需要先完成人机验证"
          : retryInMs > 0
          ? rateLimit.lastMessage ?? "抖音目录同步正在退避"
          : this.lastRefreshError,
    };
  }

  async login() {
    if (this.state.rateLimit?.verificationRequired) {
      await this.beginHumanVerification();
      return this.getStatus();
    }
    if (this.rateLimitDelayRemaining() > 0) {
      await this.beginHumanVerification(null, { force: true });
      return this.getStatus();
    }
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
    await this.initialize();
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
    await this.refresh({
      onlyCreators: [creator],
      fullCatalog: true,
    });
    return { ...this.listCreators(), added: true, creator };
  }

  async removeCreator(secUid) {
    await this.initialize();
    if (this.refreshPromise) await this.refreshPromise;
    const value = String(secUid ?? "");
    const previous = this.config.creators ?? [];
    const creators = previous.filter((creator) => creator.secUid !== value);
    if (creators.length === previous.length) {
      return { ...this.listCreators(), removed: false };
    }

    this.config.creators = creators;
    const removedIds = new Set(
      [...this.items.values()]
        .filter((item) => item.authorId === value)
        .map((item) => item.id),
    );
    for (const id of removedIds) this.items.delete(id);
    this.state.knownIds = this.state.knownIds.filter(
      (id) => !removedIds.has(id),
    );
    this.state.pendingNewIds = this.state.pendingNewIds.filter(
      (id) => !removedIds.has(id),
    );
    this.state.recentIds = this.state.recentIds.filter(
      (id) => !removedIds.has(id),
    );
    delete this.state.creatorHighWaterMarks[value];
    this.state.catalogCompleteCreatorIds =
      this.state.catalogCompleteCreatorIds.filter(
        (creatorId) => creatorId !== value,
      );
    this.state.refreshCursor = Math.min(
      this.state.refreshCursor ?? 0,
      Math.max(0, creators.length - 1),
    );
    await this.saveConfig();
    await this.saveState();
    await this.saveCatalog();
    return { ...this.listCreators(), removed: true };
  }

  startPolling() {
    if (this.pollTimer) return;
    this.stopped = false;

    const minutes = this.effectivePollMinutes();

    this.pollTimer = setInterval(() => {
      this.refresh().catch((error) =>
        console.warn("[douyin-queue] 定时检查更新失败", error),
      );
    }, minutes * 60 * 1_000);
    this.pollTimer.unref();
  }

  stopPolling() {
    this.stopped = true;
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
    await this.saveCatalog();
    return result;
  }
}

module.exports = {
  LocalDouyinClient,
  compareVideoIdsDescending,
};
