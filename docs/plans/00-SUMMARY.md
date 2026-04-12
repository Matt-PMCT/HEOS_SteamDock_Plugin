# HEOS StreamDock Plugin -- Implementation Plans

## Context

These plans transform the [preliminary design docs](../preliminary/) into step-by-step, implementable specifications for building a VSDinside StreamDock plugin that controls Denon HEOS speakers from a MagTran M3 (or any StreamDock device). Each phase builds on the previous one and is designed to be followed sequentially.

**Key sources:** Preliminary docs (01-05), VSDinside Plugin SDK V2 template, HEOS CLI Protocol Spec v1.17, mthiel/stream-deck-denon-receiver reference plugin, VSDinside porting guides.

## Phase Index

| Phase | Plan | Summary | Depends On |
|-------|------|---------|------------|
| 1 | [Skeleton & Infrastructure](./01-SKELETON-AND-INFRASTRUCTURE.md) | WebSocket to VSD Craft, TCP to HEOS, command queue, response parser, event routing | None |
| 2 | [Core Playback Actions](./02-CORE-PLAYBACK-ACTIONS.md) | Play/pause, next/prev, mute; HEOS init sequence; player state tracking | Phase 1 |
| 3 | [Volume Knob](./03-VOLUME-KNOB.md) | Debounced volume control via rotary encoder; step scaling; queue replacement | Phases 1-2 |
| 4 | [Preset Buttons](./04-PRESET-BUTTONS.md) | One-touch HEOS Favorites; per-action settings | Phases 1-2 |
| 5 | [Property Inspector](./05-PROPERTY-INSPECTOR.md) | Settings UI: IP entry, player discovery, preset config, HEOS account sign-in | Phases 1-2, 4 |
| 6 | [Resilience & Polish](./06-RESILIENCE-AND-POLISH.md) | Reconnection, sleep/wake, command buffering, UX feedback, production icons | Phases 1-5 |
| 7 | [Future Enhancements](./07-FUTURE-ENHANCEMENTS.md) | Album art, SSDP discovery, group control, input select, repeat/shuffle, profiles | Phases 1-6 |

## Architecture Overview

```
MagTran M3 --> VSD Craft (WebSocket) --> Plugin (Node.js) --> HEOS Speaker (TCP:1255)
     keys/knobs       events/display        commands/events        CLI protocol
```

## File Structure (Final)

```
heos-plugin/
  package.json
  scripts/
    package.js                # Strips Debug from manifest, zips plugin for release
  .github/workflows/
    release.yml               # On v* tag: build, package, create GitHub Release
  src/
    index.js                  # WebSocket registration, event dispatch
    heos-client.js            # TCP connection, command queue, parser, events
    actions/
      play-pause.js           # Phase 2
      volume.js               # Phase 3
      mute.js                 # Phase 2
      next-prev.js            # Phase 2
      preset.js               # Phase 4

com.vsd.craft.heos.sdPlugin/
  manifest.json               # Phase 1 (full manifest from preliminary doc 05)
  plugin/index.js             # ncc bundled output (gitignored, built by ncc)
  property-inspector/
    index.html                # Basic version exists (IP + player ID fields); Phase 5 expands
  images/                     # Placeholder Phase 1, production Phase 6
```

## Cross-Cutting Concerns

These gotchas apply across all phases. See [Cross-Cutting Concerns](./08-CROSS-CUTTING-CONCERNS.md) for the full reference.

**SDK:** Manifest uses `"Knob"` but runtime sends `"Encoder"` -- never check for "Knob" at runtime. `dialUp` fires immediately after `dialDown` -- unreliable for long-press. No `setFeedback`/`setFeedbackLayout` -- use `setImage`. UUIDs must be all lowercase. Node.js 20.8.1 lacks native WebSocket. Invalid manifest JSON = silent failure (no log output). Use plugin name for `Category` field, not a generic category.

**HEOS:** Commands MUST be serialized (one at a time). Player IDs are signed, can be negative. `message` field is URL-encoded, not JSON. `play_preset` is `browse/`, not `player/`. Events lack `result` field. CLI module takes 1-2s to spin up. Heartbeat every 30s. Grouped speakers share playback -- selecting a group leader affects all members.

**Packaging:** `scripts/package.js` strips `Debug` from manifest via regex. The regex must consume the trailing comma from the preceding line to avoid producing invalid JSON.
