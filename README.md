# Twitch Scraper

> 🇷🇺 [Русская версия README](README.ru.md) | 📘 [Technical Documentation](https://github.com/MacroVoid/TwitchScraper/wiki)

**Twitch Scraper** is a powerful and lightweight browser extension (Manifest V3) that allows you to easily extract live stream data from any category on Twitch.tv and export it into structured JSON or Markdown files.

![Twitch Scraper Preview](https://lucide.dev/logo.svg) <!-- You can replace this with an actual screenshot of the extension -->

## ✨ Features

- **One-Click Export**: Quickly scrape thousands of live streams from any game or directory.
- **Bypass Limitations**: Automatically handles Twitch's pagination and safely gathers data using your active session.
- **Rich Data Enrichment**: Gather not just stream titles and viewers, but also deep information like social media links, channel panels (rules, discord links, about me, etc), and stream uptime (start time and duration).
- **Format Options**: Export cleanly formatted JSON files for programmatic use, or beautiful Markdown files for easy reading.
- **Advanced Export Settings**: Customize how stream start time and duration are formatted (ISO 8601, Unix Timestamp, GMT, Local Time 12/24h, HH:MM:SS or Total Seconds) directly from the interface.
- **Multilingual Support**: The extension interface supports English and Russian languages out of the box.

## 🚀 How to Use

1. **Install** the extension in your Chromium-based browser (Chrome, Edge, Brave).
2. **Open** any Twitch category page (for example, `twitch.tv/directory/category/minecraft`).
3. Click the **Twitch Scraper** icon in your browser toolbar.
4. Select the data fields you want to collect and click the **Collect** button.
5. Wait for the process to finish, or click **Finish Early** to stop and download what has been collected so far.

## ⚙️ Build and Installation (Developer Mode)

1. Clone or download this repository.
2. Open your browser and go to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the folder containing this extension.
5. The extension is now installed and ready to use!

## 📖 Technical Documentation

If you are interested in how the extension bypasses CORS, handles GraphQL batching, and manages memory limits via background service workers, please refer to our detailed technical wiki:

- **[Wiki](https://github.com/MacroVoid/TwitchScraper/wiki)**

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for more details. Icons used in the UI are provided by the [Lucide](https://lucide.dev/) project under the ISC License.
