# Twitch Scraper — Wiki

This wiki contains technical documentation for the **Twitch Scraper** browser extension — intended for developers and anyone interested in the implementation details, design decisions, and internal architecture of the project.

Unlike the main `README.md`, which covers installation and basic usage, this space focuses on how things work under the hood:

- **Architecture & Components:** How the UI popup, Background Service Worker (`background.js`), and Content Scripts communicate and share state.
- **Twitch GraphQL Integration:** How GQL requests are structured and batched, and how the extension bypasses CORS restrictions from within the browser.
- **Data Collection & Export:** The exact data schemas collected (social links, channel panels, stream stats, etc.) and the supported export formats.
- **Performance & Limits:** How the extension manages memory and handles browser resource constraints when processing large numbers of streams.

---

## Technical Specifications

- 📖 [English Version](https://github.com/MacroVoid/TwitchScraper/wiki/TechSpecs)
- 📖 [Russian Version (Русская версия)](https://github.com/MacroVoid/TwitchScraper/wiki/TechSpecs-Russian)