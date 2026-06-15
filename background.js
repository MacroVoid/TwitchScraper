// =============================================
// Background Service Worker
// Makes ALL GQL requests itself (bypasses CORS).
// Content.js is needed only for download injection.
// =============================================

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

// Lookup table: tag text → language code, used to detect the language tag
// among freeformTags when "all languages" is selected.
const TWITCH_LANG_CODES = {
    RU: true, EN: true, ES: true, DE: true, FR: true, PT: true, ZH: true, JA: true, KO: true,
    IT: true, PL: true, TR: true, NL: true, SV: true, DA: true, FI: true, NO: true, RO: true,
    HU: true, CS: true, EL: true, BG: true, UK: true, AR: true, HI: true, TH: true, VI: true,
    ID: true, MS: true, CA: true, SK: true, TL: true, ASL: true, OTHER: true,
    // Also common full-name variants that Twitch uses as tags
    RUSSIAN: true, ENGLISH: true, SPANISH: true, GERMAN: true, FRENCH: true, PORTUGUESE: true,
    JAPANESE: true, KOREAN: true, ITALIAN: true, POLISH: true, TURKISH: true, DUTCH: true,
    SWEDISH: true, DANISH: true, FINNISH: true, NORWEGIAN: true, ROMANIAN: true, HUNGARIAN: true,
    CZECH: true, GREEK: true, BULGARIAN: true, UKRAINIAN: true, ARABIC: true, HINDI: true,
    THAI: true, VIETNAMESE: true, INDONESIAN: true, MALAY: true, CATALAN: true, SLOVAK: true,
    TAGALOG: true, CHINESE: true
};
let _shouldStop = false;
let _shouldFinish = false;
let _isRunning = false;
let _shouldStopEnrich = false;
let _isEnriching = false;
let _heartbeatTimer = null;

let _logsBuffer = [];
let _logsDirty = false;
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

// ─── Logging with debounced persistence (A4) ─────────────────────────────────
// Previously every addLog() wrote the whole buffer to chrome.storage.local,
// which is expensive under high-frequency logging. Now we buffer writes and
// flush on a debounce timer.
const LOG_FLUSH_DELAY_MS = 1500;
let _logFlushTimer = null;

function scheduleLogFlush() {
    if (_logFlushTimer) return;
    _logFlushTimer = setTimeout(() => {
        _logFlushTimer = null;
        if (_logsDirty) {
            _logsDirty = false;
            chrome.storage.local.set({ debugLogs: _logsBuffer });
        }
    }, LOG_FLUSH_DELAY_MS);
}

function addLog(msg) {
    if (_isLoggingDisabled) return;
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const logLine = `[${timestamp}] ${msg}`;
    console.log(logLine);
    _logsBuffer.push(logLine);
    if (_logsBuffer.length > 500) _logsBuffer.shift();
    _logsDirty = true;
    scheduleLogFlush();
}

// Force-flush logs immediately (used on critical transitions / errors)
function flushLogsNow() {
    if (_logFlushTimer) {
        clearTimeout(_logFlushTimer);
        _logFlushTimer = null;
    }
    if (_logsDirty) {
        _logsDirty = false;
        chrome.storage.local.set({ debugLogs: _logsBuffer });
    }
}

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
        addLog(`Ошибка при загрузке заголовков: ${e.message}`);
    }
}

const HEADER_KEY_MAP = {
    'client-id': 'Client-Id',
    'client-integrity': 'Client-Integrity',
    'authorization': 'Authorization',
    'x-device-id': 'X-Device-Id',
    'client-version': 'Client-Version',
    'client-session-id': 'Client-Session-Id',
    'content-type': 'Content-Type'
};

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

// Leave old ID as fallback just in case,
// if we want to make a request before catching a new one
let twitchHeaders = {
    "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
    "Content-Type": "application/json"
};

chrome.storage.local.get('twitchHeaders', (res) => {
    if (res.twitchHeaders) {
        Object.assign(twitchHeaders, res.twitchHeaders);
        const cleaned = cleanHeaders();
        addLog(`Загружены сохраненные заголовки Twitch из локального хранилища: ${JSON.stringify(Object.keys(twitchHeaders))}`);
        if (cleaned) {
            chrome.storage.local.set({ twitchHeaders });
        }
    }
});

// Passively intercept ALL important tokens
chrome.webRequest.onSendHeaders.addListener(
    (details) => {
        if (details.requestHeaders) {
            let updated = false;
            for (const header of details.requestHeaders) {
                const name = header.name.toLowerCase();
                const normalized = HEADER_KEY_MAP[name];

                if (normalized) {
                    // Remove old duplicates with different case (e.g., Client-ID)
                    for (const key of Object.keys(twitchHeaders)) {
                        if (key.toLowerCase() === name && key !== normalized) {
                            delete twitchHeaders[key];
                            updated = true;
                        }
                    }

                    if (twitchHeaders[normalized] !== header.value) {
                        twitchHeaders[normalized] = header.value;
                        addLog(`Перехвачен/изменен заголовок: ${normalized}`);
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

// ─── Initialization ────────────────────────────────────────────────────────
chrome.storage.local.get('scrapingState', (result) => {
    if (!result.scrapingState) {
        chrome.storage.local.set({ scrapingState: { phase: 'idle', collected: 0, target: 0, error: null } });
    }
});

// ─── Heartbeat for Service Worker liveness (A3) ────────────────────────────
// MV3 can terminate the service worker at any time, which loses the in-memory
// _isRunning flag and leaves scrapingState stuck on 'running'. We write a
// heartbeat timestamp periodically; the popup treats a stale heartbeat as an
// interrupted run and offers recovery.
function startHeartbeat() {
    stopHeartbeat();
    const beat = () => chrome.storage.local.set({ heartbeatAt: Date.now() });
    beat();
    _heartbeatTimer = setInterval(beat, 5000);
}

function stopHeartbeat() {
    if (_heartbeatTimer) {
        clearInterval(_heartbeatTimer);
        _heartbeatTimer = null;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function setState(state) {
    chrome.storage.local.set({ scrapingState: state });
    chrome.runtime.sendMessage({ action: 'state_update', state }).catch(() => {});
}

function setIdle() {
    _isRunning = false;
    stopHeartbeat();
    chrome.storage.local.remove('heartbeatAt');
    setState({ phase: 'idle', collected: 0, target: 0, error: null });
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function buildGQLBody(slug, langFilter, cursor, subOnly, sortDir) {
    const langString = langFilter.join(', ');
    // If checkbox is checked, add parameter, else leave empty
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

// ─── Fetch channel panels ───────────────────────────────────────────────────
async function fetchPanelsForUsers(userIds) {
    if (!userIds || userIds.length === 0) return {};
    const result = {};
    // Twitch doesn't support batching for panels, so we send one request per channel
    // But wrap in a single fetch with an operationName array
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

// ─── Fetch extra info (socials and starttime) ──────────────────────────────────
async function fetchChannelExtrasBatch(logins) {
    if (!logins || logins.length === 0) return {};
    const query = `
    query GetChannelExtras($login: String!) {
      user(login: $login) {
        login
        stream {
          createdAt
        }
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
    const arr = await batchedFetch(query, logins, (login) => ({ login }), (item, login) => {
        const userNode = item?.data?.user;
        if (login && userNode) {
            const socials = userNode.channel?.socialMedias;
            const parsedSocials = Array.isArray(socials)
                ? socials.filter(s => s.url).map(s => ({ name: s.name || null, title: s.title || null, url: s.url }))
                : [];
            result[login] = {
                socials: parsedSocials,
                createdAt: userNode.stream?.createdAt || null
            };
        }
    });
    return result;
}

// ─── Generic batched GraphQL fetch with bounded concurrency (B1) ─────────────
// Runs many per-item queries in parallel chunks. Previously extras/panels were
// fetched strictly sequentially which made large categories slow.
const ENRICH_CONCURRENCY = 4;

async function pLimit(maxConcurrency, tasks) {
    const results = new Array(tasks.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= tasks.length) return;
            results[i] = await tasks[i]();
        }
    }
    const workers = [];
    for (let w = 0; w < Math.min(maxConcurrency, tasks.length); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

/**
 * Fetches a per-item GraphQL query in parallel chunks.
 * buildVars(item) -> query variables; handleItem(item, parsedLogin/itemId) populates result.
 */
async function batchedFetch(query, items, buildVars, handleItem) {
    const CHUNK = 30;
    const chunks = [];
    for (let i = 0; i < items.length; i += CHUNK) {
        chunks.push(items.slice(i, i + CHUNK));
    }
    await pLimit(ENRICH_CONCURRENCY, chunks.map((chunk) => async () => {
        const payload = chunk.map(item => ({ query, variables: buildVars(item) }));
        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: twitchHeaders,
                body: JSON.stringify(payload)
            });
            const arr = await resp.json();
            const responseItems = Array.isArray(arr) ? arr : [arr];
            responseItems.forEach((item, idx) => {
                handleItem(item, chunk[idx]);
            });
        } catch (e) {
            console.error("[TwitchScraper] batchedFetch error:", e);
        }
    }));
}

// Panels also use batched fetch but need persistedQuery body instead of query.
async function fetchPanelsBatched(userIds) {
    const result = {};
    const CHUNK = 20;
    const chunks = [];
    for (let i = 0; i < userIds.length; i += CHUNK) {
        chunks.push(userIds.slice(i, i + CHUNK));
    }
    await pLimit(ENRICH_CONCURRENCY, chunks.map((chunk) => async () => {
        const chunkMap = await fetchPanelsForUsers(chunk);
        Object.assign(result, chunkMap);
    }));
    return result;
}

// ─── Statistics computation (C4) ────────────────────────────────────────────
function computeStats(data) {
    if (!data || data.length === 0) {
        return { total: 0, totalViewers: 0, avgViewers: 0, topChannels: [] };
    }
    const totalViewers = data.reduce((sum, s) => sum + (s.viewers || 0), 0);
    const top = [...data]
        .sort((a, b) => (b.viewers || 0) - (a.viewers || 0))
        .slice(0, 3)
        .map(s => ({ channel: s.channel, viewers: s.viewers || 0 }));
    return {
        total: data.length,
        totalViewers,
        avgViewers: Math.round(totalViewers / data.length),
        topChannels: top
    };
}



// ─── Inject download into Twitch tab ──────────────────────────────────────
function triggerDownload(data, format, filename, fields, sortDir, timeFormat, lang) {
    // fields — object with boolean flags (what to show)
    const f = fields || {
        channel: true, category: true, tags: true, viewers: true,
        followers: true, title: true, language: true, url: true,
        description: true, social: true, panels: true, starttime: true, duration: true
    };
    const tf = timeFormat || { start: 'iso', duration: 'hms' };
    const locale = lang || 'ru';

    const labels = locale === 'en' ? {
        channel: 'Channel',
        category: 'Category',
        viewers: 'Viewers',
        followers: 'Followers',
        language: 'Language',
        tags: 'Tags',
        url: 'URL',
        startTime: 'Start Time',
        duration: 'Duration',
        description: 'Description',
        social: 'Social Networks'
    } : {
        channel: 'Канал',
        category: 'Категория',
        viewers: 'Зрители',
        followers: 'Фолловеры',
        language: 'Язык',
        tags: 'Теги',
        url: 'Ссылка',
        startTime: 'Время начала',
        duration: 'Продолжительность',
        description: 'Описание',
        social: 'Соц. сети'
    };

    const docHeader = locale === 'en' ? '# Collected Twitch Streams\n\n' : '# Собранные трансляции Twitch\n\n';
    const itemPrefix = locale === 'en' ? 'Stream' : 'Запись';
    const descSummary = locale === 'en' ? 'Expand description' : 'Развернуть описание';
    const panelsHeader = locale === 'en' ? 'Channel Panels:' : 'Панели канала:';
    const panelsSummary = locale === 'en' ? 'Expand panels' : 'Развернуть панели';

    // Function to format start time
    const formatStart = (isoString) => {
        if (!isoString) return '—';
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return isoString;
        switch (tf.start) {
            case 'unix': return Math.floor(d.getTime() / 1000).toString();
            case 'gmt': return d.toUTCString();
            case 'local12': return d.toLocaleString(undefined, { hour12: true });
            case 'local24': return d.toLocaleString(undefined, { hour12: false });
            case 'iso':
            default: return isoString;
        }
    };

    // Function to format duration
    const formatDuration = (isoString) => {
        if (!isoString) return '—';
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return '—';
        const diffMs = Date.now() - d.getTime();
        const totalSecs = Math.floor(diffMs / 1000);
        if (tf.duration === 'sec') {
            return `${totalSecs}s`;
        } else {
            const hrs = Math.floor(totalSecs / 3600);
            const mins = Math.floor((totalSecs % 3600) / 60);
            const secs = totalSecs % 60;
            return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    };

    // Sort local data by viewers before export
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
            if (f.starttime   && s.createdAt   !== undefined) out.startTime   = formatStart(s.createdAt);
            if (f.duration    && s.createdAt   !== undefined) out.duration    = formatDuration(s.createdAt);
            if (f.description && s.description !== undefined) out.description = s.description;
            if (f.social      && s.social      && s.social.length > 0) out.social      = s.social;
            if (f.panels      && s.panels      && s.panels.length > 0) out.panels      = s.panels;
            return out;
        });
        content = JSON.stringify(filtered, null, 2);
        mimeType = 'application/json';
    } else if (format === 'csv') {
        // Build header from selected fields
        
        // ─── CSV escaping (RFC 4180) (C2) ───────────────────────────────────────────
        const csvEscape = (value) => {
            if (value === null || value === undefined) return '';
            let str;
            if (Array.isArray(value)) {
                // tags / socials — join into a single cell
                str = value.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' | ');
            } else if (typeof value === 'object') {
                str = JSON.stringify(value);
            } else {
                str = String(value);
            }
            if (/[",\n\r]/.test(str)) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };
        const headerCells = [];
        const rowGetters = [];
        const addCol = (label, getter) => { headerCells.push(label); rowGetters.push(getter); };

        if (f.title)       addCol(labels.channel + ' / ' + (locale === 'en' ? 'Title' : 'Название'), s => s.title || '');
        if (f.channel)     addCol(labels.channel,  s => s.channel || '');
        if (f.category)    addCol(labels.category, s => s.category || '');
        if (f.viewers)     addCol(labels.viewers,  s => s.viewers || 0);
        if (f.followers)   addCol(labels.followers, s => s.followers || 0);
        if (f.language)    addCol(labels.language, s => s.language || '');
        if (f.tags)        addCol(labels.tags,     s => (s.tags || []).join(', '));
        if (f.url)         addCol(labels.url,      s => s.url || '');
        if (f.starttime)   addCol(labels.startTime, s => formatStart(s.createdAt));
        if (f.duration)    addCol(labels.duration, s => formatDuration(s.createdAt));
        if (f.description) addCol(labels.description, s => s.description || '');
        if (f.social)      addCol(labels.social,   s => s.social || []);

        const lines = [headerCells.map(csvEscape).join(',')];
        data.forEach(s => {
            lines.push(rowGetters.map(g => csvEscape(g(s))).join(','));
        });
        content = '\uFEFF' + lines.join('\r\n'); // BOM for Excel UTF-8
        mimeType = 'text/csv';
    } else {
        content = docHeader;
        data.forEach((s, i) => {
            const title = f.title ? (s.title || '—') : `${itemPrefix} #${i + 1}`;
            content += `## ${i + 1}. ${title}\n\n`;
            if (f.channel   && s.channel)                    content += `- **${labels.channel}:** ${s.channel}\n`;
            if (f.category  && s.category)                   content += `- **${labels.category}:** ${s.category}\n`;
            if (f.viewers   && s.viewers     !== undefined)   content += `- **${labels.viewers}:** ${s.viewers}\n`;
            if (f.followers && s.followers   !== undefined)   content += `- **${labels.followers}:** ${s.followers}\n`;
            if (f.language  && s.language)                   content += `- **${labels.language}:** ${s.language}\n`;
            if (f.tags      && s.tags?.length)               content += `- **${labels.tags}:** ${s.tags.join(', ')}\n`;
            if (f.url       && s.url)                        content += `- **${labels.url}:** ${s.url}\n`;

            if (f.starttime && s.createdAt)                  content += `- **${labels.startTime}:** ${formatStart(s.createdAt)}\n`;
            if (f.duration  && s.createdAt)                  content += `- **${labels.duration}:** ${formatDuration(s.createdAt)}\n`;

            if (f.description && s.description) {
                content += `- **${labels.description}:**\n<details>\n<summary>${descSummary}</summary>\n<blockquote>\n${s.description}\n</blockquote>\n</details>\n`;
            }

            // Social networks
            if (f.social && s.social?.length) {
                content += `\n**${labels.social}:**\n\n`;
                s.social.forEach(sm => {
                    const label = sm.title || sm.name || sm.url;
                    content += `- [${label}](${sm.url})  \n`;
                });
                content += '\n';
            }

            // Panels — beautiful Markdown without document headers
            if (f.panels && s.panels?.length) {
                content += `\n**${panelsHeader}**\n<details>\n<summary>${panelsSummary} (${s.panels.length})</summary>\n<blockquote>\n\n`;
                s.panels.forEach((p, idx) => {
                    if (p.title && p.linkURL) {
                        content += `**[${p.title}](${p.linkURL})**  \n`;
                    } else if (p.title) {
                        content += `**${p.title}**  \n`;
                    } else if (p.linkURL) {
                        content += `**[🔗 URL](${p.linkURL})**  \n`;
                    }
                    if (p.altText) content += `> ${p.altText}  \n`;
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

// ─── Filename with category slug + date (C3) ────────────────────────────────
function buildFilename(format, slug) {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const safeSlug = (slug || 'streams').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40) || 'streams';
    return `twitch_${safeSlug}_${dateStr}.${format}`;
}

function downloadData(data, format, tabId, fields, sortDir, timeFormat, lang, slug) {
    if (!data || data.length === 0) { setIdle(); return; }
    const filename = buildFilename(format, slug);
    chrome.scripting.executeScript({
        target: { tabId },
        func: triggerDownload,
        args: [data, format, filename, fields, sortDir, timeFormat, lang]
    }).catch(e => console.error("Download inject error:", e));
}

// ─── Main collection loop ────────────────────────────────────────────────────
async function collectStreams(slug, options, tabId) {
    _isRunning = true;
    _shouldStop = false;
    _shouldFinish = false;
    addLog(`=== ЗАПУСК СБОРА === Category: ${slug}, Лимит: ${options.maxStreams || 'без лимита'}`);
    await ensureHeadersLoaded();
    startHeartbeat();

    const maxStreams = options.maxStreams > 0 ? options.maxStreams : Infinity;
    const minViewers = options.minViewers > 0 ? options.minViewers : 0;

    // If no limit (unlimited), always send 'desc' to server,
    // to bypass Twitch pagination bugs for VIEWER_COUNT_ASC.
    // Local sorting in desired direction will be applied before file write.
    const serverSortDir = (maxStreams === Infinity) ? 'desc' : options.sortDir;

    const isAll = options.langFilter.includes('all');
    // If 'all' is selected, pass empty array for Twitch to return all languages
    const langFilter = isAll ? [] : options.langFilter.map(l => l.toUpperCase());
    addLog(`Языки: ${JSON.stringify(langFilter)} (isAll: ${isAll}), SubOnly: ${options.subOnly}, MinViewers: ${minViewers}`);

    const collected = new Map();
    let cursor = null;
    let lastItemId = null;
    let emptyStreak = 0;

    setState({ phase: 'running', collected: 0, target: options.maxStreams || 0, error: null, tabId, format: options.format });

    // Unified error threshold (A5) — every error path increments this and bails
    // after MAX_ERRORS consecutive failures, using exponential backoff.
    const MAX_ERRORS = 3;

    while (collected.size < maxStreams && !_shouldStop && !_shouldFinish) {
        let json;
        try {
            const body = buildGQLBody(slug, langFilter, cursor, options.subOnly, serverSortDir);
            addLog(`Запрос GQL (курсор: ${cursor || 'нет'}, сортировка: ${serverSortDir}). Активные заголовки: ${JSON.stringify(Object.keys(twitchHeaders))}`);

            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: twitchHeaders,
                body: body
            });
            addLog(`Ответ сервера. HTTP-код: ${resp.status}`);
            if (resp.status !== 200) {
                const text = await resp.text();
                addLog(`Ошибка HTTP. Тело ответа: ${text.substring(0, 400)}`);
                throw new Error(`HTTP ${resp.status}: ${text.substring(0, 100)}`);
            }
            json = await resp.json();
        } catch (e) {
            addLog(`Ошибка при fetch/json: ${e.message}`);
            emptyStreak++;
            if (emptyStreak >= MAX_ERRORS) {
                addLog(`Прерываем сбор: ${MAX_ERRORS} ошибки подряд.`);
                break;
            }
            // Exponential backoff (A5): 800ms, 1600ms, 3200ms...
            await new Promise(r => setTimeout(r, 800 * Math.pow(2, emptyStreak - 1)));
            continue;
        }

        if (json.errors) {
            addLog(`Twitch вернул GraphQL ошибки: ${JSON.stringify(json.errors)}`);
            const isIntegrityError = json.errors.some(e => e.extensions?.code === 'IntegrityCheckFailed');
            if (isIntegrityError) {
                addLog(`Ошибка целостности IntegrityCheckFailed! Сбор остановлен.`);
                flushLogsNow();
                setState({
                    phase: 'error',
                    collected: collected.size,
                    error: 'Защита Twitch заблокировала запрос. Пожалуйста, обновите страницу Twitch (клавиша F5) и запустите сбор снова.',
                    target: options.maxStreams || 0
                });
                _isRunning = false;
                stopHeartbeat();
                chrome.storage.local.remove('heartbeatAt');
                return;
            }

            emptyStreak++;
            if (emptyStreak >= MAX_ERRORS) {
                addLog(`Прерываем сбор: ${MAX_ERRORS} ошибки GraphQL подряд.`);
                break;
            }
            await new Promise(r => setTimeout(r, 600 * Math.pow(2, emptyStreak - 1)));
            continue;
        }

        const streams = json.data?.game?.streams;
        if (!streams) {
            addLog(`Отсутствует поле game.streams в ответе GraphQL!`);
            emptyStreak++;
            if (emptyStreak >= MAX_ERRORS) break;
            continue;
        }

        const edges = streams.edges || [];
        addLog(`Успешно получено элементов: ${edges.length}`);
        if (edges.length === 0) {
            emptyStreak++;
            if (emptyStreak >= MAX_ERRORS) {
                addLog(`Прерываем сбор: ${MAX_ERRORS} раза подряд получено 0 элементов.`);
                break;
            }
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        emptyStreak = 0;

        // First collect all nodes from this page
        const batchNodes = [];
        let brokeDueToViewers = false;
        for (const edge of edges) {
            if (collected.size + batchNodes.length >= maxStreams || _shouldStop || _shouldFinish) break;
            const node = edge.node;
            if (!node || collected.has(node.id)) continue;

            // C1: minViewers filter — early exit only valid for desc server sort,
            // where viewers monotonically decrease. For asc, we can't early-exit
            // (would miss later qualifying streams), so just skip the item.
            if (minViewers > 0 && (node.viewersCount || 0) < minViewers) {
                if (serverSortDir === 'desc') { brokeDueToViewers = true; break; }
                continue;
            }
            batchNodes.push(node);
        }

        // If panels are needed — fetch them in parallel (B1)
        let panelsMap = {};
        if (options.fields.panels && batchNodes.length > 0) {
            const userIds = batchNodes.map(n => n.broadcaster?.id).filter(Boolean);
            panelsMap = await fetchPanelsBatched(userIds);
        }

        // If socials OR time are needed — fetch them in parallel (B1)
        let extrasMap = {};
        if ((options.fields.social || options.fields.starttime || options.fields.duration) && batchNodes.length > 0) {
            const logins = batchNodes.map(n => n.broadcaster?.login).filter(Boolean);
            extrasMap = await fetchChannelExtrasBatch(logins);
        }

        for (const node of batchNodes) {
            // Always collect ALL base fields — filtering happens on download
            const s = {};
            s.title       = node.title || "";
            s.channel     = node.broadcaster?.displayName || node.broadcaster?.login || "";
            s.category    = node.game?.displayName || node.game?.name || slug;
            s.viewers     = node.viewersCount || 0;
            s.followers   = node.broadcaster?.followers?.totalCount || 0;
            // A1: Twitch's public GQL doesn't expose broadcasterLanguage on Stream or User.
            // Use freeformTags — Twitch stores the stream language as one of the tags (e.g. "Русский", "English").
            // When a specific language filter is active, that filter is the authoritative language label.
            // When "all" is selected, pick the tag that looks like a known language tag.
            const tags = node.freeformTags?.map(t => t.name) ?? [];
            if (isAll) {
                // "All languages" selected — find a tag that matches a known language code
                const langCodeMap = TWITCH_LANG_CODES;
                const langTag = tags.find(t => langCodeMap[t.toUpperCase()]) || tags[0] || "unknown";
                s.language = langTag;
            } else {
                // Specific language(s) selected — use the selected label(s)
                s.language = options.langFilter.join(', ');
            }
            s.tags = tags;
            s.url         = `https://www.twitch.tv/${node.broadcaster?.login || ""}`;
            s.description = node.broadcaster?.description || "";

            // Service fields for subsequent enrichment (won't be exported)
            s._login  = node.broadcaster?.login  || "";
            s._userId = node.broadcaster?.id     || "";

            // Panels — only if requested
            if (options.fields.panels) {
                s.panels = panelsMap[node.broadcaster?.id] || [];
            }

            // Social networks и Время — сохраняем оба поля, если запросили хотя бы одно
            if (options.fields.social || options.fields.starttime || options.fields.duration) {
                const ext = extrasMap[node.broadcaster?.login] || { socials: [], createdAt: null };
                s.social = ext.socials;
                s.createdAt = ext.createdAt;
            }

            collected.set(node.id, s);
        }

        setState({ phase: 'running', collected: collected.size, target: options.maxStreams || 0, error: null, tabId, format: options.format });

        const hasNextPage = streams.pageInfo?.hasNextPage;

        // Early exit: all remaining streams are below minViewers threshold
        if (brokeDueToViewers) {
            addLog(`Досрочное завершение: зрители опустились ниже минимума (${minViewers}).`);
            break;
        }

        // IMPORTANT: Removed || newInBatch === 0. Collection stops only when Twitch says no more pages.
        if (!hasNextPage || edges.length === 0) break;

        const nextCursor = edges[edges.length - 1].cursor;
        const nextLastItemId = edges[edges.length - 1].node?.id || null;

        // Infinite loop protection: if server hangs and returns same cursor
        if (cursor === nextCursor && lastItemId === nextLastItemId) {
            addLog(`Прерываем сбор: обнаружен бесконечный цикл (тот же курсор и ID последнего элемента).`);
            break;
        }

        cursor = nextCursor;
        lastItemId = nextLastItemId;
        await new Promise(r => setTimeout(r, 150));
    }

    _isRunning = false;
    stopHeartbeat();
    chrome.storage.local.remove('heartbeatAt');

    if (_shouldStop) {
        addLog(`Сбор остановлен пользователем (Стоп). Собрано элементов: ${collected.size}`);
        setIdle();
        return;
    }

    if (_shouldFinish) {
        addLog(`Сбор принудительно завершен пользователем (Завершить). Собрано элементов: ${collected.size}`);
    } else {
        addLog(`Сбор завершен полностью. Всего собрано элементов: ${collected.size}`);
    }

    const data = Array.from(collected.values());
    const stats = computeStats(data); // C4
    const doneState = { phase: 'done', collected: data.length, target: options.maxStreams || 0, error: null, stats };
        chrome.storage.local.set({
            scrapedData: data,
            scrapingState: doneState,
            scrapeMeta: {
                format: options.format || 'json',
                tabId: tabId,
                sortDir: options.sortDir || 'desc',
                timeFormat: options.timeFormat || { start: 'iso', duration: 'hms' },
                slug: slug, // C3: needed for filename at download time
                stats
            }
        }, () => {
        setState(doneState);
    });
}

// ─── Enrich already collected data with progress ────────────────────────
async function enrichData(data, fields) {
    if (!data || !fields) return data;
    await ensureHeadersLoaded();
    addLog(`=== НАЧАЛО ОБОГАЩЕНИЯ === Стримов: ${data.length}, Поля: ${JSON.stringify(fields)}`);
    _isEnriching = true;
    _shouldStopEnrich = false;
    const totalStreams = data.length;

    // Interrupt function: save what we have and pause
    function stopAndRestore(step, done, total) {
        addLog(`Обогащение приостановлено на шаге: ${step}. Обработано: ${done}/${total}`);
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

    // Social networks и Время (доп. поля)
    if (fields.social || fields.starttime || fields.duration) {
        const missing = data.filter(s =>
            ((fields.social && s.social === undefined) || ((fields.starttime || fields.duration) && s.createdAt === undefined)) && s._login
        );
        const total = missing.length;
        if (total > 0) {
            const CHUNK = 30;
            // Build chunk tasks for parallel execution (B1)
            const chunkStarts = [];
            for (let i = 0; i < total; i += CHUNK) chunkStarts.push(i);

            await pLimit(ENRICH_CONCURRENCY, chunkStarts.map((start) => async () => {
                if (_shouldStopEnrich) return;
                const chunk = missing.slice(start, start + CHUNK);
                const extrasMap = await fetchChannelExtrasBatch(chunk.map(s => s._login));
                chunk.forEach(s => {
                    const ext = extrasMap[s._login] || { socials: [], createdAt: null };
                    s.social = ext.socials;
                    s.createdAt = ext.createdAt;
                });
                chrome.storage.local.set({ scrapedData: data });
                // Approximate progress: report processed count via running state
                const processedSoFar = missing.filter(s => s.social !== undefined || s.createdAt !== undefined).length;
                setState({ phase: 'enriching', enrichStep: 'extras', enrichDone: Math.min(processedSoFar, total), enrichTotal: total, collected: totalStreams });
            }));

            if (_shouldStopEnrich) {
                const done = missing.filter(s => s.social !== undefined || s.createdAt !== undefined).length;
                stopAndRestore('extras', done, total);
                return null;
            }
        }
    }

    if (_shouldStopEnrich) {
        const panelsMissing = fields.panels ? data.filter(s => s.panels === undefined && s._userId).length : 0;
        stopAndRestore('panels', 0, panelsMissing);
        return null;
    }

    // Panels
    if (fields.panels) {
        const missing = data.filter(s => s.panels === undefined && s._userId);
        const total = missing.length;
        const BATCH = 20;
        const chunkStarts = [];
        for (let bi = 0; bi < missing.length; bi += BATCH) chunkStarts.push(bi);

        await pLimit(ENRICH_CONCURRENCY, chunkStarts.map((start) => async () => {
            if (_shouldStopEnrich) return;
            const chunk = missing.slice(start, start + BATCH);
            const panelsMap = await fetchPanelsForUsers(chunk.map(s => s._userId));
            chunk.forEach(s => { s.panels = panelsMap[s._userId] || []; });
            chrome.storage.local.set({ scrapedData: data });
            const processedSoFar = missing.filter(s => s.panels !== undefined).length;
            setState({ phase: 'enriching', enrichStep: 'panels', enrichDone: Math.min(processedSoFar, total), enrichTotal: total, collected: totalStreams });
        }));

        if (_shouldStopEnrich) {
            const done = missing.filter(s => s.panels !== undefined).length;
            stopAndRestore('panels', done, total);
            return null;
        }
    }

    addLog(`=== ОБОГАЩЕНИЕ ЗАВЕРШЕНО УСПЕШНО ===`);
    _isEnriching = false;
    return data;
}

// ─── Message handler ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'start_collection') {
        if (_isRunning) { sendResponse({ ok: false, reason: 'already running' }); return; }
        const { tabId, options } = message;
        // Получаем slug из URL вкладки — не нужен content.js!
        chrome.tabs.get(tabId, (tab) => {
            const match = tab?.url?.match(/\/directory\/category\/([^/]+)/);
            if (!match) {
                setState({ phase: 'error', collected: 0, error: 'Откройте страницу категории Twitch', target: 0 });
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
        if (!_isRunning) setIdle(); // In case it already doesn't work
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
                const lang = message.lang || 'ru';

                const tf = message.timeFormat || res.scrapeMeta.timeFormat || { start: 'iso', duration: 'hms' };
                const needEnrich = fields && (
                    (fields.social && data.some(s => s.social === undefined)) ||
                    ((fields.starttime || fields.duration) && data.some(s => s.createdAt === undefined)) ||
                    (fields.panels && data.some(s => s.panels === undefined))
                );

                if (needEnrich) {
                    // Start enrichment, but don't download file automatically
                    res.scrapeMeta.timeFormat = tf;
                    chrome.storage.local.set({ scrapeMeta: res.scrapeMeta });
                    const enriched = await enrichData(data, fields);
                    if (enriched !== null) {
                        // Enrichment completed: save and show 'Download file' button
                        const stats = computeStats(enriched);
                        const doneState = { phase: 'done', collected: data.length, target: 0, error: null, stats };
                        chrome.storage.local.set({ scrapingState: doneState, scrapedData: enriched, scrapeMeta: { ...res.scrapeMeta, stats } });
                        setState(doneState);
                    }
                } else {
                    // Enrichment not needed (already done or cancelled) — download immediately
                    const sortDir = message.sortDir || res.scrapeMeta.sortDir || 'desc';
                    downloadData(data, format, res.scrapeMeta.tabId, fields, sortDir, tf, lang, res.scrapeMeta.slug);
                }
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'copy_last_data') {
        // D2: copy filtered JSON to clipboard
        chrome.storage.local.get(['scrapedData', 'scrapeMeta'], async (res) => {
            if (res.scrapedData) {
                const fields = message.fields || null;
                let data = res.scrapedData;
                const lang = message.lang || 'ru';
                const tf = message.timeFormat || res.scrapeMeta?.timeFormat || { start: 'iso', duration: 'hms' };

                // Reuse triggerDownload's JSON filtering by computing inline.
                // We perform enrichment only if explicitly required; otherwise copy as-is.
                const f = fields || {
                    channel: true, category: true, tags: true, viewers: true,
                    followers: true, title: true, language: true, url: true,
                    description: true, social: true, panels: true, starttime: true, duration: true
                };

                const formatStart = (isoString) => {
                    if (!isoString) return '—';
                    const d = new Date(isoString);
                    if (isNaN(d.getTime())) return isoString;
                    switch (tf.start) {
                        case 'unix': return Math.floor(d.getTime() / 1000).toString();
                        case 'gmt': return d.toUTCString();
                        case 'local12': return d.toLocaleString(undefined, { hour12: true });
                        case 'local24': return d.toLocaleString(undefined, { hour12: false });
                        case 'iso':
                        default: return isoString;
                    }
                };

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
                    if (f.starttime   && s.createdAt   !== undefined) out.startTime   = formatStart(s.createdAt);
                    if (f.description && s.description !== undefined) out.description = s.description;
                    if (f.social      && s.social      && s.social.length > 0) out.social = s.social;
                    if (f.panels      && s.panels      && s.panels.length > 0) out.panels = s.panels;
                    return out;
                });
                const jsonStr = JSON.stringify(filtered, null, 2);
                sendResponse({ ok: true, data: jsonStr });
            } else {
                sendResponse({ ok: false, reason: 'no data' });
            }
        });
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
                const fields = res.scrapingState.enrichFields || { social: true, starttime: true, duration: true, panels: true };
                let data = res.scrapedData;

                const enriched = await enrichData(data, fields);
                if (enriched !== null) {
                    const stats = computeStats(enriched);
                    const doneState = { phase: 'done', collected: data.length, target: 0, error: null, stats };
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
                const fields = state.enrichFields || { social: true, starttime: true, duration: true, panels: true };

                // Fill unprocessed fields with null so they don't get enriched or exported
                data.forEach(s => {
                    if (fields.social && s.social === undefined) {
                        s.social = null;
                    }
                    if ((fields.starttime || fields.duration) && s.createdAt === undefined) {
                        s.createdAt = null;
                    }
                    if (fields.panels && s.panels === undefined) {
                        s.panels = null;
                    }
                });

                const stats = computeStats(data);
                const doneState = { phase: 'done', collected: data.length, target: 0, error: null, stats };
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
        stopHeartbeat();

        // Restore default headers
        twitchHeaders = {
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            "Content-Type": "application/json"
        };

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
        _logsDirty = false;
        if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
        chrome.storage.local.set({ debugLogs: [] }, () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (message.action === 'reset_state') {
        // Clear saved data on reset
        stopHeartbeat();
        chrome.storage.local.remove(['scrapedData', 'scrapeMeta', 'heartbeatAt']);
        if (!_isRunning) setIdle();
        sendResponse({ ok: true });
        return true;
    }

    return true;
});
