const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalDouyinClient } = require("../plugins/douyin/client.cjs");

function creator(index) {
  return {
    name: `限流测试博主 ${index}`,
    secUid: `MS4wLjAB_rate_limit_creator_${String(index).padStart(2, "0")}`,
    shareUrl: `https://www.douyin.com/user/rate-limit-${index}`,
  };
}

function video(item, index) {
  return {
    id: `70000000000000000${String(index).padStart(2, "0")}`,
    authorName: item.name,
    publishedAt: "2026-07-28T00:00:00.000Z",
  };
}

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-rate-limit-smoke-"),
  );
  const creators = Array.from({ length: 12 }, (_, index) =>
    creator(index + 1),
  );
  const batchCalls = [];
  let currentTime = Date.parse("2026-07-28T08:00:00.000Z");

  const firstSource = {
    isAuthenticated: async () => true,
    close: () => {},
    fetchCreatorLatestBatch: async (items) => {
      batchCalls.push(items.map((item) => item.secUid));
      return [
        {
          creator: items[0],
          videos: [video(items[0], 1)],
          loginRequired: false,
          error: null,
          attempted: true,
          throttled: false,
        },
        {
          creator: items[1],
          videos: [],
          loginRequired: false,
          error: "抖音暂时限制了目录请求",
          errorKind: "rate_limit",
          httpStatus: 429,
          retryAfterMs: null,
          attempted: true,
          throttled: true,
        },
      ];
    },
  };

  try {
    const client = new LocalDouyinClient({
      source: firstSource,
      config: {
        pollIntervalMinutes: 15,
        creators,
        seedVideos: [],
      },
      configPath: path.join(testDirectory, "config.json"),
      userDataPath: testDirectory,
      now: () => currentTime,
      random: () => 0,
    });

    await client.initialize();
    await client.refresh();

    const throttledStatus = await client.getStatus();
    const throttledState = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-queue-state.json"),
        "utf8",
      ),
    );
    if (
      batchCalls.length !== 1 ||
      throttledState.refreshCursor !== 1 ||
      throttledState.knownIds.length !== 1 ||
      throttledState.rateLimit?.consecutiveFailures !== 1 ||
      throttledState.rateLimit?.lastHttpStatus !== 429 ||
      !throttledStatus.throttled ||
      throttledStatus.retryInMs !== 5 * 60_000
    ) {
      throw new Error("首次限流没有正确记录进度和退避状态");
    }

    await client.refresh();
    if (batchCalls.length !== 1) {
      throw new Error("退避期间仍然发起了目录请求");
    }
    client.stopPolling();

    let resumedAttempt = 0;
    const resumedSource = {
      isAuthenticated: async () => true,
      close: () => {},
      fetchCreatorLatestBatch: async (items) => {
        batchCalls.push(items.map((item) => item.secUid));
        resumedAttempt += 1;
        if (resumedAttempt === 1) {
          return items.map((item, index) => ({
            creator: item,
            videos: [],
            loginRequired: false,
            error: "抖音目录接口返回空响应",
            errorKind: "empty_response",
            httpStatus: 200,
            retryAfterMs: null,
            attempted: index === 0,
            throttled: true,
          }));
        }
        return items.map((item, index) => ({
          creator: item,
          videos: [video(item, index + 2)],
          loginRequired: false,
          error: null,
          attempted: true,
          throttled: false,
        }));
      },
    };
    const resumedClient = new LocalDouyinClient({
      source: resumedSource,
      config: {
        pollIntervalMinutes: 15,
        creators,
        seedVideos: [],
      },
      configPath: path.join(testDirectory, "config.json"),
      userDataPath: testDirectory,
      now: () => currentTime,
      random: () => 0,
    });

    await resumedClient.initialize();
    if (batchCalls.length !== 1) {
      throw new Error("重启后没有延续磁盘中的退避时间");
    }

    currentTime += 5 * 60_000 + 1;
    await resumedClient.refresh();
    const secondThrottleStatus = await resumedClient.getStatus();
    if (
      batchCalls.length !== 2 ||
      batchCalls[1][0] !== creators[1].secUid ||
      !secondThrottleStatus.throttled ||
      secondThrottleStatus.retryInMs !== 15 * 60_000
    ) {
      throw new Error("连续限流没有升级到十五分钟退避");
    }

    currentTime += 15 * 60_000 + 1;
    await resumedClient.refresh();
    const resumedStatus = await resumedClient.getStatus();
    const resumedState = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-queue-state.json"),
        "utf8",
      ),
    );
    if (
      batchCalls.length !== 3 ||
      batchCalls[2][0] !== creators[1].secUid ||
      resumedState.refreshCursor !== 3 ||
      resumedState.rateLimit?.consecutiveFailures !== 0 ||
      resumedState.rateLimit?.nextRetryAt !== null ||
      resumedStatus.throttled
    ) {
      throw new Error("退避结束后没有从失败博主继续同步");
    }

    resumedClient.stopPolling();
    console.log(
      JSON.stringify({
        result: "passed",
        persistedBackoff: true,
        retryMinutes: [5, 15],
        resumedCursor: resumedState.refreshCursor,
        requestsDuringBackoff: 0,
      }),
    );
  } finally {
    await fs.rm(testDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
