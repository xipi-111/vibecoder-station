const { app } = require("electron");
const { DouyinLocalSource } = require("../plugins/douyin/source.cjs");

const expectedSecUid =
  "MS4wLjABAAAAfmD6yKVDHEEyYtQ908o3jp7Eo-ge0vraIeuTJoxgsaNN5mFFmagrgnLmGerDPth-";

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    const source = new DouyinLocalSource({
      partition: "douyin-creator-smoke",
    });
    const creator = await source.resolveCreatorProfile(
      "主页链接：https://v.douyin.com/o3Mdz89MkDY/",
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
