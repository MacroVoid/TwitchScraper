// =============================================
// popup.js — интерфейс, прогресс-бар, связь с background
// =============================================

const TWITCH_LANGUAGES = [
    { code: "all", name: "🌐 Все языки" },
    { code: "RU", name: "Русский (RU)" },
    { code: "EN", name: "English (EN)" },
    { code: "ES", name: "Español (ES)" },
    { code: "DE", name: "Deutsch (DE)" },
    { code: "FR", name: "Français (FR)" },
    { code: "PT", name: "Português (PT)" },
    { code: "ZH", name: "中文 (ZH)" },
    { code: "JA", name: "日本語 (JA)" },
    { code: "KO", name: "한국어 (KO)" },
    { code: "IT", name: "Italiano (IT)" },
    { code: "PL", name: "Polski (PL)" },
    { code: "TR", name: "Türkçe (TR)" },
    { code: "NL", name: "Nederlands (NL)" },
    { code: "SV", name: "Svenska (SV)" },
    { code: "DA", name: "Dansk (DA)" },
    { code: "FI", name: "Suomi (FI)" },
    { code: "NO", name: "Norsk (NO)" },
    { code: "RO", name: "Română (RO)" },
    { code: "HU", name: "Magyar (HU)" },
    { code: "CS", name: "Čeština (CS)" },
    { code: "EL", name: "Ελληνικά (EL)" },
    { code: "BG", name: "Български (BG)" },
    { code: "UK", name: "Українська (UK)" },
    { code: "AR", name: "العربية (AR)" },
    { code: "HI", name: "हिन्दी (HI)" },
    { code: "TH", name: "ภาษาไทย (TH)" },
    { code: "VI", name: "Tiếng Việt (VI)" },
    { code: "ID", name: "Bahasa Indonesia (ID)" },
    { code: "MS", name: "Bahasa Melayu (MS)" },
    { code: "CA", name: "Català (CA)" },
    { code: "SK", name: "Slovenčina (SK)" },
    { code: "TL", name: "Tagalog (TL)" },
    { code: "ASL", name: "American Sign Language (ASL)" },
    { code: "OTHER", name: "Другой (OTHER)" }
];

// ─── Элементы UI ───────────────────────────────────────────────────────────
const collectBtn = document.getElementById('collect_btn');
const stopBtn = document.getElementById('stop_btn');
const finishBtn = document.getElementById('finish_btn');
const actionButtons = document.getElementById('action-buttons');
const progressSection = document.getElementById('progress-section');
const progressLabel = document.getElementById('progress-label');
const progressCount = document.getElementById('progress-count');
const progressBar = document.getElementById('progress-bar');
const progressSub = document.getElementById('progress-sub');
const statusPill = document.getElementById('status-pill');
const langList = document.getElementById('lang_list');
const doneButtons = document.getElementById('done-buttons');
const downloadBtn = document.getElementById('download_btn');
const resetBtn = document.getElementById('reset_btn');
const enrichRunningButtons = document.getElementById('enrich-running-buttons');
const stopEnrichBtn = document.getElementById('stop_enrich_btn');
const enrichPausedButtons = document.getElementById('enrich-paused-buttons');
const continueEnrichBtn = document.getElementById('continue_enrich_btn');
const cancelEnrichBtn = document.getElementById('cancel_enrich_btn');
const defaultSettingsBtn = document.getElementById('default_settings_btn');
const fullResetBtn = document.getElementById('full_reset_btn');
const downloadLogsBtn = document.getElementById('download_logs_btn');
const debugToggleBtn = document.getElementById('debug_toggle_btn');
const mainView = document.getElementById('main-view');
const debugView = document.getElementById('debug-view');
const cbDisableLogging = document.getElementById('cb_disable_logging');
const clearLogsBtn = document.getElementById('clear_logs_btn');
const debugBackBtn = document.getElementById('debug_back_btn');

// Заполняем список языков удобными чекбоксами
TWITCH_LANGUAGES.forEach(lang => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = lang.code;
    cb.name = 'lang_checkbox';

    cb.addEventListener('change', (e) => {
        if (e.target.value === 'all' && e.target.checked) {
            document.querySelectorAll('input[name="lang_checkbox"]').forEach(c => {
                if (c.value !== 'all') c.checked = false;
            });
        } else if (e.target.value !== 'all' && e.target.checked) {
            const allCb = document.querySelector('input[name="lang_checkbox"][value="all"]');
            if (allCb) allCb.checked = false;
        }
        saveUISettings();
    });

    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + lang.name));
    langList.appendChild(label);
});

// ─── Сохранение и загрузка настроек UI ────────────────────────────────────
function saveUISettings() {
    const settings = {
        cb_channel: document.getElementById('cb_channel').checked,
        cb_category: document.getElementById('cb_category').checked,
        cb_tags: document.getElementById('cb_tags').checked,
        cb_viewers: document.getElementById('cb_viewers').checked,
        cb_followers: document.getElementById('cb_followers').checked,
        cb_title: document.getElementById('cb_title').checked,
        cb_language: document.getElementById('cb_language').checked,
        cb_url: document.getElementById('cb_url').checked,
        cb_desc: document.getElementById('cb_desc').checked,
        cb_social: document.getElementById('cb_social').checked,
        cb_panels: document.getElementById('cb_panels').checked,
        cb_subonly: document.getElementById('cb_subonly').checked,
        max_streams: document.getElementById('max_streams').value,
        format: document.querySelector('input[name="format"]:checked').value,
        sort_dir: document.querySelector('input[name="sort_dir"]:checked').value,
        lang_filter: Array.from(document.querySelectorAll('input[name="lang_checkbox"]:checked')).map(cb => cb.value)
    };
    chrome.storage.local.set({ uiSettings: settings });
}

function loadUISettings() {
    chrome.storage.local.get('uiSettings', (res) => {
        if (res.uiSettings) {
            const s = res.uiSettings;
            if (s.cb_channel !== undefined) document.getElementById('cb_channel').checked = s.cb_channel;
            if (s.cb_category !== undefined) document.getElementById('cb_category').checked = s.cb_category;
            if (s.cb_tags !== undefined) document.getElementById('cb_tags').checked = s.cb_tags;
            if (s.cb_viewers !== undefined) document.getElementById('cb_viewers').checked = s.cb_viewers;
            if (s.cb_followers !== undefined) document.getElementById('cb_followers').checked = s.cb_followers;
            if (s.cb_title !== undefined) document.getElementById('cb_title').checked = s.cb_title;
            if (s.cb_language !== undefined) document.getElementById('cb_language').checked = s.cb_language;
            if (s.cb_url !== undefined) document.getElementById('cb_url').checked = s.cb_url;
            if (s.cb_desc !== undefined) document.getElementById('cb_desc').checked = s.cb_desc;
            if (s.cb_social !== undefined) document.getElementById('cb_social').checked = s.cb_social;
            if (s.cb_panels !== undefined) document.getElementById('cb_panels').checked = s.cb_panels;
            if (s.cb_subonly !== undefined) document.getElementById('cb_subonly').checked = s.cb_subonly;
            if (s.max_streams !== undefined) document.getElementById('max_streams').value = s.max_streams;

            if (s.format !== undefined) {
                const rb = document.querySelector(`input[name="format"][value="${s.format}"]`);
                if (rb) rb.checked = true;
            }
            if (s.sort_dir !== undefined) {
                const rb = document.querySelector(`input[name="sort_dir"][value="${s.sort_dir}"]`);
                if (rb) rb.checked = true;
            }
            if (s.lang_filter && s.lang_filter.length > 0) {
                document.querySelectorAll('input[name="lang_checkbox"]').forEach(cb => {
                    cb.checked = s.lang_filter.includes(cb.value);
                });
            } else {
                const allCb = document.querySelector('input[name="lang_checkbox"][value="all"]');
                if (allCb) allCb.checked = true;
            }
        } else {
            const allCb = document.querySelector('input[name="lang_checkbox"][value="all"]');
            if (allCb) allCb.checked = true;
        }
    });
    chrome.storage.local.get('isLoggingDisabled', (res) => {
        if (res.isLoggingDisabled !== undefined) {
            cbDisableLogging.checked = res.isLoggingDisabled;
        } else {
            cbDisableLogging.checked = false;
        }
    });
}

loadUISettings();

document.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', saveUISettings);
});

// ─── Восстановление состояния при открытии popup ───────────────────────────
chrome.storage.local.get('scrapingState', ({ scrapingState }) => {
    if (scrapingState) applyState(scrapingState);
});

// Слушаем live-обновления от background
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'state_update') {
        applyState(message.state);
    }
});

// ─── Применяем состояние к UI ──────────────────────────────────────────────
function applyState(state) {
    const { phase, collected, target, error } = state;

    if (phase === 'running') {
        showProgress(true);
        showActionButtons(true);
        doneButtons.style.display = 'none';
        enrichRunningButtons.style.display = 'none';
        enrichPausedButtons.style.display = 'none';
        collectBtn.style.display = 'none';
        progressLabel.textContent = 'Идёт сбор...';
        progressCount.textContent = (collected || 0).toLocaleString('ru-RU');

        const hasTarget = target > 0;
        if (hasTarget) {
            const pct = Math.min(100, Math.round((collected || 0) / target * 100));
            progressBar.classList.remove('indeterminate', 'done');
            progressBar.style.width = pct + '%';
            progressSub.textContent = `${pct}% — ${(collected || 0).toLocaleString('ru-RU')} из ${target.toLocaleString('ru-RU')} стримов`;
        } else {
            progressBar.classList.add('indeterminate');
            progressBar.classList.remove('done');
            progressBar.style.width = '100%';
            progressSub.textContent = `Собрано ${(collected || 0).toLocaleString('ru-RU')} стримов...`;
        }
        showPill('running', '⏳ Идёт сбор');

    } else if (phase === 'enriching') {
        // Фаза обогащения: соц. сети / панели
        showProgress(true);
        showActionButtons(false);
        doneButtons.style.display = 'none';
        enrichRunningButtons.style.display = 'block';
        enrichPausedButtons.style.display = 'none';
        collectBtn.style.display = 'none';
        stopEnrichBtn.disabled = false;
        stopEnrichBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Стоп`;

        const stepLabel = state.enrichStep === 'social' ? 'Соц. сети' : 'Панели';
        const done = state.enrichDone || 0;
        const total = state.enrichTotal || 0;

        progressLabel.textContent = `Сбор: ${stepLabel}...`;
        progressCount.textContent = `${done.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}`;

        if (total > 0) {
            const pct = Math.min(100, Math.round(done / total * 100));
            progressBar.classList.remove('indeterminate', 'done');
            progressBar.style.width = pct + '%';
            progressSub.textContent = `${pct}% — ${done.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')} каналов`;
        } else {
            progressBar.classList.add('indeterminate');
            progressBar.classList.remove('done');
            progressBar.style.width = '100%';
            progressSub.textContent = 'Подготовка...';
        }
        showPill('running', `⏳ ${stepLabel}`);

    } else if (phase === 'enrich_paused') {
        // Фаза обогащения приостановлена
        showProgress(true);
        showActionButtons(false);
        doneButtons.style.display = 'none';
        enrichRunningButtons.style.display = 'none';
        enrichPausedButtons.style.display = 'flex';
        collectBtn.style.display = 'none';
        continueEnrichBtn.disabled = false;
        cancelEnrichBtn.disabled = false;

        const stepLabel = state.enrichStep === 'social' ? 'Соц. сети' : 'Панели';
        const done = state.enrichDone || 0;
        const total = state.enrichTotal || 0;

        progressLabel.textContent = `Сбор: ${stepLabel} (Приостановлен)`;
        progressCount.textContent = `${done.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}`;

        if (total > 0) {
            const pct = Math.min(100, Math.round(done / total * 100));
            progressBar.classList.remove('indeterminate', 'done');
            progressBar.style.width = pct + '%';
            progressSub.textContent = `${pct}% — ${done.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')} каналов`;
        } else {
            progressBar.classList.add('indeterminate');
            progressBar.classList.remove('done');
            progressBar.style.width = '100%';
            progressSub.textContent = 'Приостановлено';
        }
        showPill('warning', `⏸ Приостановлено`);

    } else if (phase === 'done') {
        showProgress(true);
        showActionButtons(false);
        doneButtons.style.display = 'flex';
        enrichRunningButtons.style.display = 'none';
        enrichPausedButtons.style.display = 'none';
        collectBtn.style.display = 'none';
        progressLabel.textContent = 'Сбор завершён!';
        progressCount.textContent = (collected || 0).toLocaleString('ru-RU');
        progressBar.classList.remove('indeterminate');
        progressBar.classList.add('done');
        progressBar.style.width = '100%';
        progressSub.textContent = `✅ Скачано ${(collected || 0).toLocaleString('ru-RU')} стримов`;
        showPill('done', `✓ ${(collected || 0).toLocaleString('ru-RU')} стримов сохранено`);

    } else if (phase === 'error') {
        showProgress(false);
        showActionButtons(false);
        doneButtons.style.display = 'none';
        enrichRunningButtons.style.display = 'none';
        enrichPausedButtons.style.display = 'none';
        collectBtn.style.display = 'flex';
        showPill('error', '✗ ' + (error || 'Ошибка'));

    } else {
        // idle — полный сброс
        resetToIdle();
    }
}

function showProgress(show) {
    progressSection.classList.toggle('visible', show);
}

function showActionButtons(show) {
    actionButtons.classList.toggle('visible', show);
}

function showPill(type, text) {
    statusPill.style.display = 'inline-flex';
    statusPill.className = `status-pill ${type}`;
    statusPill.innerHTML = type === 'running'
        ? `<div class="dot-pulse"></div> ${text}`
        : text;
}

function resetToIdle() {
    showProgress(false);
    showActionButtons(false);
    doneButtons.style.display = 'none';
    enrichRunningButtons.style.display = 'none';
    enrichPausedButtons.style.display = 'none';
    collectBtn.style.display = 'flex';
    collectBtn.disabled = false;
    collectBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Собрать и скачать`;
    statusPill.style.display = 'none';
}

// ─── Кнопка СТОП ──────────────────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
    // Блокируем кнопки сразу
    stopBtn.disabled = true;
    finishBtn.disabled = true;
    showPill('error', 'Останавливаем...');
    chrome.runtime.sendMessage({ action: 'stop_collection' }, () => {
        // background вернёт state_update с phase:'idle'
    });
});

// ─── Кнопка СКАЧАТЬ СЕЙЧАС ────────────────────────────────────────────────
finishBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    finishBtn.disabled = true;
    finishBtn.textContent = 'Завершаем...';
    showPill('running', '⬇️ Подготовка файла...');
    chrome.runtime.sendMessage({ action: 'finish_collection' }, () => {
        // background передаст в content.js → content.js пришлёт collection_done
    });
});

// ─── Кнопка ЗАПУСКА ───────────────────────────────────────────────────────
collectBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url?.includes('twitch.tv/directory/category/')) {
        showPill('error', '✗ Откройте страницу категории Twitch');
        setTimeout(() => { statusPill.style.display = 'none'; }, 3000);
        return;
    }

    const selectedLangs = Array.from(document.querySelectorAll('input[name="lang_checkbox"]:checked')).map(cb => cb.value);

    const options = {
        fields: {
            channel: document.getElementById('cb_channel').checked,
            category: document.getElementById('cb_category').checked,
            tags: document.getElementById('cb_tags').checked,
            viewers: document.getElementById('cb_viewers').checked,
            followers: document.getElementById('cb_followers').checked,
            title: document.getElementById('cb_title').checked,
            language: document.getElementById('cb_language').checked,
            url: document.getElementById('cb_url').checked,
            description: document.getElementById('cb_desc').checked,
            social: document.getElementById('cb_social').checked,
            panels: document.getElementById('cb_panels').checked
        },
        langFilter: selectedLangs.length > 0 ? selectedLangs : ['all'],
        subOnly: document.getElementById('cb_subonly').checked,
        maxStreams: parseInt(document.getElementById('max_streams').value) || 0,
        format: document.querySelector('input[name="format"]:checked').value,
        sortDir: document.querySelector('input[name="sort_dir"]:checked').value
    };

    // Сбрасываем кнопки управления перед стартом
    stopBtn.disabled = false;
    finishBtn.disabled = false;
    finishBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Скачать сейчас`;

    // Применяем начальное состояние
    applyState({ phase: 'running', collected: 0, target: options.maxStreams, error: null });

    chrome.runtime.sendMessage({ action: 'start_collection', tabId: tab.id, options });
});

// ─── Кнопка СТОП ОБОГАЩЕНИЯ ─────────────────────────────────
stopEnrichBtn.addEventListener('click', () => {
    stopEnrichBtn.disabled = true;
    stopEnrichBtn.innerHTML = 'Приостановка...';
    showPill('running', '⏸ Приостанавливаем...');
    chrome.runtime.sendMessage({ action: 'stop_enrich' });
});

// ─── Кнопка ПРОДОЛЖИТЬ ОБОГАЩЕНИЕ ───────────────────────────
continueEnrichBtn.addEventListener('click', () => {
    continueEnrichBtn.disabled = true;
    showPill('running', '⏳ Продолжаем сбор...');
    chrome.runtime.sendMessage({ action: 'resume_enrich' });
});

// ─── Кнопка ОТМЕНИТЬ ОБОГАЩЕНИЕ ─────────────────────────────
cancelEnrichBtn.addEventListener('click', () => {
    cancelEnrichBtn.disabled = true;
    showPill('running', '💾 Завершаем без доп. данных...');
    chrome.runtime.sendMessage({ action: 'cancel_enrich' });
});

// ─── Кнопки ФИНАЛА (Скачать и Сбросить) ───────────────────────────────────
downloadBtn.addEventListener('click', () => {
    const currentFormat = document.querySelector('input[name="format"]:checked').value;
    const currentSort = document.querySelector('input[name="sort_dir"]:checked').value;
    // Собираем текущее состояние чекбоксов для фильтрации полей при скачивании
    const currentFields = {
        title: document.getElementById('cb_title').checked,
        channel: document.getElementById('cb_channel').checked,
        category: document.getElementById('cb_category').checked,
        viewers: document.getElementById('cb_viewers').checked,
        followers: document.getElementById('cb_followers').checked,
        language: document.getElementById('cb_language').checked,
        tags: document.getElementById('cb_tags').checked,
        url: document.getElementById('cb_url').checked,
        description: document.getElementById('cb_desc').checked,
        social: document.getElementById('cb_social').checked,
        panels: document.getElementById('cb_panels').checked
    };
    chrome.runtime.sendMessage({ action: 'download_last_data', format: currentFormat, fields: currentFields, sortDir: currentSort });
});

resetBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'reset_state' });
});

// ─── Кнопка СБРОСА НАСТРОЕК ПО УМОЛЧАНИЮ ──────────────────────────────────
defaultSettingsBtn.addEventListener('click', () => {
    document.getElementById('cb_channel').checked = true;
    document.getElementById('cb_category').checked = true;
    document.getElementById('cb_tags').checked = true;
    document.getElementById('cb_viewers').checked = true;
    document.getElementById('cb_followers').checked = true;
    document.getElementById('cb_title').checked = true;
    document.getElementById('cb_language').checked = true;
    document.getElementById('cb_url').checked = true;
    document.getElementById('cb_desc').checked = true;
    document.getElementById('cb_social').checked = true;
    document.getElementById('cb_panels').checked = false; // медленный запрос
    document.getElementById('cb_subonly').checked = false;

    document.querySelectorAll('input[name="lang_checkbox"]').forEach(cb => {
        cb.checked = (cb.value === 'all');
    });

    document.getElementById('max_streams').value = "0";
    const jsonRadio = document.querySelector('input[name="format"][value="json"]');
    if (jsonRadio) jsonRadio.checked = true;
    const descRadio = document.querySelector('input[name="sort_dir"][value="desc"]');
    if (descRadio) descRadio.checked = true;

    saveUISettings();
});

fullResetBtn.addEventListener('click', () => {
    if (confirm('Вы уверены, что хотите полностью сбросить расширение? Это очистит кэш, настройки и текущий прогресс.')) {
        chrome.runtime.sendMessage({ action: 'full_reset' }, () => {
            resetToIdle();
            document.getElementById('cb_channel').checked = true;
            document.getElementById('cb_category').checked = true;
            document.getElementById('cb_tags').checked = true;
            document.getElementById('cb_viewers').checked = true;
            document.getElementById('cb_followers').checked = true;
            document.getElementById('cb_title').checked = true;
            document.getElementById('cb_language').checked = true;
            document.getElementById('cb_url').checked = true;
            document.getElementById('cb_desc').checked = true;
            document.getElementById('cb_social').checked = true;
            document.getElementById('cb_panels').checked = false;
            document.getElementById('cb_subonly').checked = false;

            document.querySelectorAll('input[name="lang_checkbox"]').forEach(cb => {
                cb.checked = (cb.value === 'all');
            });

            document.getElementById('max_streams').value = "0";
            const jsonRadio = document.querySelector('input[name="format"][value="json"]');
            if (jsonRadio) jsonRadio.checked = true;
            const descRadio = document.querySelector('input[name="sort_dir"][value="desc"]');
            if (descRadio) descRadio.checked = true;

            saveUISettings();
            showPill('done', '✓ Сброшено');
            setTimeout(() => { statusPill.style.display = 'none'; }, 3000);
        });
    }
});

downloadLogsBtn.addEventListener('click', () => {
    chrome.storage.local.get('debugLogs', (res) => {
        const logs = res.debugLogs || [];
        if (logs.length === 0) {
            alert('Логи пока пусты.');
            return;
        }
        const text = logs.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `twitch_scraper_debug_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
});

// ─── Обработчики панели отладки ──────────────────────────────────────────
debugToggleBtn.addEventListener('click', () => {
    const isShowingDebug = debugView.style.display === 'block';
    if (isShowingDebug) {
        debugView.style.display = 'none';
        mainView.style.display = 'block';
        debugToggleBtn.classList.remove('active');
    } else {
        mainView.style.display = 'none';
        debugView.style.display = 'block';
        debugToggleBtn.classList.add('active');
    }
});

debugBackBtn.addEventListener('click', () => {
    debugView.style.display = 'none';
    mainView.style.display = 'block';
    debugToggleBtn.classList.remove('active');
});

cbDisableLogging.addEventListener('change', () => {
    chrome.storage.local.set({ isLoggingDisabled: cbDisableLogging.checked });
});

clearLogsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clear_logs' }, (res) => {
        if (res && res.ok) {
            showPill('done', '✓ Логи очищены');
            setTimeout(() => { statusPill.style.display = 'none'; }, 2000);
        }
    });
});

