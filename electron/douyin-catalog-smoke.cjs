const { app } = require("electron");
const { DouyinLocalSource } = require("./douyin-local-source.cjs");

const creator = {
  name: "余多多奢品（上门收）",
  secUid:
    "MS4wLjABAAAAfmD6yKVDHEEyYtQ908o3jp7Eo-ge0vraIeuTJoxgsaNN5mFFmagrgnLmGerDPth-",
};

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    const source = new DouyinLocalSource({ creatorTimeoutMs: 120_000 });
    try {
      const videos = await source.fetchCreatorVideos(creator);
      if (videos.length <= 8) {
        throw new Error(`只发现 ${videos.length} 个作品，分页没有生效`);
      }

      console.log(
        JSON.stringify({
          result: "passed",
          mode: "complete",
          creator: creator.name,
          count: videos.length,
          newestIds: videos.slice(0, 5).map((video) => video.id),
          oldestIds: videos.slice(-5).map((video) => video.id),
        }),
      );
    } catch (error) {
      if (
        error?.code !== "DOUYIN_LOGIN_REQUIRED" ||
        !Array.isArray(error.partialVideos)
      ) {
        throw error;
      }
      if (error.partialVideos.length <= 8) {
        throw new Error(
          `访客目录只发现 ${error.partialVideos.length} 个作品，分页没有生效`,
        );
      }

      console.log(
        JSON.stringify({
          result: "passed",
          mode: "login-required-for-complete-catalog",
          creator: creator.name,
          partialCount: error.partialVideos.length,
          newestIds: error.partialVideos
            .slice(0, 5)
            .map((video) => video.id),
        }),
      );
    }
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
