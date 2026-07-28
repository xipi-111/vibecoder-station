const { app, net } = require("electron");
const { DouyinLocalSource } = require("../plugins/douyin/source.cjs");

app.on("window-all-closed", () => {});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

app.whenReady().then(async () => {
  try {
    const source = new DouyinLocalSource({ timeoutMs: 25_000 });
    const result = await source.resolve("7660720061942900473");

    assert(result.id === "7660720061942900473", "作品 ID 不匹配");
    assert(result.authorName === "余多多奢品（上门收）", "作者不匹配");
    assert(result.media?.url?.startsWith("https://"), "缺少 HTTPS 媒体地址");

    const response = await net.fetch(result.media.url, {
      headers: {
        ...result.media.headers,
        Range: "bytes=0-1023",
      },
      redirect: "follow",
    });

    assert(
      response.status === 206 || response.status === 200,
      `媒体请求失败：${response.status}`,
    );
    assert(
      response.headers.get("content-type")?.includes("video"),
      "媒体 Content-Type 不正确",
    );
    await response.body?.cancel();

    console.log(
      JSON.stringify({
        result: "passed",
        id: result.id,
        author: result.authorName,
        status: response.status,
        contentRange: response.headers.get("content-range"),
        contentType: response.headers.get("content-type"),
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
