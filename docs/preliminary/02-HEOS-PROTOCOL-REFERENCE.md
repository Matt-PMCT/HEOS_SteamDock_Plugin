# HEOS CLI Protocol Reference

A condensed reference of the Denon HEOS CLI protocol, covering everything needed to build the StreamDock plugin. Based on the official HEOS CLI Protocol Specification.

## Connection

- **Transport:** TCP socket (telnet-compatible)
- **Port:** 1255
- **Discovery:** UPnP SSDP with search target `urn:schemas-denon-com:device:ACT-Denon:1`
- **Manual:** You can skip discovery and connect directly if you know the speaker's IP address
- **Topology:** Connect to just ONE speaker to control the entire HEOS network. Do not open connections to every speaker.
- **Multiple sockets:** You can open multiple TCP connections to the same speaker. A common pattern is one connection for listening to events and one for sending commands.

## Command Format

Commands are ASCII strings in this format:

```
heos://command_group/command?attribute1=value1&attribute2=value2\r\n
```

The delimiter is `\r\n` (carriage return + newline). Every command must end with this.

Special characters in attribute values must be URL-encoded:
- `&` becomes `%26`
- `=` becomes `%3D`
- `%` becomes `%25`

## Response Format

All responses are JSON with this structure:

```json
{
  "heos": {
    "command": "command_group/command",
    "result": "success",
    "message": "attribute1=value1&attribute2=value2"
  },
  "payload": [ ... ]
}
```

If `result` is `"fail"`, the `message` field contains error codes.

Some commands also include a `payload` array with the actual data. Some responses also contain an `options` field with additional metadata.

**Important:** When a command cannot return immediately (e.g., a browse/search hitting a remote service), the speaker returns a response with `"message": "command under process"` and an empty `result` string (not `"success"` or `"fail"`). The actual result arrives later as a separate message.

## Initialization Sequence

When your controller first connects, follow this sequence:

1. **Unregister for change events** (by default the speaker does NOT send change events, but this is good defensive practice):
   `heos://system/register_for_change_events?enable=off`

2. **Sign in** (if you have HEOS account credentials):
   `heos://system/sign_in?un=username&pw=password`
   
   Sign-in is required for accessing cloud-based HEOS Favorites and playlists via `browse/play_preset`. Without sign-in, presets configured through streaming services (Spotify, TuneIn, etc.) will not be available. Local sources and physical inputs work without sign-in. The plugin should attempt `check_account` first and prompt for credentials via the Property Inspector if needed. **Security note:** credentials stored via `setGlobalSettings` are saved in plaintext in VSD Craft's local config. This is the same approach other StreamDock plugins use for API keys and tokens — there is no encrypted storage API in the SDK.

3. **Get players** (discover all speakers on the network):
   `heos://player/get_players`

4. **Get current state** (for each player you care about):
   - `heos://player/get_play_state?pid=PLAYER_ID`
   - `heos://player/get_volume?pid=PLAYER_ID`
   - `heos://player/get_now_playing_media?pid=PLAYER_ID`
   - `heos://player/get_mute?pid=PLAYER_ID`

5. **Register for change events** (start receiving live updates):
   `heos://system/register_for_change_events?enable=on`

## Essential Commands

### System Commands

| Command | Description |
|---|---|
| `heos://system/heart_beat` | Keepalive. Send periodically to maintain connection. |
| `heos://system/register_for_change_events?enable=on` | Start receiving unsolicited event notifications |
| `heos://system/register_for_change_events?enable=off` | Stop receiving event notifications |
| `heos://system/prettify_json_response?enable=on` | Format JSON responses with indentation (useful for debugging) |
| `heos://system/sign_in?un=USERNAME&pw=PASSWORD` | Sign in to HEOS account |
| `heos://system/check_account` | Check if a user is signed in |

### Player Discovery

| Command | Description |
|---|---|
| `heos://player/get_players` | List all players in the network |
| `heos://player/get_player_info?pid=PID` | Get info for a specific player |

**get_players response payload:**
```json
[
  {
    "name": "Living Room",
    "pid": 123456789,
    "gid": 987654321,
    "model": "HEOS 3",
    "version": "1.520.200",
    "ip": "192.168.1.100",
    "network": "wifi",
    "lineout": 0,
    "serial": "ABCD1234"
  }
]
```

The `pid` (player ID) is the key identifier you'll use in all subsequent player commands. The `gid` (group ID) only appears if the player is part of a group.

### Playback Control

| Command | Description |
|---|---|
| `heos://player/get_play_state?pid=PID` | Get current play state (play, pause, stop) |
| `heos://player/set_play_state?pid=PID&state=play` | Start playback |
| `heos://player/set_play_state?pid=PID&state=pause` | Pause playback |
| `heos://player/set_play_state?pid=PID&state=stop` | Stop playback |
| `heos://player/get_now_playing_media?pid=PID` | Get current track info (title, artist, album, image URL) |
| `heos://player/play_next?pid=PID` | Skip to next track |
| `heos://player/play_previous?pid=PID` | Go to previous track |

**get_now_playing_media response payload:**
```json
{
  "type": "song",
  "song": "Song Title",
  "album": "Album Name",
  "artist": "Artist Name",
  "image_url": "http://...",
  "mid": "media_id",
  "qid": 1,
  "sid": 1234
}
```

### Volume Control

| Command | Description |
|---|---|
| `heos://player/get_volume?pid=PID` | Get current volume (0-100) |
| `heos://player/set_volume?pid=PID&level=LEVEL` | Set volume to LEVEL (0-100) |
| `heos://player/volume_up?pid=PID&step=STEP` | Increase volume by STEP (1-10, default 5) |
| `heos://player/volume_down?pid=PID&step=STEP` | Decrease volume by STEP (1-10, default 5) |
| `heos://player/get_mute?pid=PID` | Get mute state (on/off) |
| `heos://player/set_mute?pid=PID&state=on` | Mute the player |
| `heos://player/set_mute?pid=PID&state=off` | Unmute the player |
| `heos://player/toggle_mute?pid=PID` | Toggle mute state |

### Playback Mode

| Command | Description |
|---|---|
| `heos://player/get_play_mode?pid=PID` | Get repeat/shuffle state |
| `heos://player/set_play_mode?pid=PID&repeat=on_all&shuffle=off` | Set repeat/shuffle (repeat: on_one, on_all, off; shuffle: on, off) |

### Preset / Favorites

| Command | Description |
|---|---|
| `heos://browse/play_preset?pid=PID&preset=N` | Play HEOS Favorite preset N (1-based index). **Note:** this is a `browse/` command, not `player/`. |
| `heos://browse/get_music_sources` | List all available music sources |

### Group Commands

| Command | Description |
|---|---|
| `heos://group/get_groups` | List all groups |
| `heos://group/get_group_info?gid=GID` | Get info for a specific group |
| `heos://group/set_group?pid=PID1,PID2,PID3` | Create a group (first PID is the leader) |
| `heos://group/get_volume?gid=GID` | Get group volume |
| `heos://group/set_volume?gid=GID&level=LEVEL` | Set group volume |
| `heos://group/get_mute?gid=GID` | Get group mute state |
| `heos://group/toggle_mute?gid=GID` | Toggle group mute |

## Change Events

After registering for change events, the speaker sends unsolicited JSON messages when things change. Key events for our plugin:

| Event | Trigger |
|---|---|
| `event/player_state_changed` | Play state changed (play/pause/stop). Message contains `pid` and `state`. |
| `event/player_now_playing_changed` | Track changed. Message contains `pid`. Follow up with `get_now_playing_media`. |
| `event/player_now_playing_progress` | Playback progress update. Message contains `pid`, `cur_pos`, `duration`. |
| `event/player_volume_changed` | Volume changed. Message contains `pid`, `level`, `mute`. |
| `event/player_queue_changed` | Queue changed. Message contains `pid`. |
| `event/player_playback_error` | Playback error occurred. Message contains `pid`. |
| `event/players_changed` | Players added/removed from network. Re-run `get_players`. |
| `event/groups_changed` | Groups changed. Re-run `get_groups`. |
| `event/group_volume_changed` | Group volume changed. Message contains `gid`, `level`, `mute`. |
| `event/sources_changed` | Music sources changed. Re-run `get_music_sources`. |
| `event/repeat_mode_changed` | Repeat mode changed. Message contains `pid` and `repeat`. |
| `event/shuffle_mode_changed` | Shuffle mode changed. Message contains `pid` and `shuffle`. |
| `event/user_changed` | HEOS account sign-in state changed. Re-check with `check_account`. |

**Note:** `players_changed`, `sources_changed`, `groups_changed`, and `user_changed` can fire in rapid bursts — consider debouncing before reacting.

Event response format:
```json
{
  "heos": {
    "command": "event/player_volume_changed",
    "message": "pid=123456789&level=45&mute=off"
  }
}
```

## Error Codes

| Code | Meaning |
|---|---|
| 1 | Unrecognized command |
| 2 | Invalid ID |
| 3 | Wrong number of command arguments |
| 4 | Requested data not available |
| 5 | Resource currently not available |
| 6 | Invalid credentials |
| 7 | Command could not be executed |
| 8 | User not logged in |
| 9 | Parameter out of range |
| 10 | User not found |
| 11 | Internal error |
| 12 | System error (check `syserrno` in message for sub-code) |
| 13 | Processing previous command |
| 14 | Media cannot be played |
| 15 | Option not supported |
| 16 | Too many commands in queue |
| 17 | Skip limit reached |

Error 12 system error sub-codes include: -9 (remote service error), -1056 (user not found), -1063 (user not logged in), -1201 (content auth error).

## Connection Keepalive

HEOS will close idle connections. Send a heartbeat periodically:

```
heos://system/heart_beat\r\n
```

The HEOS spec does not prescribe a specific interval. 30 seconds is a reasonable default (some implementations use 10-60 seconds). The response will be:

```json
{
  "heos": {
    "command": "system/heart_beat",
    "result": "success",
    "message": ""
  }
}
```

## Command Serialization

HEOS devices cannot handle concurrent commands — sending multiple commands simultaneously causes buffer overflows, dropped responses, and connection instability. All commands must be serialized: send one, wait for its response, then send the next.

### Recommended queue design

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Action calls │ --> │ Command Queue│ --> │ TCP Socket   │
│ enqueue()    │     │ (FIFO array) │     │ send one cmd │
└──────────────┘     └──────────────┘     └──────────────┘
                           │                      │
                           │    ┌─────────────┐   │
                           │<-- │ On response  │<--│
                           │    │ dequeue next │   │
                           │    └─────────────┘   │
```

1. Every action handler calls `heosClient.enqueue(command)` instead of writing directly to the socket
2. The queue sends the first pending command to the TCP socket
3. When a response arrives, match it to the pending command by checking `heos.command` — the response echoes back the command group and command name (e.g., sending `heos://player/set_volume?pid=123&level=50` produces a response with `"command": "player/set_volume"`). **Important:** change events can arrive interleaved between a command and its response on the same socket. Your parser must distinguish events (no `result` field, `command` starts with `event/`) from command responses and route them separately.
4. On successful match, resolve the pending promise and send the next queued command
5. If the response is error 13 (processing previous command) or error 16 (too many commands in queue), retry after a short delay (200-500ms)
6. Set a per-command timeout (5 seconds) — if no response arrives, reject and move to the next command

### Volume knob optimization

Rapid knob rotation generates many `dialRotate` events in quick succession. To avoid flooding the queue with volume commands:

- **Debounce:** Collapse rapid ticks into a single `set_volume` command with the final target level, rather than sending individual `volume_up`/`volume_down` for each tick
- **Drop stale commands:** If a new volume command is enqueued while one is pending, replace the pending one (the latest value is the only one that matters)
- Track the current volume locally and compute the target: `newVolume = clamp(currentVolume + (ticks * stepSize), 0, 100)`

## TCP Response Parser

Responses arrive as raw bytes over TCP. A single `data` event from the socket may contain a partial JSON message, exactly one message, or multiple messages concatenated. Your parser must handle all three cases.

### Parser design

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────────┐
│ socket.on    │ --> │ Append to buffer  │ --> │ Split on \r\n    │
│ ('data')     │     │ (string)          │     │                  │
└──────────────┘     └───────────────────┘     └──────────────────┘
                                                       │
                                          ┌────────────┴────────────┐
                                          │                         │
                                   Complete lines            Last element
                                   (JSON.parse each)        (keep as buffer)
```

### Pseudocode

```javascript
class ResponseParser {
  constructor() {
    this.buffer = '';
  }

  // Call this from socket.on('data', (data) => parser.put(data.toString()))
  put(data) {
    this.buffer += data;
    const lines = this.buffer.split('\r\n');

    // Last element is either '' (if data ended with \r\n) or an incomplete fragment
    this.buffer = lines.pop();

    const messages = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        // Log and skip malformed lines — do NOT flush the entire buffer.
        // The juliuscc/heos-api library flushes everything on parse error,
        // which loses subsequent valid messages. Skip only the bad line.
        console.error('Failed to parse HEOS response line:', line);
      }
    }
    return messages;
  }
}
```

**Key difference from `juliuscc/heos-api`:** Their parser flushes the entire buffer on any JSON parse error, which means a single malformed line causes loss of all buffered data including valid messages that followed. Our parser skips only the bad line and continues processing.

## Event vs. Response Routing

Every parsed JSON message from the HEOS speaker is either a **command response** or an **unsolicited event**. The command queue must distinguish these because events can arrive interleaved between sending a command and receiving its response.

### How to tell them apart

| Field | Command Response | Event |
|---|---|---|
| `heos.command` | Echoes the command group/name (e.g., `player/set_volume`) | Starts with `event/` (e.g., `event/player_volume_changed`) |
| `heos.result` | Present: `"success"` or `"fail"` | **Absent** |
| `heos.message` | URL-encoded params or error info | URL-encoded event data |
| `payload` | Optional, contains response data | Absent (data is in `message`) |

### Routing pseudocode

```javascript
function routeMessage(msg) {
  const command = msg.heos.command;

  // 1. Is it an event?
  if (command.startsWith('event/')) {
    handleEvent(msg);
    return;
  }

  // 2. Is it a "command under process" interim response?
  //    (result is empty string, message is "command under process")
  if (msg.heos.result === '' && msg.heos.message === 'command under process') {
    // Do NOT resolve the pending command — the real response comes later.
    // Optionally reset the per-command timeout.
    return;
  }

  // 3. It's a command response — match to the pending command in the queue.
  //    The response echoes the command group/name in heos.command
  //    (e.g., sending "heos://player/set_volume?pid=123&level=50"
  //     returns heos.command = "player/set_volume").
  resolveQueuedCommand(command, msg);
}
```

### Matching responses to queued commands

The `heos.command` field in the response echoes only the `command_group/command` portion — it does not include query parameters. For example:
- **Sent:** `heos://player/set_volume?pid=123&level=50\r\n`
- **Response `heos.command`:** `"player/set_volume"`

Match by comparing the pending command's group/name (strip `heos://` prefix and everything after `?`) against the response's `heos.command`.

## Important Notes

- The CLI module starts in dormant mode and takes a moment to spin up on first connection. Initial `get_players` may need a short delay (1-2 seconds after connecting) before it returns valid data. Keep an idle connection alive to prevent the CLI module from going back to dormant mode.
- **Commands must be serialized.** Sending multiple commands concurrently causes buffer overflows on the HEOS device, leading to dropped commands and connection instability. Send one command at a time and wait for its response before sending the next. This is critical for rapid operations like volume knob rotation.
- All player IDs (`pid`) are signed integers and can be negative.
- The `message` field in responses is URL-encoded key-value pairs, not JSON. You'll need to parse it (split on `&`, then split each pair on `=`), then URL-decode each value.
- Only one controller needs to connect to one speaker to control the entire HEOS ecosystem.
- Maximum of 32 simultaneous TCP connections per speaker.
- Volume values range from 0 to 100 (integer). Volume step values for `volume_up`/`volume_down` must be 1-10.
- Preset indices are 1-based (1 through however many favorites the user has configured in the HEOS app).
- Events lack the `result` field — they only contain `command` and `message`. Responses have `command`, `result`, `message`, and optional `payload`/`options`.
