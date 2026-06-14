// =============================================
// Background Service Worker
// Делает ВСЕ GQL-запросы сам (обходит CORS).
// Content.js нужен только для инжекта скачивания.
// =============================================

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
let _shouldStop = false;
let _shouldFinish = false;
let _isRunning = false;

// Оставляем старый ID как запасной (fallback) на случай, 
// если мы захотим сделать запрос до того, как поймаем новый
let twitchHeaders = {
    "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", 
    "Content-Type": "application/json"
};

// Пассивно перехватываем ВСЕ важные токены
chrome.webRequest.onSendHeaders.addListener(
    (details) => {
        if (details.requestHeaders) {
            for (const header of details.requestHeaders) {
                const name = header.name.toLowerCase();
                
                // Добавили 'client-id' в массив!
                if (['client-id', 'client-integrity', 'authorization', 'x-device-id', 'client-version', 'client-session-id'].includes(name)) {
                    twitchHeaders[header.name] = header.value;
                }
            }
        }
    },
    { urls: ["https://gql.twitch.tv/gql"] },
    ["requestHeaders"]
);

// ─── Инициализация ────────────────────────────────────────────────────────
chrome.storage.local.get('scrapingState', (result) => {
    if (!result.scrapingState) {
        chrome.storage.local.set({ scrapingState: { phase: 'idle', collected: 0, target: 0, error: null } });
    }
});

// ─── Вспомогательные ──────────────────────────────────────────────────────
function setState(state) {
    chrome.storage.local.set({ scrapingState: state });
    chrome.runtime.sendMessage({ action: 'state_update', state }).catch(() => {});
}

function setIdle() {
    _isRunning = false;
    setState({ phase: 'idle', collected: 0, target: 0, error: null });
}

// ─── Вспомогательные ──────────────────────────────────────────────────────
function buildGQLBody(slug, langFilter, cursor, subOnly) {
    const langString = langFilter.join(', '); 
    // Если галочка стоит, добавляем параметр, иначе оставляем пустым
    const restrictedClause = subOnly ? 'includeRestricted: [SUB_ONLY_LIVE]' : '';
    
    return JSON.stringify({
        query: `
        query DirectoryPageGame($slug: String!, $cursor: Cursor) {
            game(name: $slug) {
                streams(
                    first: 100
                    after: $cursor
                    options: {
                        sort: VIEWER_COUNT
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
                            broadcaster { login displayName description } # <-- Добавили description!
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

// Инжект скачивания в Twitch-вкладку
function triggerDownload(data, format, filename) {
    let content = '';
    let mimeType = '';
    if (format === 'json') {
        content = JSON.stringify(data, null, 2);
        mimeType = 'application/json';
    } else {
        content = '# Собранные трансляции Twitch\n\n';
        data.forEach((s, i) => {
            content += `## ${i + 1}. ${s.title || '—'}\n\n`;
            if (s.channel)      content += `- **Канал:** ${s.channel}\n`;
            if (s.category)     content += `- **Категория:** ${s.category}\n`;
            
            // Проверяем !== undefined, чтобы 0 зрителей тоже выводилось
            if (s.viewers !== undefined) content += `- **Зрители:** ${s.viewers}\n`;
            
            if (s.language)     content += `- **Язык:** ${s.language}\n`;
            if (s.tags?.length) content += `- **Теги:** ${s.tags.join(', ')}\n`;
            if (s.url)          content += `- **Ссылка:** ${s.url}\n`;
            
            // Добавляем описание в Markdown
            if (s.description)  content += `- **Описание:** ${s.description}\n`;
            
            content += '\n---\n\n';
        });
        mimeType = 'text/markdown';
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}

function downloadData(data, format, tabId) {
    if (!data || data.length === 0) { setIdle(); return; }
    const filename = `twitch_streams_${Date.now()}.${format}`;
    chrome.scripting.executeScript({
        target: { tabId },
        func: triggerDownload,
        args: [data, format, filename]
    }).catch(e => console.error("Download inject error:", e));
}

// ─── Основной цикл сбора ────────────────────────────────────────────────────
async function collectStreams(slug, options, tabId) {
    _isRunning = true;
    _shouldStop = false;
    _shouldFinish = false;

    const maxStreams = options.maxStreams > 0 ? options.maxStreams : Infinity;
    
    // Копируем гигантский массив "Всех языков" из логов официального сайта Twitch
    const TWITCH_ALL_LANGS = ["EN","RU","ID","CA","DA","DE","ES","FR","IT","HU","NL","NO","PL","PT","RO","SK","FI","SV","TL","VI","TR","CS","BG","EL","UK","AR","HI","MS","TH","ZH","KO","JA","ASL","OTHER"];
    const isAll = options.langFilter === 'all';
    // Если выбрано 'all', передаем полный массив. Иначе - выбранный язык
    const langFilter = isAll ? TWITCH_ALL_LANGS : [options.langFilter.toUpperCase()];

    const collected = new Map();
    let cursor = null;
    let emptyStreak = 0;

    setState({ phase: 'running', collected: 0, target: options.maxStreams || 0, error: null, tabId, format: options.format });

    while (collected.size < maxStreams && !_shouldStop && !_shouldFinish) {
        let json;
        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: twitchHeaders,
                // ИЗМЕНЕНО: передаем options.subOnly в функцию генерации запроса
                body: buildGQLBody(slug, langFilter, cursor, options.subOnly) 
            });
            json = await resp.json();
        } catch (e) {
            console.error("[TwitchScraper] fetch error:", e);
            emptyStreak++;
            if (emptyStreak >= 3) break;
            await new Promise(r => setTimeout(r, 800));
            continue;
        }

        if (json.errors) {
            console.warn("[TwitchScraper] GQL errors:", json.errors);
            const isIntegrityError = json.errors.some(e => e.extensions?.code === 'IntegrityCheckFailed');
            if (isIntegrityError) {
                setState({ 
                    phase: 'error', 
                    collected: collected.size, 
                    error: 'Защита Twitch заблокировала запрос. Пожалуйста, обновите страницу Twitch (клавиша F5) и запустите сбор снова.', 
                    target: options.maxStreams || 0 
                });
                _isRunning = false;
                return;
            }

            emptyStreak++;
            if (emptyStreak >= 3) break;
            await new Promise(r => setTimeout(r, 600));
            continue;
        }

        const streams = json.data?.game?.streams;
        if (!streams) { emptyStreak++; if (emptyStreak >= 3) break; continue; }

        const edges = streams.edges || [];
        if (edges.length === 0) {
            emptyStreak++;
            if (emptyStreak >= 2) break;
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        emptyStreak = 0;

        for (const edge of edges) {
            if (collected.size >= maxStreams || _shouldStop || _shouldFinish) break;
            const node = edge.node;
            
            // Если трансляция дублируется, просто пропускаем её, но цикл НЕ обрываем!
            if (!node || collected.has(node.id)) continue;

            const s = {};
            if (options.fields.channel)     s.channel     = node.broadcaster?.displayName || node.broadcaster?.login || "";
            if (options.fields.category)    s.category    = node.game?.displayName || node.game?.name || slug;
            if (options.fields.tags)        s.tags        = node.freeformTags?.map(t => t.name) ?? [];
            
            // ИЗМЕНЕНО: теперь зрители - это чистое число, без строк и форматирования
            if (options.fields.viewers)     s.viewers     = node.viewersCount || 0;
            
            if (options.fields.title)       s.title       = node.title || "";
            if (options.fields.url)         s.url         = `https://www.twitch.tv/${node.broadcaster?.login || ""}`;
            if (options.fields.language) {
                s.language = isAll
                    ? (node.freeformTags?.[0]?.name ?? "unknown")
                    : options.langFilter;
            }
            
            // ИЗМЕНЕНО: теперь забираем реальное описание канала из broadcaster.description
            if (options.fields.description) s.description = node.broadcaster?.description || "";

            collected.set(node.id, s);
        }

        setState({ phase: 'running', collected: collected.size, target: options.maxStreams || 0, error: null, tabId, format: options.format });

        const hasNextPage = streams.pageInfo?.hasNextPage;
        
        // ВАЖНО: Мы убрали || newInBatch === 0. Теперь сбор остановится только если Twitch скажет, что страниц больше нет.
        if (!hasNextPage || edges.length === 0) break;

        const nextCursor = edges[edges.length - 1].cursor;
        
        // Защита от бесконечного цикла: если сервер намертво завис и отдает один и тот же курсор
        if (cursor === nextCursor) break; 
        
        cursor = nextCursor;
        await new Promise(r => setTimeout(r, 150));
    }

    _isRunning = false;

    if (_shouldStop) { setIdle(); return; }

    const data = Array.from(collected.values());
    const doneState = { phase: 'done', collected: data.length, target: options.maxStreams || 0, error: null };
    
    chrome.storage.local.set({ 
        scrapingState: doneState, 
        scrapedData: data, 
        scrapeMeta: { format: options.format || 'json', tabId: tabId } 
    }, () => {
        setState(doneState);
    });
}


// ─── Обработчик сообщений ─────────────────────────────────────────────────
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
        if (!_isRunning) setIdle(); // На случай если уже не работает
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'finish_collection') {
        _shouldFinish = true;
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'download_last_data') {
        chrome.storage.local.get(['scrapedData', 'scrapeMeta'], (res) => {
            if (res.scrapedData && res.scrapeMeta) {
                // Если popup прислал новый формат — используем его, иначе берём старый из storage
                const format = message.format || res.scrapeMeta.format;
                downloadData(res.scrapedData, format, res.scrapeMeta.tabId);
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'reset_state') {
        // Очищаем сохранённые данные при сбросе
        chrome.storage.local.remove(['scrapedData', 'scrapeMeta']);
        if (!_isRunning) setIdle();
        sendResponse({ ok: true });
        return true;
    }

    return true;
});
