# Welcome to the Twitch Scraper Wiki!

Welcome to the official wiki for the **Twitch Scraper** extension!

## What is this Wiki for?

This wiki is designed for developers, contributors, and anyone interested in understanding the inner workings, design choices, and technical architecture of the extension.

Unlike the main `README.md`, which provides a high-level overview and quick start guide for users, this space hosts deep-dive technical documentation:

*   **Architecture & Components:** A detailed look at how the UI Popup, Background Service Worker (`background.js`), and Content Scripts communicate and share state.
*   **Twitch GraphQL Integration:** Explanation of how GraphQL API requests are batched, structured, and how the extension bypasses CORS restrictions directly from the browser.
*   **Data Models & Enrichment:** Details on the exact data schemas collected (including social links, channel panels, stream stats, etc.) and file export formats.
*   **Performance & Limits:** How the scraper manages memory and handles browser resource constraints when processing thousands of streams.

---

## Technical Specifications

The comprehensive technical documentation is available in the following languages:

*   📖 **[English Version](https://github.com/MacroVoid/TwitchScraper/wiki/TechSpecs)**
*   📖 **[Russian Version (Русская версия)](https://github.com/MacroVoid/TwitchScraper/wiki/TechSpecs-Russian)**
