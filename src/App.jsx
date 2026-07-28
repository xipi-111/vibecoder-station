import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsOutSimple,
  GearSix,
  Pause,
  Play,
  PlugsConnected,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
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

function waitForPlayable(media, timeoutMs = 15_000) {
  if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("下一条作品缓冲超时"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      media.removeEventListener("canplay", onCanPlay);
      media.removeEventListener("error", onError);
    };
    const onCanPlay = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("下一条作品加载失败"));
    };

    media.addEventListener("canplay", onCanPlay, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

function waitForImage(image, timeoutMs = 15_000) {
  if (!image || (image.complete && image.naturalWidth > 0)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("下一条图文图片加载超时"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("下一条图文图片加载失败"));
    };

    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
  });
}

function nextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

export function App() {
  const rootRef = useRef(null);
  const surfaceElementsRef = useRef([null, null]);
  const mediaElementsRef = useRef([null, null]);
  const imageElementsRef = useRef([null, null]);
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
  const [imageIndexes, setImageIndexes] = useState([0, 0]);
  const [speed, setSpeed] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
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

    const loadInitial = () => {
      streamProvider
        .getInitial()
        .then((initialStream) => {
          if (active) setSlotStream(activeSlotRef.current, initialStream);
        })
        .catch((error) => {
          console.error("[stream] 无法取得首个作品", error);
        });
    };
    loadInitial();
    const unsubscribe = streamProvider.onPluginsChanged(() => {
      if (!slotsRef.current[activeSlotRef.current]?.id) loadInitial();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [setSlotStream]);

  useEffect(() => {
    if (!activeStream?.id) return;
    prefetchNext(activeStream.id, 1 - activeSlot).catch((error) => {
      console.error("[stream] 无法预载下一个作品", error);
    });
  }, [activeSlot, activeStream?.id, prefetchNext]);

  const handleMediaLoaded = useCallback((slotIndex) => {
    const media = mediaElementsRef.current[slotIndex];
    const surface = surfaceElementsRef.current[slotIndex];
    if (!media || !surface) return;

    const settings = playbackSettingsRef.current;
    media.playbackRate = settings.speed;
    media.muted = settings.muted;

    if (slotIndex === activeSlotRef.current) {
      utils.set(surface, { y: "0%", opacity: 1 });
      media.play().catch(() => setPlaying(false));
      setPlaying(true);
    } else {
      media.pause();
      media.currentTime = 0;
      utils.set(surface, { y: "100%", opacity: 1 });
      setImageIndexes((current) => {
        const next = [...current];
        next[slotIndex] = 0;
        return next;
      });
    }
  }, []);

  const playNext = useCallback(async () => {
    if (switchingRef.current) return;
    const currentSlot = activeSlotRef.current;
    const currentStream = slotsRef.current[currentSlot];
    const currentMedia = mediaElementsRef.current[currentSlot];
    const currentSurface = surfaceElementsRef.current[currentSlot];
    if (!currentStream || !currentMedia || !currentSurface) return;

    const targetSlot = 1 - currentSlot;
    const shouldResume = !currentMedia.paused && !currentMedia.ended;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    switchingRef.current = true;
    setSpeedMenuOpen(false);

    try {
      const prefetched = await prefetchNext(
        currentStream.id,
        targetSlot,
      );
      await nextPaint();

      const nextMedia = mediaElementsRef.current[prefetched.targetSlot];
      const nextSurface = surfaceElementsRef.current[prefetched.targetSlot];
      if (!nextMedia || !nextSurface) {
        throw new Error("下一条作品元素尚未就绪");
      }
      await Promise.all([
        waitForPlayable(nextMedia),
        prefetched.nextStream.kind === "image"
          ? waitForImage(imageElementsRef.current[prefetched.targetSlot])
          : Promise.resolve(),
      ]);

      const settings = playbackSettingsRef.current;
      nextMedia.currentTime = 0;
      nextMedia.playbackRate = settings.speed;
      nextMedia.muted = settings.muted;
      setImageIndexes((current) => {
        const next = [...current];
        next[prefetched.targetSlot] = 0;
        return next;
      });
      utils.set(nextSurface, { y: "100%", opacity: 1 });
      currentMedia.pause();
      await nextMedia.play();

      if (reducedMotion) {
        utils.set(currentSurface, { y: "-100%" });
        utils.set(nextSurface, { y: "0%" });
      } else {
        await Promise.all([
          new Promise((resolve) => {
            animate(currentSurface, {
              y: "-100%",
              duration: 420,
              ease: "inOut(3)",
              onComplete: resolve,
            });
          }),
          new Promise((resolve) => {
            animate(nextSurface, {
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
      currentMedia.currentTime = 0;
      if (prefetchRef.current?.afterId === currentStream.id) {
        prefetchRef.current = null;
      }
    } catch (error) {
      console.error("[stream] 无法切换到下一个作品", error);
      utils.set(currentSurface, { y: "0%", opacity: 1 });
      const nextMedia = mediaElementsRef.current[targetSlot];
      const nextSurface = surfaceElementsRef.current[targetSlot];
      if (nextMedia) {
        nextMedia.pause();
      }
      if (nextSurface) {
        utils.set(nextSurface, { y: "100%", opacity: 1 });
      }
      if (shouldResume) {
        currentMedia
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
    const media = mediaElementsRef.current[activeSlotRef.current];
    if (!media) return;

    if (media.paused) {
      media.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      media.pause();
      setPlaying(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const activeMedia = mediaElementsRef.current[activeSlotRef.current];
    if (!activeMedia) return;
    const nextMuted = !activeMedia.muted;
    playbackSettingsRef.current.muted = nextMuted;
    for (const media of mediaElementsRef.current) {
      if (media) media.muted = nextMuted;
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

  const updateProgress = useCallback((slotIndex, media) => {
    if (
      slotIndex !== activeSlotRef.current ||
      !media?.duration
    ) {
      return;
    }
    const nextProgress = media.currentTime / media.duration;
    setProgress(nextProgress * 100);

    const stream = slotsRef.current[slotIndex];
    const imageCount = stream?.imageUrls?.length ?? 0;
    if (stream?.kind === "image" && imageCount > 1) {
      const nextImageIndex = Math.min(
        imageCount - 1,
        Math.floor(nextProgress * imageCount),
      );
      setImageIndexes((current) => {
        if (current[slotIndex] === nextImageIndex) return current;
        const next = [...current];
        next[slotIndex] = nextImageIndex;
        return next;
      });
    }
  }, []);

  const seek = useCallback((event) => {
    const media = mediaElementsRef.current[activeSlotRef.current];
    if (!media?.duration) return;
    const nextProgress = Number(event.target.value);
    media.currentTime = (nextProgress / 100) * media.duration;
    setProgress(nextProgress);
  }, []);

  const selectSpeed = useCallback((nextSpeed) => {
    playbackSettingsRef.current.speed = nextSpeed;
    for (const media of mediaElementsRef.current) {
      if (media) media.playbackRate = nextSpeed;
    }
    setSpeed(nextSpeed);
    setSpeedMenuOpen(false);
  }, []);

  const openSourceManager = useCallback(() => {
    setSpeedMenuOpen(false);
    streamProvider.openSourceManager().catch((error) => {
      console.error("[plugins] 无法打开内容源管理窗口", error);
    });
  }, []);

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
                label="管理内容源"
                onClick={openSourceManager}
              >
                <PlugsConnected size={27} weight="regular" />
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
            <div
              ref={(node) => {
                surfaceElementsRef.current[slotIndex] = node;
              }}
              key={`work-slot-${slotIndex}`}
              className="work-surface"
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
              aria-label={
                slotIndex === activeSlot
                  ? "当前播放作品"
                  : "已预载的下一个作品"
              }
            >
              {slotStream.kind === "image" ? (
                <>
                  <img
                    key={`image-backdrop-${slotStream.imageUrls[
                      imageIndexes[slotIndex] ?? 0
                    ]}`}
                    className="image-backdrop"
                    src={
                      slotStream.imageUrls[imageIndexes[slotIndex] ?? 0]
                    }
                    alt=""
                    aria-hidden="true"
                  />
                  <img
                    ref={(node) => {
                      imageElementsRef.current[slotIndex] = node;
                    }}
                    key={`image-${slotStream.imageUrls[
                      imageIndexes[slotIndex] ?? 0
                    ]}`}
                    className="image-surface"
                    src={
                      slotStream.imageUrls[imageIndexes[slotIndex] ?? 0]
                    }
                    alt="抖音图文作品"
                  />
                  <audio
                    ref={(node) => {
                      mediaElementsRef.current[slotIndex] = node;
                    }}
                    className="work-audio"
                    src={slotStream.streamUrl}
                    autoPlay={slotIndex === activeSlot}
                    muted={muted}
                    preload="auto"
                    onLoadedData={() => handleMediaLoaded(slotIndex)}
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
                  />
                </>
              ) : (
                <video
                  ref={(node) => {
                    mediaElementsRef.current[slotIndex] = node;
                    imageElementsRef.current[slotIndex] = null;
                  }}
                  className="video-surface"
                  src={slotStream.streamUrl}
                  poster={slotStream.posterUrl}
                  autoPlay={slotIndex === activeSlot}
                  muted={muted}
                  playsInline
                  preload="auto"
                  onLoadedData={() => handleMediaLoaded(slotIndex)}
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
                />
              )}
            </div>
          ) : null,
        )}

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
            label="下一个作品"
            onClick={playNext}
          >
            <SkipForward size={43} weight="fill" />
          </IconButton>
        </div>

        <div className="bottom-left-controls">
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
            aria-label="作品进度"
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
