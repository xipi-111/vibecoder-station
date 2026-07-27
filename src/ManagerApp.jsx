import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle,
  Plus,
  SignIn,
  SpinnerGap,
  Trash,
  X,
} from "@phosphor-icons/react";
import { streamProvider } from "./services/streamProvider.js";

const STATUS_POLL_MS = 4_000;

export function ManagerApp() {
  const [creators, setCreators] = useState([]);
  const [status, setStatus] = useState(null);
  const [creatorInput, setCreatorInput] = useState("");
  const [creatorBusy, setCreatorBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [creatorResult, douyinStatus] = await Promise.all([
      streamProvider.listCreators(),
      streamProvider.getDouyinStatus(),
    ]);
    setCreators(creatorResult.creators ?? []);
    setStatus(douyinStatus);
  }, []);

  useEffect(() => {
    let active = true;
    const update = () => {
      refresh().catch((refreshError) => {
        if (active) {
          setError(refreshError?.message ?? "无法读取博主配置");
        }
      });
    };
    update();
    const timer = window.setInterval(update, STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const addCreator = useCallback(
    async (event) => {
      event.preventDefault();
      const value = creatorInput.trim();
      if (!value || creatorBusy) return;

      setCreatorBusy(true);
      setError("");
      try {
        const result = await streamProvider.addCreator(value);
        setCreators(result.creators ?? []);
        setCreatorInput("");
        setStatus(await streamProvider.getDouyinStatus());
      } catch (addError) {
        setError(addError?.message ?? "添加博主失败");
      } finally {
        setCreatorBusy(false);
      }
    },
    [creatorBusy, creatorInput],
  );

  const removeCreator = useCallback(
    async (secUid) => {
      if (creatorBusy) return;

      setCreatorBusy(true);
      setError("");
      try {
        const result = await streamProvider.removeCreator(secUid);
        setCreators(result.creators ?? []);
        setStatus(await streamProvider.getDouyinStatus());
      } catch (removeError) {
        setError(removeError?.message ?? "删除博主失败");
      } finally {
        setCreatorBusy(false);
      }
    },
    [creatorBusy],
  );

  const loginDouyin = useCallback(async () => {
    if (loginBusy) return;

    setLoginBusy(true);
    setError("");
    try {
      setStatus(await streamProvider.loginDouyin());
    } catch (loginError) {
      setError(loginError?.message ?? "登录抖音失败");
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy]);

  const authenticated = Boolean(status?.authenticated);
  const refreshing = Boolean(status?.refreshing || creatorBusy);
  const catalogCount = status?.catalogCount;

  return (
    <main className="manager-shell">
      <header className="manager-titlebar">
        <div>
          <h1>博主管理</h1>
          <p>
            {creators.length} 位博主 ·{" "}
            {catalogCount === undefined
              ? "正在读取作品"
              : `${catalogCount} 个作品`}
          </p>
        </div>
        <button
          className="manager-close"
          type="button"
          aria-label="关闭博主管理"
          onClick={() => streamProvider.closeWindow()}
        >
          <X size={19} weight="bold" />
        </button>
      </header>

      <section className="manager-content">
        <div className="manager-status-row">
          <div
            className={`manager-status ${
              authenticated ? "manager-status-authenticated" : ""
            }`}
          >
            {refreshing ? (
              <SpinnerGap className="status-spinner" size={18} />
            ) : authenticated ? (
              <CheckCircle size={18} weight="fill" />
            ) : (
              <SignIn size={18} />
            )}
            <span>
              {refreshing
                ? "正在同步作品"
                : authenticated
                  ? "抖音已登录"
                  : "抖音访客模式"}
            </span>
          </div>

          {status?.available &&
          status.authRequired &&
          !authenticated ? (
            <button
              className="manager-login"
              type="button"
              disabled={loginBusy}
              onClick={loginDouyin}
            >
              {loginBusy ? "等待登录" : "登录抖音"}
            </button>
          ) : null}
        </div>

        <form className="manager-add-form" onSubmit={addCreator}>
          <input
            value={creatorInput}
            disabled={creatorBusy}
            placeholder="粘贴抖音博主主页分享链接"
            aria-label="抖音博主主页分享链接"
            onChange={(event) => setCreatorInput(event.target.value)}
          />
          <button
            type="submit"
            disabled={creatorBusy || !creatorInput.trim()}
            aria-label="添加博主"
          >
            <Plus size={21} weight="bold" />
          </button>
        </form>

        {error ? (
          <p className="manager-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="manager-list" aria-label="已添加博主">
          {creators.length ? (
            creators.map((creator) => (
              <article className="manager-creator" key={creator.secUid}>
                <div>
                  <strong>{creator.name || "抖音博主"}</strong>
                  <span>{creator.secUid.slice(-8)}</span>
                </div>
                <button
                  type="button"
                  disabled={creatorBusy}
                  aria-label={`删除 ${creator.name || "博主"}`}
                  onClick={() => removeCreator(creator.secUid)}
                >
                  <Trash size={18} />
                </button>
              </article>
            ))
          ) : (
            <div className="manager-empty">
              <p>还没有配置博主</p>
              <span>粘贴主页分享链接即可开始同步作品</span>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
