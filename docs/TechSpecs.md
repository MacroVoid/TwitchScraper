# Twitch Scraper — Technical Documentation

## 1. Overview

**Twitch Scraper** is a browser extension (Google Chrome, Manifest V3) designed to extract live stream data from any category on Twitch (e.g., `twitch.tv/directory/category/minecraft`).

The extension bypasses Twitch's protection mechanisms (CORS, Integrity tokens) by passively intercepting network headers from a legitimate user session, then autonomously issuing a series of requests to the undocumented Twitch GraphQL (GQL) API. The collected data — basic stream info, social media links, and channel panels — is aggregated and exported as `JSON` or `Markdown`.

---

## 2. Architecture and File Structure

All heavy processing is offloaded to an isolated background process, which keeps the Twitch page unaffected and works around cross-origin request limitations.

| File | Description |
|------|-------------|
| `manifest.json` | Manifest V3. Declares permissions: `webRequest` (passive header interception), `storage` (state and data persistence), `scripting` (download script injection), and host permissions for `*.twitch.tv` and `gql.twitch.tv`. |
| `background.js` | Core engine (Service Worker). Handles all business logic: header interception, GQL requests, Twitch pagination quirk handling, social media and panel request batching, state machine management (pause/cancel), and intermediate result persistence to `chrome.storage.local`. |
| `popup.html` | UI layout. Includes filter settings, language selectors, limits, export format options, a progress display, and a debug log panel. |
| `popup.js` | UI logic. Sends messages to `background.js` (`start_collection`, `stop_collection`, `resume_enrich`, `download_last_data`, etc.) and reactively updates the UI (progress bars, status indicators) on `state_update` messages from the Service Worker. |
| `content.js` | Minimal Content Script. Previously used for making requests; in v2.0 it serves solely as a safe injection point — `background.js` uses the `scripting` API to execute `triggerDownload` inside the Twitch page context to generate a `Blob` and initiate the file download. |

---

## 3. Header Interception and Twitch Protection Bypass

### 3.1 Why interception is necessary

Twitch's GQL API (`gql.twitch.tv/gql`) is protected from automated scripts by the **Integrity Check** system. Every request requires a `Client-Integrity` header — a token cryptographically signed by an obfuscated Twitch script using the user's browser fingerprint. The extension cannot generate this independently.

### 3.2 Passive interception (`webRequest`)

`background.js` uses the `chrome.webRequest.onSendHeaders` listener. When the Twitch website (open in a tab) makes a legitimate GQL request as part of normal page rendering, the extension intercepts the following outgoing headers in transit:

- `Client-Id`
- `Client-Integrity`
- `Authorization`
- `X-Device-Id`
- `Client-Version`
- `Client-Session-Id`

### 3.3 Storage and normalization

Intercepted headers are saved to `chrome.storage.local`. Since JavaScript objects are case-sensitive, earlier versions produced `400 Bad Request` errors caused by duplicate header variants (e.g., `Client-ID` vs. `Client-Id`).

In v2.0, a strict normalization map (`HEADER_KEY_MAP`) is applied. Headers are always converted to standard Pascal-Kebab-Case and deduplicated. The `ensureHeadersLoaded()` function ensures the extension always uses the most recent valid tokens. If a token expires, the extension surfaces an error prompting the user to press `F5` on the Twitch tab to capture a fresh set.

---

## 4. Stream Collection: GQL API and Known Quirks

Collection is initiated by the `start_collection` message. `background.js` extracts the category `slug` from the active tab URL and begins the `DirectoryPageGame` request loop.

### 4.1 Searching by slug

Requests use the `game(slug: $slug)` argument rather than `game(name: $slug)`. Searching by name fails for games with complex titles or special characters; the `slug` always resolves the directory correctly.

### 4.2 Language filter behavior

When the user selects "All Languages", the extension sends `broadcasterLanguages: []` (an empty array), which instructs Twitch to return streams in all languages. When specific languages are selected (e.g., `RU`, `EN`), the array is populated with their respective codes.

### 4.3 Twitch pagination bug (`VIEWER_COUNT_ASC`) and sort order

Twitch has a known database issue:

- With ascending sort (`VIEWER_COUNT_ASC`), the database produces unstable cursors, causing the response to loop and return duplicate low-viewer streams.
- Upon reaching streams with 0 viewers, Twitch encodes the stream's Unix start timestamp as the cursor (e.g., `s = 1781455831`). The next page request then looks for streams where `viewersCount > 1.78 billion` and returns an empty result set, abruptly ending collection.

**Solution in v2.0:** When the user runs collection with no stream limit (full category), the extension overrides the UI setting for server requests and always fetches with `VIEWER_COUNT` (descending). This ensures stable, uninterrupted server-side pagination. The user's chosen sort order is then applied **in memory** immediately before export.

### 4.4 Loop detection and rate limiting

The collection loop includes a 150ms delay between pages. If Twitch stalls and returns the same `cursor` and last stream `id` across several consecutive pages, the extension detects the infinite loop and aborts.

### 4.5 Sub-only streams

The UI includes an "Include Sub-Only" option. When enabled, `includeRestricted: [SUB_ONLY_LIVE]` is added to the GraphQL request parameters, causing Twitch to return streams that are otherwise only visible to paying channel subscribers.

---

## 5. Request and Response Structures (GQL Reference)

The extension communicates with `https://gql.twitch.tv/gql` via `POST`. The request body is always JSON and contains `query` (or `operationName` for persisted queries) and `variables` fields.

### 5.1 Directory stream list (`DirectoryPageGame`)

Used to retrieve the list of live streams.

**Request:**
```json
{
  "query": "query DirectoryPageGame($slug: String!, $cursor: Cursor) { game(slug: $slug) { streams(first: 100, after: $cursor, options: { sort: VIEWER_COUNT, broadcasterLanguages: [\"EN\"], recommendationsContext: { platform: \"web\" }, systemFilters: [] }) { pageInfo { hasNextPage } edges { cursor node { id title viewersCount broadcaster { id login displayName description followers { totalCount } } freeformTags { name } game { name displayName } } } } } }",
  "variables": {
    "slug": "minecraft",
    "cursor": null
  }
}
```

**Response:** Nested JSON. Stream data is in `data.game.streams.edges`. Each edge contains a `cursor` (for the next page request) and a `node` (stream details).

```json
{
  "data": {
    "game": {
      "streams": {
        "pageInfo": { "hasNextPage": true },
        "edges": [
          {
            "cursor": "eyJzIjowLjM0Njg1OTYxMDAyMTc4MDIsImQiOmZhbHNlLCJ0Ijp0cnVlfQ==",
            "node": {
              "id": "51234567890",
              "title": "Morning Stream",
              "viewersCount": 15400,
              "broadcaster": {
                "id": "12345678",
                "login": "streamer_login",
                "displayName": "StreamerName",
                "description": "Channel description...",
                "followers": { "totalCount": 250000 }
              },
              "freeformTags": [ { "name": "English" }, { "name": "Survival" } ],
              "game": { "name": "Minecraft", "displayName": "Minecraft" }
            }
          }
        ]
      }
    }
  }
}
```

### 5.2 Channel extra data (`GetChannelExtras`)

Social media links and stream start times (uptime) are not available in the main directory query, so the extension uses GraphQL batching to request them separately.

**Request (batch):**
```json
[
  {
    "query": "query GetChannelExtras($login: String!) { user(login: $login) { login stream { createdAt } channel { socialMedias { name title url } } } }",
    "variables": { "login": "streamer_login_1" }
  },
  {
    "query": "query GetChannelExtras($login: String!) { user(login: $login) { login stream { createdAt } channel { socialMedias { name title url } } } }",
    "variables": { "login": "streamer_login_2" }
  }
]
```

**Response:** Array of responses containing the stream start timestamp (`createdAt`) and social media links.

```json
[
  {
    "data": {
      "user": {
        "login": "streamer_login_1",
        "stream": {
          "createdAt": "2026-06-15T08:15:30Z"
        },
        "channel": {
          "socialMedias": [
            { "name": "youtube", "title": "YouTube", "url": "https://youtube.com/..." },
            { "name": "twitter", "title": "Twitter", "url": "https://x.com/..." }
          ]
        }
      }
    }
  }
]
```

### 5.3 Channel panels (`ChannelPanels`)

Uses Twitch's `operationName` with a `persistedQuery` hash rather than a full inline query. Requests are batched by channel `id` (numeric identifier, not login).

**Request:**
```json
[
  {
    "operationName": "ChannelPanels",
    "variables": { "id": "12345678" },
    "extensions": {
      "persistedQuery": {
        "version": 1,
        "sha256Hash": "06d5b518ba3b016ebe62000151c9a81f162f2a1430eb1cf9ad0678ba56d0a768"
      }
    }
  }
]
```

**Response:** Data is in `data.user.panels`.

```json
[
  {
    "data": {
      "user": {
        "id": "12345678",
        "panels": [
          {
            "__typename": "DefaultPanel",
            "title": "Rules",
            "linkURL": "https://discord.gg/...",
            "description": "Don't spam in chat.",
            "altText": "Rules banner"
          }
        ]
      }
    }
  }
]
```

---

## 6. Data Enrichment (Social Media, Panels, Uptime)

Social media links, channel panels, and stream uptime are either unavailable or incomplete in the primary directory query and must be fetched separately. The extension uses batching and a persistent state system to manage this efficiently.

### 6.1 Batch sizes and data handling

- **Socials & Uptime:** Fetched together via `GetChannelExtras` in batches of **30** logins per POST request. Each response includes both the social media links and the stream start timestamp (`createdAt`), which is used to calculate duration.
- **Panels:** Fetched via `ChannelPanels` in batches of **20** by channel `userId`. Panel data is filtered to retain only `title`, `linkURL`, `description`, and `altText`; empty entries are discarded.

### 6.2 Pause, resume, and cancel

- `enrichData()` is divided into discrete steps that check for interruption signals.
- When the user clicks **Stop**, the current progress (`enrichDone`, `enrichTotal`) and the intermediate data array are saved to `chrome.storage.local`, and the status transitions to `enrich_paused`.
- **Continue** re-invokes `enrichData()`, which reads from storage and resumes only for channels where `social` or `panels` are still `undefined`.
- **Cancel** replaces all remaining `undefined` values with `null`, marking enrichment as complete. Fields left as `null` are omitted from the final export.

---

## 7. UI State Machine

### 7.1 Settings persistence

The UI is fully reactive and persistent. Any change to checkboxes, language selections, or format options triggers `saveUISettings()`, which writes the current configuration to `chrome.storage.local`. On next open, `loadUISettings()` restores all settings immediately.

### 7.2 Phase management

`popup.js` is driven by a reactive state machine. The Service Worker broadcasts `state_update` messages containing a state object:

```javascript
{
  phase: 'idle' | 'running' | 'enriching' | 'enrich_paused' | 'done' | 'error',
  collected: 450,
  target: 0,
  enrichStep: 'social',
  enrichDone: 150,
  enrichTotal: 450,
  error: null
}
```

The `applyState` function in `popup.js` responds to each `phase` by:

- Showing or hiding the appropriate action buttons (Collect, Stop, Finish, Continue, Cancel, Download)
- Updating the status indicator styling (blue / yellow / red / green)
- Animating the progress bar

### 7.3 Localization System

The UI supports dynamic language switching (Russian and English):
- The selected language is stored in `localStorage` under the `appLang` key and restored at startup.
- The `applyTranslations()` function traverses the DOM and sets localized strings for all elements with `data-i18n` (text content) and `data-i18n-title` (tooltips) attributes.
- Service Worker status messages during collection, enrichment, and pausing phases are formatted reactively using corresponding language templates from `i18n.js`.

---

## 8. File Generation and Export

Export is not triggered automatically after collection, since the user may want to change the format before downloading. The **Download** button initiates the export.

### 8.1 Working around MV3 memory limits

In Manifest V3, passing large data arrays (thousands of streams with long `description` strings) through `chrome.runtime.sendMessage` can crash the Service Worker due to message size constraints. To avoid this, `background.js` does not generate the `Blob` internally.

Instead, via `chrome.scripting.executeScript`, it passes the raw data array as an argument to the `triggerDownload` function, which runs inside the context of the open Twitch tab. The browser allocates memory within the page context, where the function creates the `Blob` and triggers the download via a programmatically clicked `<a>` element.

### 8.2 JSON export

Before export, the data array is filtered according to the user's settings. If `Social` or `Panels` were disabled or cancelled (values remain `null`), the corresponding keys are omitted from each JSON object. Time format preferences (ISO 8601, Unix Timestamp, GMT, local time, HH:MM:SS, etc.) are applied to `startTime` and `duration` fields at this stage.

### 8.3 Markdown export

The Markdown output is structured for readability:

- Long content (`description`, panels) is wrapped in `<details><summary>Expand...</summary><blockquote>...</blockquote></details>` to prevent layout disruption.
- Social media links are rendered as `[Name](URL)`.
- Panel entries handle `title` + `linkURL` combinations and preserve line breaks within `description`.
- **Language Adaptation**: All section headers, stream property labels (Channel, Viewers, Start Time, Duration, etc.), and details summary titles are localized according to the currently active UI language at the time of export (the `lang` value is sent to the Service Worker in the `download_last_data` message).

Once the content is assembled, a `Blob` is created, a temporary `ObjectURL` is generated, and the download is triggered via a programmatic click on an `<a>` element.

---

## 9. Debug Logging and Reset

### 9.1 Log buffer

`background.js` includes an `addLog()` function for diagnostics. Log entries (with timestamps) are appended to the `_logsBuffer` array, which is capped at 500 entries — older entries are dropped as new ones arrive. The buffer is persisted in `chrome.storage.local`.

Logged events include: HTTP response statuses, captured headers, pagination cursors, and GQL parameters.

The debug panel (accessible via the bug icon in the header) provides a **Download debug logs** button, which exports the buffer to `twitch_scraper_debug_<timestamp>.txt`. Logging can be disabled to reduce browser memory usage.

### 9.2 Emergency reset

The **Emergency Reset** button sends a `full_reset` signal to `background.js`, which:

1. Terminates all active `while` and `for` loops
2. Clears all runtime state variables (`_isRunning`, `_shouldStopEnrich`, etc.)
3. Resets `twitchHeaders` to default invalid values
4. Calls `chrome.storage.local.clear()`, removing all cached data, logs, and saved settings
5. Returns the UI to a clean `idle` state

This provides a reliable single-action recovery from any stuck state or corrupted cache.

---

## 10. License and Legal

The source code is distributed under the **MIT License**. The full license text is available in the [LICENSE](LICENSE) file.

UI icons are sourced from the **[Lucide](https://lucide.dev/)** project (ISC License) and the **[Feather](https://feathericons.com/)** project (MIT License). The texts of both third-party licenses are included in the [LICENSE](LICENSE) file in accordance with their respective terms.

> **Disclaimer.** This extension uses the user's active browser session to interact with Twitch's internal API. The developer is not responsible for any consequences arising from its use, including potential restrictions imposed by the platform. It is the user's sole responsibility to ensure compliance with the [Twitch Terms of Service](https://www.twitch.tv/p/legal/terms-of-service/).