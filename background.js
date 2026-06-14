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

// ─── Запрос панелей канала ───────────────────────────────────────────────────
async function fetchPanelsForUsers(userIds) {
    if (!userIds || userIds.length === 0) return {};
    const result = {};
    // Twitch не поддерживает батч по panels, поэтому шлём по одному запросу на канал
    // Но оборачиваем в один fetch с массивом operationName
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

// ─── Инжект скачивания в Twitch-вкладку ──────────────────────────────────────
function triggerDownload(data, format, filename, fields) {
    // fields — объект с булевыми флагами (что показывать)
    // Если fields не передан — показываем всё
    const f = fields || {
        channel: true, category: true, tags: true, viewers: true,
        followers: true, title: true, language: true, url: true,
        description: true, panels: true
    };

    let content = '';
    let mimeType = '';

    if (format === 'json') {
        // При JSON фильтруем поля
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
            if (f.panels      && s.panels      !== undefined) out.panels      = s.panels;
            return out;
        });
        content = JSON.stringify(filtered, null, 2);
        mimeType = 'application/json';
    } else {
        content = '# Собранные трансляции Twitch\n\n';
        data.forEach((s, i) => {
            const title = f.title ? (s.title || '—') : `Запись #${i + 1}`;
            content += `## ${i + 1}. ${title}\n\n`;
            if (f.channel   && s.channel)                    content += `- **Канал:** ${s.channel}\n`;
            if (f.category  && s.category)                   content += `- **Категория:** ${s.category}\n`;
            if (f.viewers   && s.viewers     !== undefined)   content += `- **Зрители:** ${s.viewers}\n`;
            if (f.followers && s.followers   !== undefined)   content += `- **Фолловеры:** ${s.followers}\n`;
            if (f.language  && s.language)                   content += `- **Язык:** ${s.language}\n`;
            if (f.tags      && s.tags?.length)               content += `- **Теги:** ${s.tags.join(', ')}\n`;
            if (f.url       && s.url)                        content += `- **Ссылка:** ${s.url}\n`;
            if (f.description && s.description)              content += `- **Описание:** ${s.description}\n`;

            // Панели — красивый Markdown
            if (f.panels && s.panels?.length) {
                content += `\n**Панели канала:**\n\n`;
                s.panels.forEach(p => {
                    // Заголовок панели (если есть) как ссылка или просто текст
                    if (p.title && p.linkURL) {
                        content += `### [${p.title}](${p.linkURL})\n`;
                    } else if (p.title) {
                        content += `### ${p.title}\n`;
                    } else if (p.linkURL) {
                        // Панель без заголовка — только ссылка (обычно картинка-баннер)
                        content += `### [🔗 Ссылка](${p.linkURL})\n`;
                    }

                    // Alt text (если есть)
                    if (p.altText) content += `> ${p.altText}\n`;

                    // Описание панели с сохранением переносов строк
                    if (p.description && p.description.trim()) {
                        const lines = p.description.split('\n');
                        lines.forEach(line => {
                            content += `${line}  \n`;
                        });
                    }
                    content += '\n';
                });
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

function downloadData(data, format, tabId, fields) {
    if (!data || data.length === 0) { setIdle(); return; }
    const filename = `twitch_streams_${Date.now()}.${format}`;
    chrome.scripting.executeScript({
        target: { tabId },
        func: triggerDownload,
        args: [data, format, filename, fields]
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
    const isAll = options.langFilter.includes('all');
    // Если выбрано 'all', передаем полный массив. Иначе - мапим все выбранные языки
    const langFilter = isAll ? TWITCH_ALL_LANGS : options.langFilter.map(l => l.toUpperCase());

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

        // Сначала собираем все узлы из этой страницы
        const batchNodes = [];
        for (const edge of edges) {
            if (collected.size + batchNodes.length >= maxStreams || _shouldStop || _shouldFinish) break;
            const node = edge.node;
            if (!node || collected.has(node.id)) continue;
            batchNodes.push(node);
        }

        // Если нужны панели — запрашиваем пакетом
        let panelsMap = {};
        if (options.fields.panels && batchNodes.length > 0) {
            const userIds = batchNodes.map(n => n.broadcaster?.id).filter(Boolean);
            // Разбиваем на батчи по 20 (Twitch ограничивает)
            const BATCH = 20;
            for (let bi = 0; bi < userIds.length; bi += BATCH) {
                const chunk = userIds.slice(bi, bi + BATCH);
                const chunkMap = await fetchPanelsForUsers(chunk);
                Object.assign(panelsMap, chunkMap);
            }
        }

        for (const node of batchNodes) {
            // Всегда собираем ВСЕ базовые поля — фильтрация будет при скачивании
            const s = {};
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

            // Панели — только если запрашивали
            if (options.fields.panels) {
                s.panels = panelsMap[node.broadcaster?.id] || [];
            }

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
                const format = message.format || res.scrapeMeta.format;
                // fields берём из сообщения popup (текущее состояние чекбоксов)
                const fields = message.fields || null;
                downloadData(res.scrapedData, format, res.scrapeMeta.tabId, fields);
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
