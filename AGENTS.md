# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product decisions

- The app is a portrait desktop video player, not a feed, discovery surface, dashboard, or creator-management tool.
- The shipping target is a frameless Electron desktop app for macOS and Windows, never a hosted website.
- The video stream fills the entire player window edge to edge.
- When the pointer is outside the player window, show only video: no title bar, logo, metadata, gradient, progress, cursor treatment, or controls.
- When the pointer enters, reveal all controls as overlays inside the video. Hide them 800 ms after the pointer leaves.
- The primary controls are pause/play and next. Volume, playback speed/settings, fullscreen, and progress are secondary.
- A close-window button and creator-management entry appear in the video overlay on hover; the frameless window must never require Command+Q just to close it.
- Creator management accepts pasted Douyin profile share links, supports add/remove, and persists to the app-owned user-data config instead of requiring edits to packaged JSON.
- Video selection rules and Douyin API integration are background concerns and must not add permanent UI.
- Keep two persistent video surfaces. Preload the next item while the current one plays, retain the current frame until the next surface is playable, then transition both surfaces upward as one continuous full-screen gesture. Never fade through the player background.
- Respect reduced-motion preferences by swapping the two prepared video surfaces without travel animation.
- Upstream Douyin URLs, cookies, authorization headers, and refresh tokens stay in the Electron main process or the resolver backend. The renderer only receives `vibecoder-media://` URLs.
- The built-in Douyin source may use an app-owned persistent session. Never import, inspect, or copy the user's Chrome cookies.
- Treat a creator catalog as complete only after pagination returns `has_more=false`. Guest-mode partial results may play, but the hover-only login action must clearly unlock the complete catalog.
- Treat Douyin image posts as first-class works: play their original soundtrack while advancing through the images, using the same controls and two-surface transition as videos.
- In creator management, show the total work count alongside the creator count so catalog growth is visible without adding permanent player chrome.
- Creator management lives in a separate, single-instance, draggable and resizable utility window. It remembers its bounds, does not cover or interrupt playback, and closing it hides only that utility window.
- For this repository, use the `git` and `gh` CLIs for GitHub operations instead of connector write actions.
