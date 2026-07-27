import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsOutSimple,
  GearSix,
  Pause,
  Play,
  Plus,
  SkipForward,
  SignIn,
  SpeakerHigh,
  SpeakerSlash,
  Trash,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { animate, createScope, utils } from "animejs";
import { streamProvider } from "./services/streamProvider.js";

const HIDE_DELAY_MS = 800;
const SPEEDS = [0.75, 1, 1.25, 1.5];

function IconButton({ label, className = "", children, ...props }) {
  return (
    <button
      className={`icon-button ${className}`}
      type="button"
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}

function waitForPlayable(video, timeoutMs = 15_000) {
  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("下一条视频缓冲超时"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
    };
    const onCanPlay = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("下一条视频加载失败"));
    };

    video.addEventListener("canplay", onCanPlay, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function nextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

export function App() {
  const rootRef = useRef(null);
  const videoElementsRef = useRef([null, null]);
  const slotsRef = useRef([
    streamProvider.getPlaceholder(),
    null,
  ]);
  const activeSlotRef = useRef(0);
  const prefetchRef = useRef(null);
  const playbackSettingsRef = useRef({ muted: true, speed: 1 });
  const scopeRef = useRef(null);
  const hideTimerRef = useRef(null);
  const switchingRef = useRef(false);
  const pointerInsideRef = useRef(false);

  const [videoSlots, setVideoSlots] = useState(
    () => slotsRef.current,
  );
  const [activeSlot, setActiveSlot] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [douyinStatus, setDouyinStatus] = useState(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [creatorPanelOpen, setCreatorPanelOpen] = useState(false);
  const [creators, setCreators] = useState([]);
  const [creatorInput, setCreatorInput] = useState("");
  const [creatorBusy, setCreatorBusy] = useState(false);
  const [creatorError, setCreatorError] = useState("");
  const activeStream = videoSlots[activeSlot];

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const revealControls = useCallback(() => {
    clearHideTimer();
    setControlsVisible(true);
  }, [clearHideTimer]);

  const scheduleHideControls = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      setSpeedMenuOpen(false);
      setCreatorPanelOpen(false);
    }, HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const setSlotStream = useCallback((slotIndex, nextStream) => {
    setVideoSlots((current) => {
      const next = [...current];
      next[slotIndex] = nextStream;
      slotsRef.current = next;
      return next;
    });
  }, []);

  const prefetchNext = useCallback(
    (afterId, targetSlot = 1 - activeSlotRef.current) => {
      const existing = prefetchRef.current;
      if (existing?.afterId === afterId) return existing.promise;

      const promise = streamProvider
        .getNext(afterId)
        .then((nextStream) => {
          setSlotStream(targetSlot, nextStream);
          return { nextStream, targetSlot };
        })
        .catch((error) => {
          if (prefetchRef.current?.promise === promise) {
            prefetchRef.current = null;
          }
          throw error;
        });

      prefetchRef.current = { afterId, targetSlot, promise };
      return promise;
    },
    [setSlotStream],
  );

  useEffect(() => {
    scopeRef.current = createScope({
      root: rootRef,
      mediaQueries: {
        reduce: "(prefers-reduced-motion: reduce)",
      },
    }).add((self) => {
      const duration = (value) => (self.matches.reduce ? 0 : value);

      self.add("showControls", () => {
        animate(".primary-control", {
          opacity: 1,
          scale: 1,
          duration: duration(190),
          ease: "out(3)",
        });
        animate(".corner-control", {
          opacity: 1,
          y: 0,
          duration: duration(170),
          ease: "out(3)",
        });
        animate(".progress-control", {
          opacity: 1,
          y: 0,
          duration: duration(190),
          ease: "out(3)",
        });
      });

      self.add("hideControls", () => {
        animate(".player-control", {
          opacity: 0,
          duration: duration(140),
          ease: "out(2)",
        });
        animate(".primary-control", {
          scale: 0.92,
          duration: duration(140),
          ease: "out(2)",
        });
        animate(".corner-control", {
          y: 8,
          duration: duration(140),
          ease: "out(2)",
        });
        animate(".progress-control", {
          y: 6,
          duration: duration(140),
          ease: "out(2)",
        });
      });

      utils.set(".player-control", { opacity: 0 });
      utils.set(".primary-control", { scale: 0.92 });
      utils.set(".corner-control", { y: 8 });
      utils.set(".progress-control", { y: 6 });
    });

    return () => scopeRef.current?.revert();
  }, []);

  useEffect(() => {
    const method = controlsVisible ? "showControls" : "hideControls";
    scopeRef.current?.methods[method]?.();
  }, [controlsVisible]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const player = rootRef.current;
    if (!player) return undefined;

    const onEnter = () => {
      pointerInsideRef.current = true;
      revealControls();
    };
    const onLeave = () => {
      pointerInsideRef.current = false;
      scheduleHideControls();
    };
    const onWindowMove = (event) => {
      const bounds = player.getBoundingClientRect();
      const isInside =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;

      if (isInside && !pointerInsideRef.current) {
        onEnter();
      } else if (!isInside && pointerInsideRef.current) {
        onLeave();
      }
    };

    player.addEventListener("pointerenter", onEnter);
    player.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("blur", onLeave);

    return () => {
      player.removeEventListener("pointerenter", onEnter);
      player.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("blur", onLeave);
    };
  }, [revealControls, scheduleHideControls]);

  useEffect(() => {
    return () => clearHideTimer();
  }, [clearHideTimer]);

  useEffect(() => {
    let active = true;

    streamProvider
      .getInitial()
      .then((initialStream) => {
        if (active) setSlotStream(0, initialStream);
      })
      .catch((error) => {
        console.error("[stream] 无法取得首个视频", error);
      });

    return () => {
      active = false;
    };
  }, [setSlotStream]);

  useEffect(() => {
    if (!activeStream?.id) return;
    prefetchNext(activeStream.id, 1 - activeSlot).catch((error) => {
      console.error("[stream] 无法预载下一个视频", error);
    });
  }, [activeSlot, activeStream?.id, prefetchNext]);

  useEffect(() => {
    if (!streamProvider.isDesktop) return undefined;
    let active = true;

    const updateStatus = () => {
      streamProvider
        .getDouyinStatus()
        .then((status) => {
          if (active) setDouyinStatus(status);
        })
        .catch((error) => {
          console.error("[douyin] 无法读取登录状态", error);
        });
    };

    updateStatus();
    const timer = window.setInterval(updateStatus, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const loadCreators = useCallback(() => {
    if (!streamProvider.isDesktop) return Promise.resolve();
    return streamProvider
      .listCreators()
      .then((result) => {
        setCreators(result.creators ?? []);
        return result;
      })
      .catch((error) => {
        console.error("[creators] 无法读取博主配置", error);
      });
  }, []);

  useEffect(() => {
    loadCreators();
  }, [loadCreators]);

  const handleVideoLoaded = useCallback((slotIndex) => {
    const video = videoElementsRef.current[slotIndex];
    if (!video) return;

    const settings = playbackSettingsRef.current;
    video.playbackRate = settings.speed;
    video.muted = settings.muted;

    if (slotIndex === activeSlotRef.current) {
      utils.set(video, { y: "0%", opacity: 1 });
      video.play().catch(() => setPlaying(false));
      setPlaying(true);
    } else {
      video.pause();
      video.currentTime = 0;
      utils.set(video, { y: "100%", opacity: 1 });
    }
  }, []);

  const playNext = useCallback(async () => {
    if (switchingRef.current) return;
    const currentSlot = activeSlotRef.current;
    const currentStream = slotsRef.current[currentSlot];
    const currentVideo = videoElementsRef.current[currentSlot];
    if (!currentStream || !currentVideo) return;

    const targetSlot = 1 - currentSlot;
    const shouldResume = !currentVideo.paused && !currentVideo.ended;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    switchingRef.current = true;
    setSpeedMenuOpen(false);
    setCreatorPanelOpen(false);

    try {
      const prefetched = await prefetchNext(
        currentStream.id,
        targetSlot,
      );
      await nextPaint();

      const nextVideo = videoElementsRef.current[prefetched.targetSlot];
      if (!nextVideo) throw new Error("下一条视频元素尚未就绪");
      await waitForPlayable(nextVideo);

      const settings = playbackSettingsRef.current;
      nextVideo.currentTime = 0;
      nextVideo.playbackRate = settings.speed;
      nextVideo.muted = settings.muted;
      utils.set(nextVideo, { y: "100%", opacity: 1 });
      currentVideo.pause();
      await nextVideo.play();

      if (reducedMotion) {
        utils.set(currentVideo, { y: "-100%" });
        utils.set(nextVideo, { y: "0%" });
      } else {
        await Promise.all([
          new Promise((resolve) => {
            animate(currentVideo, {
              y: "-100%",
              duration: 420,
              ease: "inOut(3)",
              onComplete: resolve,
            });
          }),
          new Promise((resolve) => {
            animate(nextVideo, {
              y: "0%",
              duration: 420,
              ease: "inOut(3)",
              onComplete: resolve,
            });
          }),
        ]);
      }

      activeSlotRef.current = prefetched.targetSlot;
      setActiveSlot(prefetched.targetSlot);
      setProgress(0);
      setPlaying(true);
      currentVideo.currentTime = 0;
      if (prefetchRef.current?.afterId === currentStream.id) {
        prefetchRef.current = null;
      }
    } catch (error) {
      console.error("[stream] 无法切换到下一个视频", error);
      utils.set(currentVideo, { y: "0%", opacity: 1 });
      const nextVideo = videoElementsRef.current[targetSlot];
      if (nextVideo) {
        nextVideo.pause();
        utils.set(nextVideo, { y: "100%", opacity: 1 });
      }
      if (shouldResume) {
        currentVideo
          .play()
          .then(() => setPlaying(true))
          .catch(() => setPlaying(false));
      } else {
        setPlaying(false);
      }
    } finally {
      switchingRef.current = false;
    }
  }, [prefetchNext]);

  const togglePlayback = useCallback(() => {
    const video =
      videoElementsRef.current[activeSlotRef.current];
    if (!video) return;

    if (video.paused) {
      video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const activeVideo =
      videoElementsRef.current[activeSlotRef.current];
    if (!activeVideo) return;
    const nextMuted = !activeVideo.muted;
    playbackSettingsRef.current.muted = nextMuted;
    for (const video of videoElementsRef.current) {
      if (video) video.muted = nextMuted;
    }
    setMuted(nextMuted);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await rootRef.current?.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  }, []);

  const updateProgress = useCallback((slotIndex, video) => {
    if (
      slotIndex !== activeSlotRef.current ||
      !video?.duration
    ) {
      return;
    }
    setProgress((video.currentTime / video.duration) * 100);
  }, []);

  const seek = useCallback((event) => {
    const video =
      videoElementsRef.current[activeSlotRef.current];
    if (!video?.duration) return;
    const nextProgress = Number(event.target.value);
    video.currentTime = (nextProgress / 100) * video.duration;
    setProgress(nextProgress);
  }, []);

  const selectSpeed = useCallback((nextSpeed) => {
    playbackSettingsRef.current.speed = nextSpeed;
    for (const video of videoElementsRef.current) {
      if (video) video.playbackRate = nextSpeed;
    }
    setSpeed(nextSpeed);
    setSpeedMenuOpen(false);
  }, []);

  const loginDouyin = useCallback(async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    try {
      const status = await streamProvider.loginDouyin();
      setDouyinStatus(status);
    } catch (error) {
      console.error("[douyin] 登录失败", error);
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy]);

  const toggleCreatorPanel = useCallback(() => {
    setSpeedMenuOpen(false);
    setCreatorError("");
    setCreatorPanelOpen((open) => {
      if (!open) loadCreators();
      return !open;
    });
  }, [loadCreators]);

  const addCreator = useCallback(
    async (event) => {
      event.preventDefault();
      const value = creatorInput.trim();
      if (!value || creatorBusy) return;

      setCreatorBusy(true);
      setCreatorError("");
      try {
        const result = await streamProvider.addCreator(value);
        setCreators(result.creators ?? []);
        setCreatorInput("");
        setDouyinStatus(await streamProvider.getDouyinStatus());
        const currentSlot = activeSlotRef.current;
        if (!slotsRef.current[currentSlot]) {
          setSlotStream(
            currentSlot,
            await streamProvider.getInitial(),
          );
        }
      } catch (error) {
        setCreatorError(error?.message ?? "添加博主失败");
      } finally {
        setCreatorBusy(false);
      }
    },
    [creatorBusy, creatorInput, setSlotStream],
  );

  const removeCreator = useCallback(
    async (secUid) => {
      if (creatorBusy) return;
      setCreatorBusy(true);
      setCreatorError("");
      try {
        const result = await streamProvider.removeCreator(secUid);
        setCreators(result.creators ?? []);
        setDouyinStatus(await streamProvider.getDouyinStatus());
      } catch (error) {
        setCreatorError(error?.message ?? "删除博主失败");
      } finally {
        setCreatorBusy(false);
      }
    },
    [creatorBusy],
  );

  return (
    <main className="stage">
      <section
        ref={rootRef}
        className={`player ${controlsVisible ? "controls-visible" : ""}`}
        aria-label="VibeCoder 加油站播放器"
        onPointerEnter={revealControls}
        onPointerMove={revealControls}
        onPointerLeave={scheduleHideControls}
        onFocusCapture={revealControls}
        onBlurCapture={scheduleHideControls}
        onDoubleClick={toggleFullscreen}
      >
        {streamProvider.isDesktop ? (
          <div className="window-drag-region" aria-hidden="true" />
        ) : null}

        {streamProvider.isDesktop ? (
          <>
            <div className="top-left-controls">
              <IconButton
                className="player-control corner-control utility-control"
                label="管理博主"
                aria-expanded={creatorPanelOpen}
                onClick={toggleCreatorPanel}
              >
                <UsersThree size={27} weight="regular" />
              </IconButton>
            </div>
            <div className="top-right-controls">
              <IconButton
                className="player-control corner-control window-close-control"
                label="关闭窗口"
                onClick={() => streamProvider.closeWindow()}
              >
                <X size={23} weight="bold" />
              </IconButton>
            </div>
          </>
        ) : null}

        {videoSlots.map((slotStream, slotIndex) =>
          slotStream ? (
            <video
              ref={(node) => {
                videoElementsRef.current[slotIndex] = node;
              }}
              key={`video-slot-${slotIndex}`}
              className="video-surface"
              src={slotStream.streamUrl}
              poster={slotStream.posterUrl}
              autoPlay={slotIndex === activeSlot}
              muted={muted}
              playsInline
              preload="auto"
              aria-hidden={slotIndex !== activeSlot}
              style={{
                transform: `translateY(${
                  slotIndex === activeSlot ? "0%" : "100%"
                })`,
                zIndex: slotIndex === activeSlot ? 1 : 2,
                pointerEvents:
                  slotIndex === activeSlot ? "auto" : "none",
              }}
              onClick={
                slotIndex === activeSlot ? togglePlayback : undefined
              }
              onLoadedData={() => handleVideoLoaded(slotIndex)}
              onTimeUpdate={(event) =>
                updateProgress(slotIndex, event.currentTarget)
              }
              onEnded={
                slotIndex === activeSlot ? playNext : undefined
              }
              onPlay={() => {
                if (slotIndex === activeSlotRef.current) {
                  setPlaying(true);
                }
              }}
              onPause={() => {
                if (
                  slotIndex === activeSlotRef.current &&
                  !switchingRef.current
                ) {
                  setPlaying(false);
                }
              }}
              aria-label={
                slotIndex === activeSlot
                  ? "当前播放视频"
                  : "已预载的下一个视频"
              }
            />
          ) : null,
        )}

        {creatorPanelOpen ? (
          <section
            className="player-control corner-control creator-panel"
            aria-label="博主管理"
          >
            <div className="creator-panel-header">
              <div>
                <strong>博主</strong>
                <span>{creators.length} 个</span>
              </div>
              <button
                className="panel-close-button"
                type="button"
                aria-label="关闭博主管理"
                onClick={() => setCreatorPanelOpen(false)}
              >
                <X size={18} weight="bold" />
              </button>
            </div>

            <form className="creator-add-form" onSubmit={addCreator}>
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
                <Plus size={20} weight="bold" />
              </button>
            </form>

            {creatorError ? (
              <p className="creator-error" role="alert">
                {creatorError}
              </p>
            ) : null}

            <div className="creator-list">
              {creators.length ? (
                creators.map((creator) => (
                  <div className="creator-row" key={creator.secUid}>
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
                      <Trash size={18} weight="regular" />
                    </button>
                  </div>
                ))
              ) : (
                <p className="creator-empty">还没有配置博主</p>
              )}
            </div>

            {creatorBusy ? (
              <p className="creator-working">正在识别并同步作品…</p>
            ) : null}
          </section>
        ) : null}

        <div className="primary-actions" aria-label="主要播放控制">
          <IconButton
            className="player-control primary-control"
            label={playing ? "暂停" : "播放"}
            onClick={togglePlayback}
          >
            {playing ? (
              <Pause size={44} weight="fill" />
            ) : (
              <Play size={44} weight="fill" />
            )}
          </IconButton>
          <IconButton
            className="player-control primary-control"
            label="下一个视频"
            onClick={playNext}
          >
            <SkipForward size={43} weight="fill" />
          </IconButton>
        </div>

        <div className="bottom-left-controls">
          {douyinStatus?.available &&
          douyinStatus.authRequired &&
          !douyinStatus.authenticated ? (
            <IconButton
              className="player-control corner-control login-control"
              label="登录抖音以加载全部作品"
              disabled={loginBusy}
              onClick={loginDouyin}
            >
              <SignIn size={24} weight="regular" />
              <span>{loginBusy ? "等待登录" : "登录抖音"}</span>
            </IconButton>
          ) : null}
          <IconButton
            className="player-control corner-control utility-control"
            label={muted ? "打开声音" : "静音"}
            onClick={toggleMute}
          >
            {muted ? (
              <SpeakerSlash size={29} weight="regular" />
            ) : (
              <SpeakerHigh size={29} weight="regular" />
            )}
          </IconButton>
        </div>

        <div className="bottom-right-controls">
          <div className="speed-menu-wrap">
            <div
              className={`speed-menu ${speedMenuOpen ? "speed-menu-open" : ""}`}
              aria-hidden={!speedMenuOpen}
            >
              {SPEEDS.map((value) => (
                <button
                  key={value}
                  className={value === speed ? "active" : ""}
                  type="button"
                  tabIndex={speedMenuOpen ? 0 : -1}
                  onClick={() => selectSpeed(value)}
                >
                  {value}×
                </button>
              ))}
            </div>
            <IconButton
              className="player-control corner-control utility-control"
              label={`播放速度，当前 ${speed} 倍`}
              aria-expanded={speedMenuOpen}
              onClick={() => setSpeedMenuOpen((open) => !open)}
            >
              <GearSix size={29} weight="regular" />
            </IconButton>
          </div>

          <IconButton
            className="player-control corner-control utility-control"
            label={isFullscreen ? "退出全屏" : "进入全屏"}
            onClick={toggleFullscreen}
          >
            <ArrowsOutSimple size={29} weight="regular" />
          </IconButton>
        </div>

        <div className="player-control progress-control">
          <input
            aria-label="视频进度"
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={progress}
            onChange={seek}
            style={{ "--progress": `${progress}%` }}
          />
        </div>
      </section>
    </main>
  );
}
