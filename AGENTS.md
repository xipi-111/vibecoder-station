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
- Persist Douyin catalog throttling and retry deadlines across app restarts. When the unsigned catalog endpoint returns a blocked or empty response, switch to the signed, logged-in creator profile page as the durable latest-work transport instead of repeatedly retrying the blocked endpoint.
- When a source platform presents an explicit human-verification challenge, pause catalog requests and let the plugin reveal its existing isolated catalog window. Resume from the persisted creator cursor after verification succeeds; do not treat a challenge as a timed retry or open it in the player renderer.
- Distinguish a visible human-verification challenge from a hidden verifier preload and from Douyin's ordinary service-error panels. Only a visible challenge is labeled as verification; service errors may expose the isolated source window for inspection and recovery without blocking the manager on a nonexistent captcha.
- Persist a versioned, stable Douyin creator-work directory separately from transient playback URLs. Start from the local directory, check incrementally on a multi-hour cadence, and never reset or refetch unrelated creators when one creator is added or removed.
- Treat Douyin image posts as first-class works: play their original soundtrack while advancing through the images, using the same controls and two-surface transition as videos.
- In creator management, show the total work count alongside the creator count so catalog growth is visible without adding permanent player chrome.
- Creator management lives in a separate, single-instance, draggable and resizable utility window. It remembers its bounds, does not cover or interrupt playback, and closing it hides only that utility window.
- For this repository, use the `git` and `gh` CLIs for GitHub operations instead of connector write actions.
- The player core ships without any built-in content-source plugin. A new installation has no playable source until the user installs a `.vibeplugin` package.
- Platform catalog, authentication, parsing, update detection, and collection import belong inside independently installable plugins; the core only owns playback, transitions, media proxying, queue arbitration, and plugin lifecycle.
- The existing Douyin implementation is the first external plugin. Douyin creator import and future platform-specific optimizations must remain inside that plugin rather than returning to the player core.
- During the personal-use phase, locally installed plugins are treated as trusted code. Preserve an upgrade path to signed, permission-scoped plugins before offering a public plugin ecosystem.
