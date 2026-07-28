const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_POLL_MINUTES = 15;
const MAX_RECENT_ITEMS = 20;
const FAST_SYNC_CREATOR_THRESHOLD = 12;
const FAST_SYNC_PAGE_LIMIT = 1;
const FAST_SYNC_BATCH_SIZE = 4;
const FAST_SYNC_SLICE_DELAY_MS = 30_000;
const FAST_SYNC_THROTTLED_RETRY_MS = 5 * 60_000;

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

class LocalDouyinClient {
  constructor({ source, config, configPath, userDataPath }) {
    this.source = source;
    this.config = config;
    this.configPath = configPath;
    this.statePath = path.join(userDataPath, "douyin-queue-state.json");
    this.items = new Map();
    this.state = {
      knownIds: [],
      pendingNewIds: [],
      recentIds: [],
      creatorHighWaterMarks: {},
      catalogCompleteCreatorIds: [],
      refreshCursor: 0,
    };
    this.initialization = null;
    this.refreshPromise = null;
    this.pollTimer = null;
    this.sliceTimer = null;
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

      this.refresh().catch((error) => {
        console.warn("[douyin-queue] 首次检查更新失败，使用本地目录", error);
      });
    })();

    return this.initialization;
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

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.sliceTimer) {
      clearTimeout(this.sliceTimer);
      this.sliceTimer = null;
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
              },
            );
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
            for (const creator of batch) {
              registerFailure(creator, error);
            }
          } finally {
            if (!throttled) {
              this.syncProcessed += batch.length;
            }
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
          } catch (error) {
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
            this.syncProcessed += 1;
            if (fastSync) {
              await persistProgress();
            }
          }
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
        const reachedEnd =
          storedCursor + creators.length >= configuredCreators.length;
        this.state.refreshCursor = throttled
          ? storedCursor
          : reachedEnd
            ? 0
            : storedCursor + creators.length;
      }
      if (configChanged) await this.saveConfig();
      await this.saveState();

      if (fastSync) {
        if (throttled) {
          this.scheduleSliceRefresh(FAST_SYNC_THROTTLED_RETRY_MS);
        } else if (this.state.refreshCursor > 0) {
          this.scheduleSliceRefresh(FAST_SYNC_SLICE_DELAY_MS);
        }
      }
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  scheduleSliceRefresh(delayMs) {
    if (this.sliceTimer) return;
    this.sliceTimer = setTimeout(() => {
      this.sliceTimer = null;
      this.refresh().catch((error) => {
        console.warn(
          "[douyin-queue] 分段检查更新失败，稍后重试",
          error?.message ?? error,
        );
      });
    }, delayMs);
    this.sliceTimer.unref();
  }

  async getStatus() {
    return {
      authRequired: this.authRequired,
      authenticated: await this.source.isAuthenticated(),
      refreshing: Boolean(this.refreshPromise),
      syncProcessed: this.syncProcessed,
      syncTotal: this.syncTotal,
      completeCreatorCount:
        this.state.catalogCompleteCreatorIds?.length ?? 0,
      catalogCount: this.items.size,
      partialCount: this.partialCount,
      message: this.lastRefreshError,
    };
  }

  async login() {
    const result = await this.source.openLoginWindow();
    if (result.authenticated) {
      this.authRequired = false;
      this.lastRefreshError = null;
      this.refresh().catch((error) => {
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
