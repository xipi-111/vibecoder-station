const { app } = require("electron");
const { DouyinLocalSource } = require("../plugins/douyin/source.cjs");

if (process.env.VIBECODER_TEST_USER_DATA) {
  app.setPath("userData", process.env.VIBECODER_TEST_USER_DATA);
}

const creators = [
  {
    name: "姜乘澜",
    secUid:
      "MS4wLjABAAAAoyFQWZF9nVEVceqNol0wiIM17LTHoandxsR11E-w_3k",
  },
  {
    name: "陈圆圆超可爱",
    secUid:
      "MS4wLjABAAAA3kGdUv2N61ZK1J9X2tKnR28PMDGdbNt2WgQo8GsYKZk",
  },
];

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const source = new DouyinLocalSource();
  const startedAt = Date.now();

  try {
    const concurrency = Number(
      process.env.VIBECODER_TEST_CONCURRENCY,
    );
    const results = await source.fetchCreatorLatestBatch(creators, {
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
    });
    if (
      results.length !== creators.length ||
      results.some((result) => result.videos.length === 0)
    ) {
      throw new Error(
        `批量目录结果不完整：${results
          .map((result) => result.videos.length)
          .join(", ")}；错误：${results
          .map((result) => result.error ?? "无")
          .join(", ")}`,
      );
    }

    console.log(
      JSON.stringify({
        result: "passed",
        creators: results.length,
        counts: results.map((result) => result.videos.length),
        errors: results.map((result) => result.error),
        concurrency: Number.isFinite(concurrency) ? concurrency : "default",
        elapsedMs: Date.now() - startedAt,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    source.close();
  }
});
