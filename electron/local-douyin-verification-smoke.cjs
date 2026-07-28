const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalDouyinClient } = require("../plugins/douyin/client.cjs");

function creator(index) {
  return {
    name: `验证测试博主 ${index}`,
    secUid: `MS4wLjAB_verification_creator_${String(index).padStart(2, "0")}`,
    shareUrl: `https://www.douyin.com/user/verification-${index}`,
  };
}

function video(item, index) {
  return {
    id: `71000000000000000${String(index).padStart(2, "0")}`,
    authorName: item.name,
    publishedAt: "2026-07-28T00:00:00.000Z",
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function main() {
  const testDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vibecoder-verification-smoke-"),
  );
  const creators = Array.from({ length: 12 }, (_, index) =>
    creator(index + 1),
  );
  let batchCalls = 0;
  let verificationOpenCount = 0;
  let verificationOpen = false;
  let completeVerification;
  const source = {
    isAuthenticated: async () => true,
    isVerificationWindowOpen: async () => verificationOpen,
    close: () => {},
    fetchCreatorLatestBatch: async (items) => {
      batchCalls += 1;
      if (batchCalls === 1) {
        return items.map((item, index) => ({
          creator: item,
          videos: [],
          error: "抖音需要先完成人机验证",
          errorKind: "human_verification",
          attempted: index === 0,
          loginRequired: false,
          throttled: true,
          verificationRequired: true,
        }));
      }
      return items.map((item, index) => ({
        creator: item,
        videos: [video(item, index + 1)],
        error: null,
        attempted: true,
        loginRequired: false,
        throttled: false,
        verificationRequired: false,
      }));
    },
    openVerificationWindow: async () => {
      verificationOpenCount += 1;
      verificationOpen = true;
      await new Promise((resolve) => {
        completeVerification = resolve;
      });
      verificationOpen = false;
      return { completed: true, verificationRequired: false };
    },
  };

  try {
    const client = new LocalDouyinClient({
      source,
      config: {
        pollIntervalMinutes: 15,
        creators,
        seedVideos: [],
      },
      configPath: path.join(testDirectory, "config.json"),
      userDataPath: testDirectory,
      random: () => 0,
    });

    await client.initialize();
    await client.refresh();
    await waitUntil(
      () => verificationOpenCount === 1,
      "检测到挑战后没有自动打开验证窗口",
    );

    const blockedStatus = await client.getStatus();
    const blockedState = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-queue-state.json"),
        "utf8",
      ),
    );
    if (
      !blockedStatus.verificationRequired ||
      !blockedStatus.verificationWindowOpen ||
      blockedStatus.retryInMs !== 0 ||
      blockedState.refreshCursor !== 0 ||
      blockedState.rateLimit?.nextRetryAt !== null ||
      !blockedState.rateLimit?.verificationRequired
    ) {
      throw new Error("真人验证没有正确暂停同步并保存状态");
    }

    const action = client.login();
    completeVerification();
    await action;
    await waitUntil(
      () => batchCalls === 2,
      "完成验证后没有从原游标继续同步",
    );

    const resumedStatus = await client.getStatus();
    const resumedState = JSON.parse(
      await fs.readFile(
        path.join(testDirectory, "douyin-queue-state.json"),
        "utf8",
      ),
    );
    if (
      verificationOpenCount !== 1 ||
      resumedStatus.verificationRequired ||
      resumedStatus.throttled ||
      resumedState.refreshCursor !== 2 ||
      resumedState.knownIds.length !== 2 ||
      resumedState.rateLimit?.verificationRequired
    ) {
      throw new Error("真人验证完成后没有正确解除暂停或续传");
    }

    client.stopPolling();

    const manualDirectory = path.join(testDirectory, "manual-check");
    let manualBatchCalls = 0;
    let manualWindowOpenCount = 0;
    const manualSource = {
      isAuthenticated: async () => true,
      isVerificationWindowOpen: async () => manualWindowOpenCount > 0,
      close: () => {},
      fetchCreatorLatestBatch: async (items) => {
        manualBatchCalls += 1;
        return items.map((item, index) => ({
          creator: item,
          videos: [],
          error: "抖音目录接口返回空响应",
          errorKind: "empty_response",
          httpStatus: 200,
          attempted: index === 0,
          loginRequired: false,
          throttled: true,
          verificationRequired: false,
          verificationAvailable: true,
        }));
      },
      openVerificationWindow: async (_creator, options) => {
        if (!options?.force) {
          throw new Error("隐藏验证模块必须通过手动检查打开");
        }
        manualWindowOpenCount += 1;
        return {
          completed: false,
          verificationRequired: false,
          inspectionOpened: true,
        };
      },
    };
    const manualClient = new LocalDouyinClient({
      source: manualSource,
      config: {
        pollIntervalMinutes: 15,
        creators,
        seedVideos: [],
      },
      configPath: path.join(manualDirectory, "config.json"),
      userDataPath: manualDirectory,
      random: () => 0,
    });
    await manualClient.initialize();
    await manualClient.refresh();
    const manualStatus = await manualClient.getStatus();
    if (
      !manualStatus.throttled ||
      manualStatus.verificationRequired ||
      !manualStatus.verificationAvailable ||
      !manualStatus.inspectionAvailable ||
      manualWindowOpenCount !== 0
    ) {
      throw new Error("隐藏验证模块被误报成可见挑战或自动弹出");
    }

    await manualClient.login();
    const afterManualCheck = await manualClient.getStatus();
    if (
      manualBatchCalls !== 1 ||
      manualWindowOpenCount !== 1 ||
      !afterManualCheck.throttled ||
      afterManualCheck.verificationRequired ||
      !afterManualCheck.verificationAvailable ||
      !afterManualCheck.sourceWindowOpen
    ) {
      throw new Error("打开抖音检查不应等待或清除普通限流退避");
    }
    manualClient.stopPolling();

    console.log(
      JSON.stringify({
        result: "passed",
        autoOpened: true,
        manualInspection: true,
        persistedPause: true,
        resumedCursor: resumedState.refreshCursor,
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
