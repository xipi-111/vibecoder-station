const { app, net } = require("electron");
const { DouyinLocalSource } = require("./douyin-local-source.cjs");

app.on("window-all-closed", () => {});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchFirstBytes(descriptor) {
  const response = await net.fetch(descriptor.url, {
    headers: {
      ...descriptor.headers,
      Range: "bytes=0-1023",
    },
    redirect: "follow",
  });
  assert(
    response.status === 206 || response.status === 200,
    `媒体请求失败：${response.status}`,
  );
  await response.body?.cancel();
  return response.headers.get("content-type");
}

app.whenReady().then(async () => {
  try {
    const source = new DouyinLocalSource({
      partition: "douyin-image-smoke",
      timeoutMs: 25_000,
    });
    const result = await source.resolve("7648243050556538703");

    assert(result.kind === "image", "图文作品类型识别失败");
    assert(result.imageMedia?.length > 1, "多图作品解析失败");
    assert(
      result.media?.mimeType === "audio/mpeg",
      "图文原声解析失败",
    );

    const [imageContentType, audioContentType] = await Promise.all([
      fetchFirstBytes(result.imageMedia[0]),
      fetchFirstBytes(result.media),
    ]);

    assert(imageContentType?.includes("image"), "图片 Content-Type 不正确");
    assert(
      audioContentType?.includes("audio") ||
        audioContentType === "application/octet-stream",
      "原声 Content-Type 不正确",
    );

    console.log(
      JSON.stringify({
        result: "passed",
        id: result.id,
        kind: result.kind,
        imageCount: result.imageMedia.length,
        durationMs: result.durationMs,
        imageContentType,
        audioContentType,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
