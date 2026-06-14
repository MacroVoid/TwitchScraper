// =============================================
// popup.js — интерфейс, прогресс-бар, связь с background
// =============================================

const TWITCH_LANGUAGES = [
    { code: "all",   name: "🌐 Все языки" },
    { code: "RU",    name: "Русский (RU)" },
    { code: "EN",    name: "English (EN)" },
    { code: "ES",    name: "Español (ES)" },
    { code: "DE",    name: "Deutsch (DE)" },
    { code: "FR",    name: "Français (FR)" },
    { code: "PT",    name: "Português (PT)" },
    { code: "ZH",    name: "中文 (ZH)" },
    { code: "JA",    name: "日本語 (JA)" },
    { code: "KO",    name: "한국어 (KO)" },
    { code: "IT",    name: "Italiano (IT)" },
    { code: "PL",    name: "Polski (PL)" },
    { code: "TR",    name: "Türkçe (TR)" },
    { code: "NL",    name: "Nederlands (NL)" },
    { code: "SV",    name: "Svenska (SV)" },
    { code: "DA",    name: "Dansk (DA)" },
    { code: "FI",    name: "Suomi (FI)" },
    { code: "NO",    name: "Norsk (NO)" },
    { code: "RO",    name: "Română (RO)" },
    { code: "HU",    name: "Magyar (HU)" },
    { code: "CS",    name: "Čeština (CS)" },
    { code: "EL",    name: "Ελληνικά (EL)" },
    { code: "BG",    name: "Български (BG)" },
    { code: "UK",    name: "Українська (UK)" },
    { code: "AR",    name: "العربية (AR)" },
    { code: "HI",    name: "हिन्दी (HI)" },
    { code: "TH",    name: "ภาษาไทย (TH)" },
    { code: "VI",    name: "Tiếng Việt (VI)" },
    { code: "ID",    name: "Bahasa Indonesia (ID)" },
    { code: "MS",    name: "Bahasa Melayu (MS)" },
    { code: "CA",    name: "Català (CA)" },
    { code: "SK",    name: "Slovenčina (SK)" },
    { code: "TL",    name: "Tagalog (TL)" },
    { code: "ASL",   name: "American Sign Language (ASL)" },
    { code: "OTHER", name: "Другой (OTHER)" }
];

// ─── Элементы UI ───────────────────────────────────────────────────────────
const collectBtn      = document.getElementById('collect_btn');
const stopBtn         = document.getElementById('stop_btn');
const finishBtn       = document.getElementById('finish_btn');
const actionButtons   = document.getElementById('action-buttons');
const progressSection = document.getElementById('progress-section');
const progressLabel   = document.getElementById('progress-label');
const progressCount   = document.getElementById('progress-count');
const progressBar     = document.getElementById('progress-bar');
const progressSub     = document.getElementById('progress-sub');
const statusPill      = document.getElementById('status-pill');
const langSelect      = document.getElementById('lang_filter');
const doneButtons     = document.getElementById('done-buttons');
const downloadBtn     = document.getElementById('download_btn');
const resetBtn        = document.getElementById('reset_btn');

// Заполняем список языков
TWITCH_LANGUAGES.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name;
    langSelect.appendChild(opt);
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
        doneButtons.style.display = 'none'; // Скрываем новые кнопки
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

    } else if (phase === 'done') {
        showProgress(true);
        showActionButtons(false);
        doneButtons.style.display = 'flex'; // Показываем новые кнопки
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
        doneButtons.style.display = 'none'; // Скрываем новые кнопки
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
    doneButtons.style.display = 'none'; // Добавить эту строку
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

    const options = {
        fields: {
            channel:      document.getElementById('cb_channel').checked,
            category:     document.getElementById('cb_category').checked,
            tags:         document.getElementById('cb_tags').checked,
            viewers:      document.getElementById('cb_viewers').checked,
            title:        document.getElementById('cb_title').checked,
            language:     document.getElementById('cb_language').checked,
            url:          document.getElementById('cb_url').checked,
            description:  document.getElementById('cb_desc').checked
        },
        langFilter:  langSelect.value,
        subOnly:     document.getElementById('cb_subonly').checked, // <-- НОВАЯ СТРОКА
        maxStreams:  parseInt(document.getElementById('max_streams').value) || 0,
        format:      document.querySelector('input[name="format"]:checked').value
    };

    // Сбрасываем кнопки управления перед стартом
    stopBtn.disabled = false;
    finishBtn.disabled = false;
    finishBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Скачать сейчас`;

    // Применяем начальное состояние
    applyState({ phase: 'running', collected: 0, target: options.maxStreams, error: null });

    chrome.runtime.sendMessage({ action: 'start_collection', tabId: tab.id, options });
});

// ─── Кнопки ФИНАЛА (Скачать и Сбросить) ───────────────────────────────────
downloadBtn.addEventListener('click', () => {
    // Берём формат, который выбран прямо сейчас (после завершения сбора)
    const currentFormat = document.querySelector('input[name="format"]:checked').value;
    chrome.runtime.sendMessage({ action: 'download_last_data', format: currentFormat });
});

resetBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'reset_state' });
});

