# Twitch Scraper

> 🇷🇺 [Русская версия README](README.ru.md) | 📘 [Technical Documentation](https://github.com/MacroVoid/TwitchScraper/wiki)

A browser extension (Manifest V3) for collecting live stream data from any category on Twitch.tv and exporting it as JSON or Markdown.

## Features

- Collects stream data from any Twitch category with automatic pagination handling
- Exports not just basic fields (title, viewer count), but extended data as well: social media links, channel panels (rules, Discord, about sections), stream start time and duration
- Output to JSON for programmatic use or to Markdown for human-readable results
- Flexible time format options: ISO 8601, Unix Timestamp, GMT, local time (12/24h), HH:MM:SS or total seconds
- Interface available in English and Russian

## Usage

1. Install the extension in a Chromium-based browser (Chrome, Edge, Brave)
2. Navigate to any Twitch category page, e.g. `twitch.tv/directory/category/minecraft`
3. Open Twitch Scraper via its icon in the browser toolbar
4. Select the data fields you want to collect and click **Collect**
5. Wait for the process to complete, or click **Finish Early** to download whatever has been collected so far

## Installation from Source

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode** in the top-right corner
4. Click **Load unpacked** and select the extension folder

## Technical Documentation

Implementation details — CORS bypass, GraphQL request batching, memory management via background service workers — are covered in the project wiki:

[→ Open Wiki](https://github.com/MacroVoid/TwitchScraper/wiki)

## License and Legal

The source code is distributed under the **MIT License**. The full license text is available in the [LICENSE](LICENSE) file.

UI icons are provided by the [Lucide](https://lucide.dev/) project and are used in accordance with the **ISC License**.

> **Disclaimer.** This extension uses the user's active browser session to interact with the Twitch public API. The developer is not responsible for any consequences arising from the use of this tool, including potential restrictions imposed by the platform. It is the user's sole responsibility to ensure compliance with the [Twitch Terms of Service](https://www.twitch.tv/p/legal/terms-of-service/).
