const path = require("node:path");
const { app } = require("electron");
const { MediaTransport } = require("./media-transport.cjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

app.whenReady().then(async () => {
  try {
    const transport = new MediaTransport({
      resolverClient: { enabled: false },
    });
    const videoId = "transport-smoke";
    const mediaPath = path.join(
      __dirname,
      "..",
      "dist",
      "media",
      "maker-workshop.mp4",
    );

    transport.registerLocalItem({ id: videoId, mediaPath });

    const partial = await transport.handle(
      new Request(`vibecoder-media://stream/${videoId}`, {
        headers: { Range: "bytes=0-1023" },
      }),
    );
    assert(partial.status === 206, `期望 206，实际为 ${partial.status}`);
    assert(
      partial.headers.get("content-range")?.startsWith("bytes 0-1023/"),
      "Content-Range 不正确",
    );
    assert(
      partial.headers.get("accept-ranges") === "bytes",
      "缺少 Accept-Ranges",
    );
    assert(
      Number(partial.headers.get("content-length")) === 1024,
      "Content-Length 不正确",
    );
    await partial.body?.cancel();

    const invalid = await transport.handle(
      new Request(`vibecoder-media://stream/${videoId}`, {
        headers: { Range: "bytes=999999999-" },
      }),
    );
    assert(invalid.status === 416, `期望 416，实际为 ${invalid.status}`);

    console.log(
      JSON.stringify({
        result: "passed",
        partialStatus: partial.status,
        contentRange: partial.headers.get("content-range"),
        invalidRangeStatus: invalid.status,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
