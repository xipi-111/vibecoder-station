# Player control motion

- Purpose: reveal player controls only when the user expresses intent, without competing with the video.
- Trigger: pointer enter, keyboard focus, or touch reveals; pointer leave hides after 800 ms.
- Primary controls: opacity `0 → 1` and scale `0.92 → 1` in 190 ms, `out(3)`.
- Corner controls: opacity `0 → 1` and translateY `8 → 0` in 170 ms.
- Progress: opacity `0 → 1` and translateY `6 → 0` in 190 ms.
- Hide: all controls fade in 140 ms. Pointer events disable immediately after the hidden state is committed.
- Interruption: new animations replace the same properties; the pending leave timer is always cancelled on re-entry.
- Reduced motion: controls move directly to their final visible or hidden state with zero duration.
- Stream switch: current video fades to 0 in 120 ms, the next stream loads, then fades to 1 in 220 ms.
