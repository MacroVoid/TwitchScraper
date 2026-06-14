// =============================================
// Background Service Worker
// Делает ВСЕ GQL-запросы сам (обходит CORS).
// Content.js нужен только для инжекта скачивания.
// =============================================

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
let _shouldStop = false;
let _shouldFinish = false;
let _isRunning = false;
let _shouldStopEnrich = false;
let _isEnriching = false;

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

// ─── Запрос соц. сетей канала ─────────────────────────────────────────────
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
    // Батчами по 30 логинов за один fetch
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

// ─── Инжект скачивания в Twitch-вкладку ──────────────────────────────────────
function triggerDownload(data, format, filename, fields) {
    // fields — объект с булевыми флагами (что показывать)
    // Если fields не передан — показываем всё
    const f = fields || {
        channel: true, category: true, tags: true, viewers: true,
        followers: true, title: true, language: true, url: true,
        description: true, social: true, panels: true
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
            if (f.social      && s.social      && s.social.length > 0) out.social      = s.social;
            if (f.panels      && s.panels      && s.panels.length > 0) out.panels      = s.panels;
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

            // Соц. сети
            if (f.social && s.social?.length) {
                content += `\n**Соц. сети:**\n\n`;
                s.social.forEach(sm => {
                    const label = sm.title || sm.name || sm.url;
                    content += `- [${label}](${sm.url})  \n`;
                });
                content += '\n';
            }

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
            const BATCH = 20;
            for (let bi = 0; bi < userIds.length; bi += BATCH) {
                const chunk = userIds.slice(bi, bi + BATCH);
                const chunkMap = await fetchPanelsForUsers(chunk);
                Object.assign(panelsMap, chunkMap);
            }
        }

        // Если нужны соц. сети — запрашиваем пакетом по логинам
        let socialMap = {};
        if (options.fields.social && batchNodes.length > 0) {
            const logins = batchNodes.map(n => n.broadcaster?.login).filter(Boolean);
            socialMap = await fetchSocialMediasBatch(logins);
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

            // Служебные поля для последующего обогащения (не попадут в экспорт)
            s._login  = node.broadcaster?.login  || "";
            s._userId = node.broadcaster?.id     || "";

            // Панели — только если запрашивали
            if (options.fields.panels) {
                s.panels = panelsMap[node.broadcaster?.id] || [];
            }

            // Соц. сети — только если запрашивали
            if (options.fields.social) {
                s.social = socialMap[node.broadcaster?.login] || [];
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

// ─── Обогащение уже собранных данных с прогрессом ────────────────────────
async function enrichData(data, fields) {
    if (!data || !fields) return data;
    _isEnriching = true;
    _shouldStopEnrich = false;
    const totalStreams = data.length;

    // Функция прерывания: сохраняем что есть и переводим в состояние паузы
    function stopAndRestore(step, done, total) {
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

    // Соц. сети
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

    // Панели
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

    _isEnriching = false;
    return data;
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
                    // Начинаем обогащение, но сам файл не скачиваем автоматически
                    const enriched = await enrichData(data, fields);
                    if (enriched !== null) {
                        // Обогащение завершилось до конца: сохраняем и показываем кнопку "Скачать файл"
                        const doneState = { phase: 'done', collected: data.length, target: 0, error: null };
                        chrome.storage.local.set({ scrapingState: doneState, scrapedData: enriched });
                        setState(doneState);
                    }
                } else {
                    // Обогащение не требуется (уже пройдено или отменено) — скачиваем файл сразу
                    downloadData(data, format, res.scrapeMeta.tabId, fields);
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

                // Заполняем необработанные поля null, чтобы они не обогащались и не попадали в файл
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

        // Восстанавливаем заголовки по умолчанию
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

    if (message.action === 'reset_state') {
        // Очищаем сохранённые данные при сбросе
        chrome.storage.local.remove(['scrapedData', 'scrapeMeta']);
        if (!_isRunning) setIdle();
        sendResponse({ ok: true });
        return true;
    }

    return true;
});
