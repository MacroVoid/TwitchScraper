/**
 * =============================================
 * Background Service Worker
 * Handles ALL GQL requests autonomously (bypassing CORS).
 * Content.js is only used to inject the download action into the DOM.
 * =============================================
 */

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
let _shouldStop = false;
let _shouldFinish = false;
let _isRunning = false;
let _shouldStopEnrich = false;
let _isEnriching = false;

// --- Debug Logging Buffer ---
let _logsBuffer = [];
chrome.storage.local.get('debugLogs', (res) => {
    if (res.debugLogs) _logsBuffer = res.debugLogs;
});

let _isLoggingDisabled = false;
chrome.storage.local.get('isLoggingDisabled', (res) => {
    if (res.isLoggingDisabled !== undefined) {
        _isLoggingDisabled = res.isLoggingDisabled;
    }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.isLoggingDisabled) {
        _isLoggingDisabled = changes.isLoggingDisabled.newValue;
    }
});

/**
 * Adds a log entry to the debug buffer if logging is not disabled.
 * Maintains a maximum buffer size of 500 lines.
 * @param {string} msg - The log message.
 */
function addLog(msg) {
    if (_isLoggingDisabled) return;
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const logLine = `[${timestamp}] ${msg}`;
    console.log(logLine);
    _logsBuffer.push(logLine);
    if (_logsBuffer.length > 500) _logsBuffer.shift();
    chrome.storage.local.set({ debugLogs: _logsBuffer });
}

/**
 * Ensures that Twitch request headers are loaded from local storage
 * before starting data collection.
 */
async function ensureHeadersLoaded() {
    try {
        const res = await chrome.storage.local.get('twitchHeaders');
        if (res.twitchHeaders) {
            Object.assign(twitchHeaders, res.twitchHeaders);
            const cleaned = cleanHeaders();
            if (cleaned) {
                await chrome.storage.local.set({ twitchHeaders });
            }
        }
    } catch (e) {
        addLog(`Error loading headers: ${e.message}`);
    }
}

// Map for normalizing intercepted HTTP headers
const HEADER_KEY_MAP = {
    'client-id': 'Client-Id',
    'client-integrity': 'Client-Integrity',
    'authorization': 'Authorization',
    'x-device-id': 'X-Device-Id',
    'client-version': 'Client-Version',
    'client-session-id': 'Client-Session-Id',
    'content-type': 'Content-Type'
};

/**
 * Cleans the intercepted headers by removing duplicates and normalizing keys.
 * @returns {boolean} True if headers were modified during cleaning.
 */
function cleanHeaders() {
    let updated = false;
    for (const key of Object.keys(twitchHeaders)) {
        const lowerKey = key.toLowerCase();
        const normalized = HEADER_KEY_MAP[lowerKey];
        if (normalized) {
            if (key !== normalized) {
                delete twitchHeaders[key];
                updated = true;
            }
        } else {
            delete twitchHeaders[key];
            updated = true;
        }
    }
    return updated;
}

// Fallback Twitch headers in case we need to make requests before intercepting new ones.
let twitchHeaders = {
    "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", 
    "Content-Type": "application/json"
};

chrome.storage.local.get('twitchHeaders', (res) => {
    if (res.twitchHeaders) {
        Object.assign(twitchHeaders, res.twitchHeaders);
        const cleaned = cleanHeaders();
        addLog(`Loaded saved Twitch headers from local storage: ${JSON.stringify(Object.keys(twitchHeaders))}`);
        if (cleaned) {
            chrome.storage.local.set({ twitchHeaders });
        }
    }
});

// Passively intercept all important tokens from network requests
chrome.webRequest.onSendHeaders.addListener(
    (details) => {
        if (details.requestHeaders) {
            let updated = false;
            for (const header of details.requestHeaders) {
                const name = header.name.toLowerCase();
                const normalized = HEADER_KEY_MAP[name];
                
                if (normalized) {
                    // Remove old duplicates with different casing (e.g. Client-ID)
                    for (const key of Object.keys(twitchHeaders)) {
                        if (key.toLowerCase() === name && key !== normalized) {
                            delete twitchHeaders[key];
                            updated = true;
                        }
                    }

                    if (twitchHeaders[normalized] !== header.value) {
                        twitchHeaders[normalized] = header.value;
                        addLog(`Intercepted/Modified header: ${normalized}`);
                        updated = true;
                    }
                }
            }
            if (updated) {
                cleanHeaders();
                chrome.storage.local.set({ twitchHeaders });
            }
        }
    },
    { urls: ["https://gql.twitch.tv/gql"] },
    ["requestHeaders"]
);

// --- Initialization ---
chrome.storage.local.get('scrapingState', (result) => {
    if (!result.scrapingState) {
        chrome.storage.local.set({ scrapingState: { phase: 'idle', collected: 0, target: 0, error: null } });
    }
});

// --- State Helpers ---

/**
 * Updates the scraping state in storage and broadcasts it to the popup.
 * @param {Object} state - The state object to save.
 */
function setState(state) {
    chrome.storage.local.set({ scrapingState: state });
    chrome.runtime.sendMessage({ action: 'state_update', state }).catch(() => {});
}

/**
 * Resets the application state to idle.
 */
function setIdle() {
    _isRunning = false;
    setState({ phase: 'idle', collected: 0, target: 0, error: null });
}

/**
 * Constructs the GraphQL query body for fetching streams.
 * @param {string} slug - The game/category slug.
 * @param {Array<string>} langFilter - Array of language codes to filter.
 * @param {string|null} cursor - The pagination cursor.
 * @param {boolean} subOnly - Whether to include Sub-Only streams.
 * @param {string} sortDir - Sort direction ('asc' or 'desc').
 * @returns {string} The stringified JSON payload.
 */
function buildGQLBody(slug, langFilter, cursor, subOnly, sortDir) {
    const langString = langFilter.join(', '); 
    // If subOnly is checked, add the restricted clause
    const restrictedClause = subOnly ? 'includeRestricted: [SUB_ONLY_LIVE]' : '';
    const sortVal = sortDir === 'asc' ? 'VIEWER_COUNT_ASC' : 'VIEWER_COUNT';
    
    return JSON.stringify({
        query: `
        query DirectoryPageGame($slug: String!, $cursor: Cursor) {
            game(slug: $slug) {
                streams(
                    first: 100
                    after: $cursor
                    options: {
                        sort: ${sortVal}
                        broadcasterLanguages: [${langString}]
                        ${restrictedClause}
                        recommendationsContext: { platform: "web" }
                        systemFilters: []
                    }
                ) {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            id title viewersCount
                            broadcaster { id login displayName description followers { totalCount } }
                            freeformTags { name }
                            game { name displayName }
                        }
                    }
                }
            }
        }`,
        variables: { slug, cursor: cursor || null }
    });
}

/**
 * Fetches panel data for a batch of Twitch users.
 * @param {Array<string>} userIds - An array of Twitch user IDs.
 * @returns {Promise<Object>} An object mapping user IDs to arrays of panel objects.
 */
async function fetchPanelsForUsers(userIds) {
    if (!userIds || userIds.length === 0) return {};
    const result = {};
    // Twitch does not support batching for panels natively within one query,
    // but we can batch multiple separate queries into one HTTP POST array.
    const bodies = userIds.map(id => ({
        operationName: "ChannelPanels",
        variables: { id },
        extensions: { persistedQuery: { version: 1, sha256Hash: "06d5b518ba3b016ebe62000151c9a81f162f2a1430eb1cf9ad0678ba56d0a768" } }
    }));
    try {
        const resp = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers: twitchHeaders,
            body: JSON.stringify(bodies)
        });
        const arr = await resp.json();
        const items = Array.isArray(arr) ? arr : [arr];
        items.forEach(item => {
            const panels = item?.data?.user?.panels;
            const userId = item?.data?.user?.id;
            if (userId && Array.isArray(panels)) {
                result[userId] = panels
                    .filter(p => p.title || p.linkURL || p.description || p.altText)
                    .map(p => ({
                        title:       p.title       || null,
                        linkURL:     p.linkURL     || null,
                        description: p.description || null,
                        altText:     p.altText     || null
                    }));
            }
        });
    } catch (e) {
        console.error("[TwitchScraper] panels fetch error:", e);
    }
    return result;
}

/**
 * Fetches social media links for a batch of Twitch channels.
 * @param {Array<string>} logins - An array of Twitch broadcaster login names.
 * @returns {Promise<Object>} An object mapping logins to arrays of social media objects.
 */
async function fetchSocialMediasBatch(logins) {
    if (!logins || logins.length === 0) return {};
    const query = `
    query GetChannelSocial($login: String!) {
      user(login: $login) {
        login
        channel {
          socialMedias {
            name
            title
            url
          }
        }
      }
    }`;
    const result = {};
    // Process in chunks of 30
    const CHUNK = 30;
    for (let i = 0; i < logins.length; i += CHUNK) {
        const chunk = logins.slice(i, i + CHUNK);
        const payload = chunk.map(login => ({ query, variables: { login } }));
        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: twitchHeaders,
                body: JSON.stringify(payload)
            });
            const arr = await resp.json();
            const items = Array.isArray(arr) ? arr : [arr];
            items.forEach((item, idx) => {
                const login = chunk[idx];
                const socials = item?.data?.user?.channel?.socialMedias;
                if (login && Array.isArray(socials)) {
                    result[login] = socials
                        .filter(s => s.url)
                        .map(s => ({ name: s.name || null, title: s.title || null, url: s.url }));
                }
            });
        } catch (e) {
            console.error("[TwitchScraper] social fetch error:", e);
        }
    }
    return result;
}

/**
 * Injects a script into the active tab to trigger the file download natively in the browser.
 * @param {Array<Object>} data - The scraped data payload.
 * @param {string} format - The file format ('json' or 'md').
 * @param {string} filename - The generated filename.
 * @param {Object} fields - Flags indicating which fields to include.
 * @param {string} sortDir - Sort direction ('asc' or 'desc').
 */
function triggerDownload(data, format, filename, fields, sortDir) {
    // fields: object with boolean flags (what to include)
    // If fields is not passed, default to all
    const f = fields || {
        channel: true, category: true, tags: true, viewers: true,
        followers: true, title: true, language: true, url: true,
        description: true, social: true, panels: true
    };

    // Sort the local data by viewer count before export
    data.sort((a, b) => {
        const vA = a.viewers || 0;
        const vB = b.viewers || 0;
        return sortDir === 'asc' ? vA - vB : vB - vA;
    });

    let content = '';
    let mimeType = '';

    if (format === 'json') {
        // Filter fields for JSON
        const filtered = data.map(s => {
            const out = {};
            if (f.title       && s.title       !== undefined) out.title       = s.title;
            if (f.channel     && s.channel     !== undefined) out.channel     = s.channel;
            if (f.category    && s.category    !== undefined) out.category    = s.category;
            if (f.viewers     && s.viewers     !== undefined) out.viewers     = s.viewers;
            if (f.followers   && s.followers   !== undefined) out.followers   = s.followers;
            if (f.language    && s.language    !== undefined) out.language    = s.language;
            if (f.tags        && s.tags        !== undefined) out.tags        = s.tags;
            if (f.url         && s.url         !== undefined) out.url         = s.url;
            if (f.description && s.description !== undefined) out.description = s.description;
            if (f.social      && s.social      && s.social.length > 0) out.social      = s.social;
            if (f.panels      && s.panels      && s.panels.length > 0) out.panels      = s.panels;
            return out;
        });
        content = JSON.stringify(filtered, null, 2);
        mimeType = 'application/json';
    } else {
        content = '# Scraped Twitch Streams\n\n';
        data.forEach((s, i) => {
            const title = f.title ? (s.title || '—') : `Record #${i + 1}`;
            content += `## ${i + 1}. ${title}\n\n`;
            if (f.channel   && s.channel)                    content += `- **Channel:** ${s.channel}\n`;
            if (f.category  && s.category)                   content += `- **Category:** ${s.category}\n`;
            if (f.viewers   && s.viewers     !== undefined)  content += `- **Viewers:** ${s.viewers}\n`;
            if (f.followers && s.followers   !== undefined)  content += `- **Followers:** ${s.followers}\n`;
            if (f.language  && s.language)                   content += `- **Language:** ${s.language}\n`;
            if (f.tags      && s.tags?.length)               content += `- **Tags:** ${s.tags.join(', ')}\n`;
            if (f.url       && s.url)                        content += `- **URL:** ${s.url}\n`;
            if (f.description && s.description) {
                content += `- **Description:**\n<details>\n<summary>Expand Description</summary>\n<blockquote>\n${s.description}\n</blockquote>\n</details>\n`;
            }

            // Socials
            if (f.social && s.social?.length) {
                content += `\n**Social Links:**\n\n`;
                s.social.forEach(sm => {
                    const label = sm.title || sm.name || sm.url;
                    content += `- [${label}](${sm.url})  \n`;
                });
                content += '\n';
            }

            // Panels: Format to markdown avoiding H3 hashes 
            if (f.panels && s.panels?.length) {
                content += `\n**Channel Panels:**\n<details>\n<summary>Expand Panels (${s.panels.length})</summary>\n<blockquote>\n\n`;
                s.panels.forEach((p, idx) => {
                    // Panel title (if exists) as a link or text (using bold text)
                    if (p.title && p.linkURL) {
                        content += `**[${p.title}](${p.linkURL})**  \n`;
                    } else if (p.title) {
                        content += `**${p.title}**  \n`;
                    } else if (p.linkURL) {
                        // Panel without title but with link (usually an image banner)
                        content += `**[🔗 Link](${p.linkURL})**  \n`;
                    }

                    // Alt text (if any)
                    if (p.altText) content += `> ${p.altText}  \n`;

                    // Description text maintaining line breaks
                    if (p.description && p.description.trim()) {
                        const lines = p.description.split('\n');
                        lines.forEach(line => {
                            content += `${line}  \n`;
                        });
                    }
                    if (idx < s.panels.length - 1) {
                        content += '\n---\n\n';
                    }
                });
                content += `\n</blockquote>\n</details>\n`;
            }

            content += '\n---\n\n';
        });
        mimeType = 'text/markdown';
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}

/**
 * Triggers the script injection into the active tab to execute the download.
 */
function downloadData(data, format, tabId, fields, sortDir) {
    if (!data || data.length === 0) { setIdle(); return; }
    const filename = `twitch_streams_${Date.now()}.${format}`;
    chrome.scripting.executeScript({
        target: { tabId },
        func: triggerDownload,
        args: [data, format, filename, fields, sortDir]
    }).catch(e => console.error("Download inject error:", e));
}

// --- Main Collection Loop ---

/**
 * The core scraping loop. Fetches data sequentially handling pagination and errors.
 * @param {string} slug - Category slug.
 * @param {Object} options - Scraping options (limits, filters).
 * @param {number} tabId - Active tab ID to bind the export.
 */
async function collectStreams(slug, options, tabId) {
    _isRunning = true;
    _shouldStop = false;
    _shouldFinish = false;
    addLog(`=== COLLECTION STARTED === Category: ${slug}, Limit: ${options.maxStreams || 'unlimited'}`);
    await ensureHeadersLoaded();

    const maxStreams = options.maxStreams > 0 ? options.maxStreams : Infinity;
    
    // IMPORTANT: If limit is infinite, force 'desc' sorting for the server request to bypass Twitch pagination bugs.
    // Local sorting will still be applied right before the file export based on user preference.
    const serverSortDir = (maxStreams === Infinity) ? 'desc' : options.sortDir;
    
    const isAll = options.langFilter.includes('all');
    // If 'all' is selected, send an empty array so Twitch returns all languages
    const langFilter = isAll ? [] : options.langFilter.map(l => l.toUpperCase());
    addLog(`Languages: ${JSON.stringify(langFilter)} (isAll: ${isAll}), SubOnly: ${options.subOnly}`);

    const collected = new Map();
    let cursor = null;
    let lastItemId = null;
    let emptyStreak = 0;

    setState({ phase: 'running', collected: 0, target: options.maxStreams || 0, error: null, tabId, format: options.format });

    while (collected.size < maxStreams && !_shouldStop && !_shouldFinish) {
        let json;
        try {
            const body = buildGQLBody(slug, langFilter, cursor, options.subOnly, serverSortDir);
            addLog(`GQL Request (cursor: ${cursor || 'none'}, sort: ${serverSortDir}). Active headers: ${JSON.stringify(Object.keys(twitchHeaders))}`);
            
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: twitchHeaders,
                body: body 
            });
            addLog(`Server response. HTTP code: ${resp.status}`);
            if (resp.status !== 200) {
                const text = await resp.text();
                addLog(`HTTP Error. Response body: ${text.substring(0, 400)}`);
                throw new Error(`HTTP ${resp.status}: ${text.substring(0, 100)}`);
            }
            json = await resp.json();
        } catch (e) {
            addLog(`Error during fetch/json: ${e.message}`);
            emptyStreak++;
            if (emptyStreak >= 3) {
                addLog(`Aborting collection: 3 consecutive network errors.`);
                break;
            }
            await new Promise(r => setTimeout(r, 800));
            continue;
        }

        if (json.errors) {
            addLog(`Twitch returned GraphQL errors: ${JSON.stringify(json.errors)}`);
            const isIntegrityError = json.errors.some(e => e.extensions?.code === 'IntegrityCheckFailed');
            if (isIntegrityError) {
                addLog(`IntegrityCheckFailed error! Collection stopped.`);
                setState({ 
                    phase: 'error', 
                    collected: collected.size, 
                    error: 'Twitch protection blocked the request. Please refresh the Twitch page (F5) and start over.', 
                    target: options.maxStreams || 0 
                });
                _isRunning = false;
                return;
            }

            emptyStreak++;
            if (emptyStreak >= 3) {
                addLog(`Aborting collection: 3 consecutive GraphQL errors.`);
                break;
            }
            await new Promise(r => setTimeout(r, 600));
            continue;
        }

        const streams = json.data?.game?.streams;
        if (!streams) {
            addLog(`Missing game.streams field in GraphQL response!`);
            emptyStreak++;
            if (emptyStreak >= 3) break;
            continue;
        }

        const edges = streams.edges || [];
        addLog(`Successfully retrieved items: ${edges.length}`);
        if (edges.length === 0) {
            emptyStreak++;
            if (emptyStreak >= 2) {
                addLog(`Aborting collection: 0 items retrieved 2 times consecutively.`);
                break;
            }
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        emptyStreak = 0;

        // Collect all valid nodes from the current page
        const batchNodes = [];
        for (const edge of edges) {
            if (collected.size + batchNodes.length >= maxStreams || _shouldStop || _shouldFinish) break;
            const node = edge.node;
            if (!node || collected.has(node.id)) continue;
            batchNodes.push(node);
        }

        // If panels are requested, fetch them in a batch for the current nodes
        let panelsMap = {};
        if (options.fields.panels && batchNodes.length > 0) {
            const userIds = batchNodes.map(n => n.broadcaster?.id).filter(Boolean);
            const BATCH = 20;
            for (let bi = 0; bi < userIds.length; bi += BATCH) {
                const chunk = userIds.slice(bi, bi + BATCH);
                const chunkMap = await fetchPanelsForUsers(chunk);
                Object.assign(panelsMap, chunkMap);
            }
        }

        // If social links are requested, fetch them in a batch for the current nodes
        let socialMap = {};
        if (options.fields.social && batchNodes.length > 0) {
            const logins = batchNodes.map(n => n.broadcaster?.login).filter(Boolean);
            socialMap = await fetchSocialMediasBatch(logins);
        }

        // Map the nodes into the structured local object representation
        for (const node of batchNodes) {
            const s = {};
            // Always collect basic fields, filter them during export
            s.title       = node.title || "";
            s.channel     = node.broadcaster?.displayName || node.broadcaster?.login || "";
            s.category    = node.game?.displayName || node.game?.name || slug;
            s.viewers     = node.viewersCount || 0;
            s.followers   = node.broadcaster?.followers?.totalCount || 0;
            s.language    = isAll
                ? (node.freeformTags?.[0]?.name ?? "unknown")
                : options.langFilter.map(l => l.toUpperCase()).join(', ');
            s.tags        = node.freeformTags?.map(t => t.name) ?? [];
            s.url         = `https://www.twitch.tv/${node.broadcaster?.login || ""}`;
            s.description = node.broadcaster?.description || "";

            // Internal fields used for enrichment later (won't be exported)
            s._login  = node.broadcaster?.login  || "";
            s._userId = node.broadcaster?.id     || "";

            // Append extra data if requested
            if (options.fields.panels) {
                s.panels = panelsMap[node.broadcaster?.id] || [];
            }
            if (options.fields.social) {
                s.social = socialMap[node.broadcaster?.login] || [];
            }

            collected.set(node.id, s);
        }

        setState({ phase: 'running', collected: collected.size, target: options.maxStreams || 0, error: null, tabId, format: options.format });

        const hasNextPage = streams.pageInfo?.hasNextPage;
        
        // Stop if Twitch indicates there are no more pages
        if (!hasNextPage || edges.length === 0) break;

        const nextCursor = edges[edges.length - 1].cursor;
        const nextLastItemId = edges[edges.length - 1].node?.id || null;
        
        // Anti-infinite-loop protection: if cursor and last item ID stay identical
        if (cursor === nextCursor && lastItemId === nextLastItemId) {
            addLog(`Aborting collection: detected infinite loop (same cursor and item ID).`);
            break;
        }
        
        cursor = nextCursor;
        lastItemId = nextLastItemId;
        await new Promise(r => setTimeout(r, 150));
    }

    _isRunning = false;

    if (_shouldStop) {
        addLog(`Collection stopped by user (Stop). Items collected: ${collected.size}`);
        setIdle();
        return;
    }

    if (_shouldFinish) {
        addLog(`Collection forcibly finished by user (Finish). Items collected: ${collected.size}`);
    } else {
        addLog(`Collection completed successfully. Total items: ${collected.size}`);
    }

    const data = Array.from(collected.values());
    const doneState = { phase: 'done', collected: data.length, target: options.maxStreams || 0, error: null };
    
    // Store collected data into local storage for downloading
    chrome.storage.local.set({ 
        scrapingState: doneState, 
        scrapedData: data, 
        scrapeMeta: { format: options.format || 'json', tabId: tabId, sortDir: options.sortDir || 'desc' } 
    }, () => {
        setState(doneState);
    });
}

// --- Data Enrichment Phase ---

/**
 * Handles the background processing of enriching already-scraped data (e.g. Socials, Panels).
 * Tracks progress and supports pausing.
 * @param {Array<Object>} data - Scraped stream objects.
 * @param {Object} fields - Fields selected for enrichment.
 * @returns {Promise<Array<Object>|null>} Enriched data array or null if paused/stopped.
 */
async function enrichData(data, fields) {
    if (!data || !fields) return data;
    await ensureHeadersLoaded();
    addLog(`=== ENRICHMENT STARTED === Streams: ${data.length}, Fields: ${JSON.stringify(fields)}`);
    _isEnriching = true;
    _shouldStopEnrich = false;
    const totalStreams = data.length;

    // Helper function to pause the process safely
    function stopAndRestore(step, done, total) {
        addLog(`Enrichment paused at step: ${step}. Processed: ${done}/${total}`);
        _isEnriching = false;
        chrome.storage.local.set({ scrapedData: data });
        const pausedState = {
            phase: 'enrich_paused',
            enrichStep: step,
            enrichDone: done,
            enrichTotal: total,
            collected: totalStreams,
            enrichFields: fields
        };
        chrome.storage.local.set({ scrapingState: pausedState });
        setState(pausedState);
    }

    // Step 1: Social Media Enrichment
    if (fields.social) {
        const missing = data.filter(s => s.social === undefined && s._login);
        const total = missing.length;
        let done = 0;
        const CHUNK = 30;

        for (let i = 0; i < missing.length; i += CHUNK) {
            if (_shouldStopEnrich) {
                stopAndRestore('social', done, total);
                return null;
            }
            const chunk = missing.slice(i, i + CHUNK);
            const socialMap = await fetchSocialMediasBatch(chunk.map(s => s._login));
            chunk.forEach(s => { s.social = socialMap[s._login] || []; });
            done += chunk.length;
            chrome.storage.local.set({ scrapedData: data });
            setState({ phase: 'enriching', enrichStep: 'social', enrichDone: done, enrichTotal: total, collected: totalStreams });
        }
    }

    if (_shouldStopEnrich) {
        const panelsMissing = fields.panels ? data.filter(s => s.panels === undefined && s._userId).length : 0;
        stopAndRestore(fields.panels ? 'panels' : 'social', 0, panelsMissing);
        return null;
    }

    // Step 2: Panels Enrichment
    if (fields.panels) {
        const missing = data.filter(s => s.panels === undefined && s._userId);
        const total = missing.length;
        let done = 0;
        const BATCH = 20;

        for (let bi = 0; bi < missing.length; bi += BATCH) {
            if (_shouldStopEnrich) {
                stopAndRestore('panels', done, total);
                return null;
            }
            const chunk = missing.slice(bi, bi + BATCH);
            const panelsMap = await fetchPanelsForUsers(chunk.map(s => s._userId));
            chunk.forEach(s => { s.panels = panelsMap[s._userId] || []; });
            done += chunk.length;
            chrome.storage.local.set({ scrapedData: data });
            setState({ phase: 'enriching', enrichStep: 'panels', enrichDone: done, enrichTotal: total, collected: totalStreams });
        }
    }

    addLog(`=== ENRICHMENT SUCCESSFULLY COMPLETED ===`);
    _isEnriching = false;
    return data;
}

// --- Message Router ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'start_collection') {
        if (_isRunning) { sendResponse({ ok: false, reason: 'already running' }); return; }
        const { tabId, options } = message;
        // Obtain the category slug strictly from the active tab's URL
        chrome.tabs.get(tabId, (tab) => {
            const match = tab?.url?.match(/\/directory\/category\/([^/]+)/);
            if (!match) {
                setState({ phase: 'error', collected: 0, error: 'Open a Twitch Category page', target: 0 });
                return;
            }
            const slug = decodeURIComponent(match[1]);
            collectStreams(slug, options, tabId);
        });
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'stop_collection') {
        _shouldStop = true;
        if (!_isRunning) setIdle(); // Rescue if already idle
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'finish_collection') {
        _shouldFinish = true;
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'download_last_data') {
        chrome.storage.local.get(['scrapedData', 'scrapeMeta'], async (res) => {
            if (res.scrapedData && res.scrapeMeta) {
                const format = message.format || res.scrapeMeta.format;
                const fields = message.fields || null;
                let data = res.scrapedData;

                const needEnrich = fields && (
                    (fields.social && data.some(s => s.social === undefined)) ||
                    (fields.panels && data.some(s => s.panels === undefined))
                );

                if (needEnrich) {
                    // Trigger enrichment process without downloading immediately
                    const enriched = await enrichData(data, fields);
                    if (enriched !== null) {
                        // Enrichment completed successfully
                        const doneState = { phase: 'done', collected: data.length, target: 0, error: null };
                        chrome.storage.local.set({ scrapingState: doneState, scrapedData: enriched });
                        setState(doneState);
                    }
                } else {
                    // Enrichment not required (already completed or bypassed). Perform download immediately.
                    const sortDir = message.sortDir || res.scrapeMeta.sortDir || 'desc';
                    downloadData(data, format, res.scrapeMeta.tabId, fields, sortDir);
                }
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'stop_enrich') {
        _shouldStopEnrich = true;
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'resume_enrich') {
        chrome.storage.local.get(['scrapedData', 'scrapingState', 'scrapeMeta'], async (res) => {
            if (res.scrapedData && res.scrapingState) {
                const fields = res.scrapingState.enrichFields || { social: true, panels: true };
                let data = res.scrapedData;

                const enriched = await enrichData(data, fields);
                if (enriched !== null) {
                    const doneState = { phase: 'done', collected: data.length, target: 0, error: null };
                    chrome.storage.local.set({ scrapingState: doneState, scrapedData: enriched });
                    setState(doneState);
                }
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'cancel_enrich') {
        chrome.storage.local.get(['scrapedData', 'scrapingState'], (res) => {
            if (res.scrapedData) {
                const data = res.scrapedData;
                const state = res.scrapingState || {};
                const fields = state.enrichFields || { social: true, panels: true };

                // Fill untouched enrichment properties with null to mark them as processed
                // and skip them in export instead of leaving them 'undefined'.
                data.forEach(s => {
                    if (fields.social && s.social === undefined) {
                        s.social = null;
                    }
                    if (fields.panels && s.panels === undefined) {
                        s.panels = null;
                    }
                });

                const doneState = { phase: 'done', collected: data.length, target: 0, error: null };
                chrome.storage.local.set({ scrapingState: doneState, scrapedData: data });
                setState(doneState);
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'full_reset') {
        _isRunning = false;
        _shouldStop = true;
        _shouldFinish = false;
        _shouldStopEnrich = true;
        _isEnriching = false;

        // Restore default hardcoded headers
        twitchHeaders = {
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            "Content-Type": "application/json"
        };

        // Complete flush of local storage
        chrome.storage.local.clear(() => {
            const idleState = { phase: 'idle', collected: 0, target: 0, error: null };
            chrome.storage.local.set({ scrapingState: idleState }, () => {
                setState(idleState);
                sendResponse({ ok: true });
            });
        });
        return true;
    }

    if (message.action === 'clear_logs') {
        _logsBuffer = [];
        chrome.storage.local.set({ debugLogs: [] }, () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (message.action === 'reset_state') {
        // Only wipe scrape-specific caches, keeping UI options intact
        chrome.storage.local.remove(['scrapedData', 'scrapeMeta']);
        if (!_isRunning) setIdle();
        sendResponse({ ok: true });
        return true;
    }

    return true;
});
