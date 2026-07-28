import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  DownloadSimple,
  Package,
  Plus,
  SignIn,
  SpinnerGap,
  Trash,
  X,
} from "@phosphor-icons/react";
import { streamProvider } from "./services/streamProvider.js";

const STATUS_POLL_MS = 4_000;

export function ManagerApp() {
  const [plugins, setPlugins] = useState([]);
  const [selectedPluginId, setSelectedPluginId] = useState("");
  const [collections, setCollections] = useState([]);
  const [status, setStatus] = useState(null);
  const [collectionInput, setCollectionInput] = useState("");
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedPlugin = useMemo(
    () => plugins.find((plugin) => plugin.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  );
  const pluginUi = selectedPlugin?.ui ?? {};

  const refreshPlugins = useCallback(async () => {
    const result = await streamProvider.listPlugins();
    const nextPlugins = result.plugins ?? [];
    setPlugins(nextPlugins);
    setSelectedPluginId((current) => {
      if (nextPlugins.some((plugin) => plugin.id === current)) return current;
      return nextPlugins.find((plugin) => plugin.available)?.id ?? "";
    });
    return nextPlugins;
  }, []);

  const refreshSelectedPlugin = useCallback(async () => {
    if (!selectedPluginId) {
      setCollections([]);
      setStatus(null);
      return;
    }
    const [collectionResult, pluginStatus] = await Promise.all([
      streamProvider.listCollections(selectedPluginId),
      streamProvider.getPluginStatus(selectedPluginId),
    ]);
    setCollections(collectionResult.items ?? []);
    setStatus(pluginStatus);
  }, [selectedPluginId]);

  useEffect(() => {
    let active = true;
    const update = () => {
      refreshPlugins().catch((refreshError) => {
        if (active) {
          setError(refreshError?.message ?? "无法读取已安装插件");
        }
      });
    };
    update();
    const unsubscribe = streamProvider.onPluginsChanged(update);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refreshPlugins]);

  useEffect(() => {
    let active = true;
    const update = () => {
      refreshSelectedPlugin().catch((refreshError) => {
        if (active) {
          setError(refreshError?.message ?? "无法读取插件配置");
        }
      });
    };
    update();
    const timer = window.setInterval(update, STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshSelectedPlugin]);

  const installPlugin = useCallback(async () => {
    if (installBusy) return;
    setInstallBusy(true);
    setError("");
    try {
      const result = await streamProvider.installPlugin();
      if (result.canceled) return;
      setPlugins(result.plugins ?? []);
      if (result.installed?.id) {
        setSelectedPluginId(result.installed.id);
      }
    } catch (installError) {
      setError(installError?.message ?? "插件安装失败");
    } finally {
      setInstallBusy(false);
    }
  }, [installBusy]);

  const addCollection = useCallback(
    async (event) => {
      event.preventDefault();
      const value = collectionInput.trim();
      if (!selectedPluginId || !value || collectionBusy) return;

      setCollectionBusy(true);
      setError("");
      try {
        const result = await streamProvider.addCollection(
          selectedPluginId,
          value,
        );
        setCollections(result.items ?? []);
        setCollectionInput("");
        setStatus(await streamProvider.getPluginStatus(selectedPluginId));
      } catch (addError) {
        setError(addError?.message ?? "添加失败");
      } finally {
        setCollectionBusy(false);
      }
    },
    [collectionBusy, collectionInput, selectedPluginId],
  );

  const removeCollection = useCallback(
    async (collectionId) => {
      if (!selectedPluginId || collectionBusy) return;

      setCollectionBusy(true);
      setError("");
      try {
        const result = await streamProvider.removeCollection(
          selectedPluginId,
          collectionId,
        );
        setCollections(result.items ?? []);
        setStatus(await streamProvider.getPluginStatus(selectedPluginId));
      } catch (removeError) {
        setError(removeError?.message ?? "删除失败");
      } finally {
        setCollectionBusy(false);
      }
    },
    [collectionBusy, selectedPluginId],
  );

  const loginPlugin = useCallback(async () => {
    if (!selectedPluginId || loginBusy) return;

    setLoginBusy(true);
    setError("");
    try {
      setStatus(await streamProvider.loginPlugin(selectedPluginId));
    } catch (loginError) {
      setError(loginError?.message ?? "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy, selectedPluginId]);

  const authenticated = Boolean(status?.authenticated);
  const refreshing = Boolean(status?.refreshing || collectionBusy);
  const catalogCount = status?.catalogCount;
  const syncProcessed = Number(status?.syncProcessed) || 0;
  const syncTotal = Number(status?.syncTotal) || 0;
  const syncingLabel =
    syncTotal > 0 && syncProcessed < syncTotal
      ? `${pluginUi.syncingStatusLabel ?? "正在同步作品"} ${syncProcessed}/${syncTotal}`
      : pluginUi.syncingStatusLabel ?? "正在同步作品";
  const collectionLabel = pluginUi.collectionLabel ?? "集合";
  const collectionPluralLabel =
    pluginUi.collectionPluralLabel ?? collectionLabel;

  return (
    <main className="manager-shell">
      <header className="manager-titlebar">
        <div>
          <h1>内容源</h1>
          <p>
            {plugins.length} 个插件
            {selectedPlugin && catalogCount !== undefined
              ? ` · ${catalogCount} 个作品`
              : ""}
          </p>
        </div>
        <div className="manager-title-actions">
          <button
            className="manager-install"
            type="button"
            disabled={installBusy}
            aria-label="安装插件"
            title="安装插件"
            onClick={installPlugin}
          >
            {installBusy ? (
              <SpinnerGap className="status-spinner" size={19} />
            ) : (
              <DownloadSimple size={19} weight="bold" />
            )}
          </button>
          <button
            className="manager-close"
            type="button"
            aria-label="关闭内容源管理"
            onClick={() => streamProvider.closeWindow()}
          >
            <X size={19} weight="bold" />
          </button>
        </div>
      </header>

      <section className="manager-content">
        {plugins.length ? (
          <section className="plugin-list" aria-label="已安装插件">
            {plugins.map((plugin) => (
              <button
                className={`plugin-card ${
                  plugin.id === selectedPluginId ? "plugin-card-active" : ""
                }`}
                type="button"
                key={plugin.id}
                disabled={!plugin.available}
                onClick={() => {
                  setSelectedPluginId(plugin.id);
                  setCollectionInput("");
                  setError(plugin.error ?? "");
                }}
              >
                <Package size={20} weight="fill" />
                <span>
                  <strong>{plugin.name}</strong>
                  <small>
                    {plugin.available ? `v${plugin.version}` : plugin.error}
                  </small>
                </span>
              </button>
            ))}
          </section>
        ) : (
          <section className="plugin-empty">
            <Package size={34} weight="duotone" />
            <p>还没有安装内容源插件</p>
            <span>安装插件后，播放器才会获得对应平台的播放能力</span>
            <button type="button" disabled={installBusy} onClick={installPlugin}>
              安装插件
            </button>
          </section>
        )}

        {selectedPlugin ? (
          <>
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
                    ? syncingLabel
                    : authenticated
                      ? pluginUi.authenticatedStatusLabel ?? "已登录"
                      : pluginUi.guestStatusLabel ?? "未登录"}
                </span>
              </div>

              {selectedPlugin.capabilities?.authentication &&
              status?.authRequired &&
              !authenticated ? (
                <button
                  className="manager-login"
                  type="button"
                  disabled={loginBusy}
                  onClick={loginPlugin}
                >
                  {loginBusy
                    ? "等待登录"
                    : pluginUi.loginActionLabel ?? "登录"}
                </button>
              ) : null}
            </div>

            {selectedPlugin.capabilities?.collections ? (
              <>
                <form className="manager-add-form" onSubmit={addCollection}>
                  <input
                    value={collectionInput}
                    disabled={collectionBusy}
                    placeholder={
                      pluginUi.inputPlaceholder ?? `添加${collectionLabel}`
                    }
                    aria-label={`添加${collectionLabel}`}
                    onChange={(event) =>
                      setCollectionInput(event.target.value)
                    }
                  />
                  <button
                    type="submit"
                    disabled={collectionBusy || !collectionInput.trim()}
                    aria-label={`添加${collectionLabel}`}
                  >
                    <Plus size={21} weight="bold" />
                  </button>
                </form>

                <section
                  className="manager-list"
                  aria-label={`已添加${collectionPluralLabel}`}
                >
                  {collections.length ? (
                    collections.map((collection) => (
                      <article
                        className="manager-creator"
                        key={collection.id}
                      >
                        <div>
                          <strong>{collection.name || collectionLabel}</strong>
                          <span>{collection.subtitle ?? ""}</span>
                        </div>
                        <button
                          type="button"
                          disabled={collectionBusy}
                          aria-label={`删除 ${
                            collection.name || collectionLabel
                          }`}
                          onClick={() => removeCollection(collection.id)}
                        >
                          <Trash size={18} />
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="manager-empty">
                      <p>
                        {pluginUi.emptyTitle ??
                          `还没有配置${collectionPluralLabel}`}
                      </p>
                      <span>
                        {pluginUi.emptyHint ?? `添加${collectionLabel}即可开始`}
                      </span>
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </>
        ) : null}

        {error ? (
          <p className="manager-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
