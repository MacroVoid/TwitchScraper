# Twitch Scraper — Technical Documentation (v2.0)

## 1. Overview and Purpose

**Twitch Scraper** is a browser extension (Google Chrome Manifest V3) designed to extract live stream data from any category on Twitch (e.g., `twitch.tv/directory/category/minecraft`).

It bypasses Twitch's protection mechanisms (CORS, Integrity tokens) by passively intercepting network headers from a legitimate user session and autonomously performing a series of requests to the undocumented Twitch GraphQL (GQL) API. The collected data (basic stream info, social media links, and channel panels) is aggregated and exported to the user in `JSON` or `Markdown` formats.

---

## 2. Architecture and File Structure

The extension is designed to offload all heavy lifting to an isolated background process, preventing performance impact on the Twitch page while bypassing cross-origin request limitations.

| File | Description |
|------|-------------|
| `manifest.json` | Manifest V3. Declares permissions: `webRequest` (for passive header interception), `storage` (for state and data persistence), `scripting` (for injecting the download script), and host permissions for `*.twitch.tv` and `gql.twitch.tv`. |
| `background.js` | The core engine (Service Worker). Handles all business logic: intercepts headers, performs GQL requests, bypasses Twitch pagination bugs, batches social media and panel requests, manages the state machine (pause/cancel), and saves intermediate results to `chrome.storage.local`. |
| `popup.html` | User interface layout. Includes filtering settings, language selectors, limits, export format choices, a progress display system, and a debug logging panel. |
| `popup.js` | UI logic. Sends messages to `background.js` (`start_collection`, `stop_collection`, `resume_enrich`, `download_last_data`, etc.) and reactively updates the UI (progress bars, status pills) upon receiving `state_update` messages from the Service Worker. |
| `content.js` | Minimal Content Script. Historically used for making requests, but in v2.0 it is retained solely as a safe injection point: `background.js` uses the `scripting` API to execute the `triggerDownload` function inside the Twitch page context to generate a `Blob` and initiate the file download. |

---

## 3. Header Interception and Twitch Protection Bypass

### 3.1 Why is interception necessary?
Twitch's GQL API (`gql.twitch.tv/gql`) is protected from automated scripts by the **Integrity Check** system. Every request requires a `Client-Integrity` header — a token cryptographically signed by an obfuscated Twitch script using the user's browser fingerprint. The extension cannot generate this on its own.

### 3.2 Passive Interception (`webRequest`)
`background.js` utilizes the `chrome.webRequest.onSendHeaders` listener. When the Twitch website (open in a tab) makes a legitimate GQL request to render the interface, the extension intercepts the following outgoing headers "on the fly":
- `Client-Id`
- `Client-Integrity`
- `Authorization`
- `X-Device-Id`
- `Client-Version`
- `Client-Session-Id`

### 3.3 Storage and Normalization
Intercepted headers are saved in `chrome.storage.local`. Because JavaScript objects are case-sensitive, earlier versions experienced `400 Bad Request` errors due to duplicates (e.g., `Client-ID` and `Client-Id`).
In v2.0, a strict normalization mask (`HEADER_KEY_MAP`) is used. Headers are always converted to standard Pascal-Kebab-Case, and duplicates are removed. The `ensureHeadersLoaded()` function guarantees the extension always uses the freshest working tokens. If a token expires, the extension throws an error prompting the user to simply press `F5` on the Twitch tab to capture a new token.

---

## 4. Stream Collection: GQL API and Quirks

Collection is initiated by sending the `start_collection` message. `background.js` determines the category `slug` from the active tab's URL and starts the `DirectoryPageGame` request loop.

### 4.1 Searching by Slug
The request is formulated using the `game(slug: $slug)` argument rather than `game(name: $slug)`. This is critical because searching by Name fails for games with complex titles and special characters, whereas the `slug` always accurately identifies the directory.

### 4.2 Language Filtering Quirk
If the user selects the "🌐 All Languages" filter, the extension passes the `broadcasterLanguages: []` parameter (an empty array). This forces Twitch to return streams in absolutely all languages. When specific languages are selected (e.g., `RU`, `EN`), the array is populated with their respective codes.

### 4.3 Twitch Pagination Bug (VIEWER_COUNT_ASC) and Sorting
Twitch has a database bug:
- When sorting "Ascending" (`VIEWER_COUNT_ASC`), the database generates unstable cursors. As a result, the output loops, duplicating smaller streams.
- When reaching streams with 0 viewers, Twitch encodes the stream's start Unix timestamp as the cursor (e.g., `s = 1781455831`). On requesting the next page, Twitch attempts to find a stream where `viewersCount > 1.78 billion` and returns an empty list. Collection abruptly stops.

**Solution in the Extension (v2.0):**
If the user starts collection with **"No limit"** (collect entire category), the extension ignores the UI setting for the server request and _always_ requests with the `VIEWER_COUNT` parameter (descending). This ensures stable, fast server pagination without drops. The sorting direction chosen by the user is applied **locally** in memory right before exporting the file.

### 4.4 Loop Protection and Rate Limiting
The collection loop includes a `150ms` delay between pages. If Twitch hangs and returns the identical `cursor` and last stream `id` for several consecutive pages, the extension detects the infinite loop and aborts it.

### 4.5 Parsing Restricted (Sub-Only) Streams
The UI provides an "Include Sub-Only" setting. If active, the `includeRestricted: [SUB_ONLY_LIVE]` flag is added to the GraphQL request parameters. This forces Twitch to return hidden streams that are only viewable by paying subscribers of that channel.

---

## 5. Request and Response Structures (GQL Specification)

The extension interacts with the `https://gql.twitch.tv/gql` endpoint via the `POST` method. The request body is always sent in JSON format and contains `query` (or `operationName` for persisted queries) and `variables` fields.

### 5.1 Main Directory Request (DirectoryPageGame)
Used to retrieve the list of live streams.

**Request (Payload):**
```json
{
  "query": "query DirectoryPageGame($slug: String!, $cursor: Cursor) { game(slug: $slug) { streams(first: 100, after: $cursor, options: { sort: VIEWER_COUNT, broadcasterLanguages: [\"EN\"], recommendationsContext: { platform: \"web\" }, systemFilters: [] }) { pageInfo { hasNextPage } edges { cursor node { id title viewersCount broadcaster { id login displayName description followers { totalCount } } freeformTags { name } game { name displayName } } } } } }",
  "variables": {
    "slug": "minecraft",
    "cursor": null
  }
}
```

**Response:**
Returns deeply nested JSON. Data resides in `data.game.streams.edges`. Each edge contains a `cursor` (required for the next page request) and a `node` (information about the stream itself).
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

### 5.2 Social Media Request (GetChannelSocial)
Twitch does not support batching social media natively within the directory query, so the extension sends an array of queries (GraphQL Batching).

**Request (Batch array of objects):**
```json
[
  {
    "query": "query GetChannelSocial($login: String!) { user(login: $login) { login channel { socialMedias { name title url } } } }",
    "variables": { "login": "streamer_login_1" }
  },
  {
    "query": "query GetChannelSocial($login: String!) { user(login: $login) { login channel { socialMedias { name title url } } } }",
    "variables": { "login": "streamer_login_2" }
  }
]
```

**Response:** Array of responses. Social media fields reside in `data.user.channel.socialMedias`.
```json
[
  {
    "data": {
      "user": {
        "login": "streamer_login_1",
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

### 5.3 Channel Panels Request (ChannelPanels)
Uses Twitch's built-in `operationName` and `persistedQuery` hash instead of sending the full query text. An array is sent to batch by `id` (the unique channel identifier, not login).

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

**Response:** Data resides in `data.user.panels`.
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

## 6. Data Enrichment (Social Media and Panels)

Data regarding social networks and channel panels is unavailable in the primary directory query. They must be collected via separate requests. This can be time-consuming, so an advanced batching and state management system is implemented.

### 6.1 Batch Requests
- **Socials**: Extracted via `GetChannelSocial`. Twitch allows combining queries. The extension gathers streamer logins in batches of **30** and makes one massive POST request.
- **Panels**: Extracted via `ChannelPanels` using `userId`. Panels carry heavy payloads, so they are batched by **20**. Panels are sanitized of empty elements; only `title`, `linkURL`, `description`, and `altText` are retained.

### 6.2 Process Management (Pause, Resume, Cancel)
- The `enrichData()` function is divided into manageable steps.
- The user can press the **"Stop"** button. The process doesn't reset: `background.js` saves the current progress (`enrichDone`, `enrichTotal`) and the intermediate data array into `chrome.storage.local`, shifting the status to `enrich_paused`.
- The **"Continue"** button re-invokes `enrichData()`, which reads the array from storage and resumes collection exclusively for channels where `social` / `panels` arrays are `undefined`.
- The **"Cancel"** button forcefully replaces remaining `undefined` values with `null`. This marks the enrichment process as complete, and the missing fields are simply omitted from the final export.

---

## 7. UI State Machine

### 7.1 UI Persistence
The entire user interface is reactive and persistent. Whenever checkbox states, languages, or formats change, `saveUISettings()` is called, storing the current configuration in `chrome.storage.local`. Upon reopening the extension, `loadUISettings()` instantly restores all parameters.

### 7.2 Phase Management
All logic in `popup.js` revolves around a reactive state machine. The service worker broadcasts `state_update` messages containing a state object:

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

Depending on the `phase`, the UI logic in `popup.js` (`applyState` function):
- Toggles the visibility of the progress bar and action buttons (Collect, Stop, Finish, Continue, Cancel, Download).
- Changes the styling of the status pill (blue/yellow/red/green).
- Animates the loading bar.

---

## 8. File Generation and Export

Downloading does not occur automatically after collection (since the user may want to change the format). The "Download" button is responsible for exporting.

### 8.1 Bypassing MV3 Memory Limits (Message Passing)
In Manifest V3, transmitting massive data arrays (thousands of streams with long `description` strings) via the built-in `chrome.runtime.sendMessage` can crash the Service Worker due to message size constraints. Therefore, `background.js` does not generate the `Blob` file internally.
Instead, via the `chrome.scripting.executeScript` API, it forwards the raw array as an argument into the `triggerDownload` function, which executes within the context of the open Twitch tab. The browser readily allocates memory for the webpage, where the function locally generates the `Blob` and triggers the download via an invisible `<a>` tag.

### 8.2 JSON Format
The data array passes through a filter. If the user disabled the `Social` checkbox, or if they were not collected (remained `null` after cancellation), the `social` and `panels` keys are omitted from the JSON objects.

### 8.3 Markdown Format
The script generates beautiful, highly readable Markdown.
- **Descriptions and panels** are wrapped in HTML tags `<details><summary>Expand...</summary><blockquote>...</blockquote></details>`. This prevents long texts from "breaking" the list layout.
- **Socials** are output as hyperlinks: `[Name](URL)`.
- **Panels** can contain complex formatting, so the extension correctly handles `title` + `linkURL` combinations and preserves line breaks in `description`.

Then a `Blob` is created, a temporary `ObjectURL` is generated, the `<a>` tag is clicked programmatically, and the file is saved to the user's disk.

---

## 9. Debug Logging and Cache Management

### 9.1 Ring Buffer for Logs
For bug investigation, `background.js` includes an `addLog()` function.
It adds a timestamped entry to the `_logsBuffer` array. The buffer is capped at 500 entries (old ones are evicted). The buffer is stored in `chrome.storage.local`.
Everything is logged: HTTP response statuses, captured headers, cursors, and GQL parameters.

In the interface (accessed via the "Bug" icon in the header), the user can click **"Download debug logs"**, which exports this buffer to a text file `twitch_scraper_debug_<timestamp>.txt`. Logging can also be disabled to save browser memory.

### 9.2 Full Emergency Reset
The **"Emergency Full Reset"** button sends the `full_reset` signal.
`background.js`:
1. Forcefully terminates all active `while` and `for` loops.
2. Clears all state variables (`_isRunning`, `_shouldStopEnrich`, etc.).
3. Resets the `twitchHeaders` object to default invalid values.
4. Invokes `chrome.storage.local.clear()`, wiping the entire cache, logs, and saved settings.
5. The interface reloads into a pristine `idle` state. This guarantees that any "stuck" bug or corrupted extension cache is completely eradicated with a single click.

---

## 10. License & Credits

This project is distributed under the free **MIT License** (see the [LICENSE](LICENSE) file for full details).

### Third-Party Resources:
The extension utilizes icons from the **[Lucide](https://lucide.dev/)** project (licensed under the **ISC License**) and icons derived from the **[Feather](https://feathericons.com/)** project (licensed under the **MIT License**). The texts of these licenses are also included in the [LICENSE](LICENSE) file in compliance with their usage terms.
