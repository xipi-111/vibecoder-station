const { app } = require("electron");
const { DouyinLocalSource } = require("./douyin-local-source.cjs");

const expectedSecUid =
  "MS4wLjABAAAAk-iM4HsNctFlBevUMddcdHUuQ2hRuy-dSxoboS2j1mIC48MkfFC8uJ9yQC3v7FNL";

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    const source = new DouyinLocalSource({
      partition: "douyin-creator-smoke",
    });
    const creator = await source.resolveCreatorProfile(
      "主页链接：https://v.douyin.com/ADLDPcmuWHU/",
    );
    if (creator.secUid !== expectedSecUid) {
      throw new Error(`识别到错误的 secUid：${creator.secUid}`);
    }
    if (!creator.name || creator.name === "resolver") {
      throw new Error(`识别到无效的博主名称：${creator.name}`);
    }

    console.log(
      JSON.stringify({
        result: "passed",
        name: creator.name,
        secUid: creator.secUid,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
