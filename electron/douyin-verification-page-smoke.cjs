const { app } = require("electron");
const { DouyinLocalSource } = require("../plugins/douyin/source.cjs");

async function main() {
  await app.whenReady();
  const source = new DouyinLocalSource({
    partition: `vibecoder-verification-smoke-${Date.now()}`,
  });

  try {
    const page = await source.createPage();
    await page.window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`
          <style>
            iframe { width: 420px; height: 320px; border: 0; }
          </style>
          <main>challenge fixture</main>
        `),
    );
    await page.window.webContents.executeJavaScript(`
      const frame = document.createElement("iframe");
      frame.src = "data:text/html,rmc-nocaptcha-visible";
      document.body.append(frame);
    `);
    const challenge = await source.detectHumanVerification(page);
    if (!challenge.required || challenge.reason !== "challenge_frame") {
      throw new Error("没有识别可见的真人验证 iframe");
    }

    await page.window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent("<main>hidden challenge fixture</main>"),
    );
    await page.window.webContents.executeJavaScript(`
      const frame = document.createElement("iframe");
      frame.src = "data:text/html,rmc-nocaptcha-preloaded";
      frame.style.display = "none";
      document.body.append(frame);
    `);
    const hiddenChallenge = await source.detectHumanVerification(page);
    if (
      hiddenChallenge.required ||
      !hiddenChallenge.available ||
      hiddenChallenge.reason !== "challenge_frame_hidden"
    ) {
      throw new Error(
        `隐藏的验证预加载模块没有与可见挑战区分：${JSON.stringify(
          hiddenChallenge,
        )}`,
      );
    }

    await page.window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent("<main>普通抖音博主主页</main>"),
    );
    const ordinaryPage = await source.detectHumanVerification(page);
    if (ordinaryPage.required) {
      throw new Error("普通页面被误判为真人验证");
    }

    await page.window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`
          <div>
            <div id="service-error">
              服务异常，重新
              <span onclick="this.parentElement.remove()">刷新</span>
              拉取数据
            </div>
          </div>
        `),
    );
    const recovery = await source.recoverCatalogServiceError(page);
    const serviceErrorVisible =
      await page.window.webContents.executeJavaScript(
        `Boolean(document.querySelector("#service-error"))`,
      );
    if (!recovery.refreshed || serviceErrorVisible) {
      throw new Error("没有自动恢复抖音页面内的临时服务异常");
    }

    console.log(
      JSON.stringify({
        result: "passed",
        detectedChallengeFrame: true,
        ignoredHiddenPreload: true,
        ignoredOrdinaryPage: true,
        recoveredServiceError: true,
      }),
    );
  } finally {
    source.close();
    await app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
