// Клиент TTS: сначала кэш в Object Storage, потом синтез.
//
// Механизм (как в проекте osm):
//   1. URL mp3 вычисляется на клиенте по SHA-256 от
//      "текст\0голос\0pitch\0volume" — одинаковый текст всегда даёт тот же файл.
//   2. Перед синтезом делается HEAD: если файл уже в бакете, он просто
//      скачивается и играет, функция не вызывается.
//   3. Яндекс-функция синтезирует только отсутствующие фразы, кладёт mp3 в
//      бакет и возвращает готовые URL (без base64 через тело ответа).
//   4. preload() прогревает кэш пачками и скачивает аудио в blob-URL, чтобы
//      проигрывание не ждало сеть.
//
// Зависит от assets/js/config.js (API_CONFIG.TTS_FUNCTION_URL / TTS_BUCKET_URL).
(function () {
    if (window.NavigatorTTS) return;

    const API_URL = API_CONFIG.TTS_FUNCTION_URL;
    const BUCKET_URL = String(API_CONFIG.TTS_BUCKET_URL || '').replace(/\/+$/, '');
    const VOLUME = '+30%';
    const MAX_SYNTH_ITEMS = 100; // ограничение Яндекс-функции на один запрос
    const PARALLEL = 3;          // одновременных HEAD/скачиваний
    const VOICES = {
        command: { voice: 'ru-RU-DmitryNeural', pitch: '-10Hz' },
        comment: { voice: 'ru-RU-SvetlanaNeural', pitch: '+0Hz' }
    };

    // URL по тексту (после синтеза) и blob-URL по этому URL.
    const urls = new Map();
    const blobUrls = new Map();
    // Незавершённые запросы, чтобы не синтезировать одну фразу дважды.
    const pending = new Map();
    // Уже скачанные в память файлы.
    const downloaded = new Set();

    function normalizeType(voiceType) {
        return VOICES[voiceType] ? voiceType : 'command';
    }

    // Ключ кэша включает тип голоса: одинаковый текст командой и комментарием —
    // это два разных файла.
    function cacheKey(text, voiceType) {
        return normalizeType(voiceType) + '\0' + String(text || '').trim();
    }

    // Детерминированный URL объекта в бакете. Формат должен совпадать с
    // backend/tts_function.py::_object_key.
    async function objectUrl(text, voiceType) {
        const type = normalizeType(voiceType);
        const settings = VOICES[type];
        const input = String(text || '').trim() + '\0' + settings.voice + '\0' + settings.pitch + '\0' + VOLUME;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return BUCKET_URL + '/v1/' + hash + '.mp3';
    }

    async function existsInBucket(url) {
        const response = await fetch(url, { method: 'HEAD', mode: 'cors' });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error('Audio bucket returned HTTP ' + response.status);
        return true;
    }

    // Синтез: функция возвращает массив {voice_type, text, url}.
    async function synthesize(batches) {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batches: batches })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result.audios)) {
            throw new Error(result.error || 'TTS function returned HTTP ' + response.status);
        }
        result.audios.forEach(audio => {
            if (audio && audio.text && audio.url) {
                urls.set(cacheKey(audio.text, audio.voice_type), audio.url);
            }
        });
    }

    // URL для проигрывания: кэш → бакет → синтез.
    async function resolve(text, voiceType) {
        const cleanText = String(text || '').trim();
        if (!cleanText) return null;
        const type = normalizeType(voiceType);
        const key = cacheKey(cleanText, type);

        if (urls.has(key)) {
            const remoteUrl = urls.get(key);
            return blobUrls.get(remoteUrl) || remoteUrl;
        }
        if (pending.has(key)) return pending.get(key);

        const task = (async () => {
            const url = await objectUrl(cleanText, type);
            if (await existsInBucket(url)) {
                urls.set(key, url);
                return url;
            }
            await synthesize([{ voice_type: type, texts: [cleanText] }]);
            const generated = urls.get(key);
            if (!generated) throw new Error('TTS function did not return the generated audio URL');
            return generated;
        })();
        pending.set(key, task);
        try {
            return await task;
        } finally {
            pending.delete(key);
        }
    }

    // Сколько уникальных фраз реально нужно (дедупликация по тип+текст).
    function collect(items) {
        const seen = new Set();
        const result = [];
        (items || []).forEach(item => {
            const type = normalizeType(item.voice_type);
            (item.texts || []).forEach(value => {
                const text = String(value || '').trim();
                if (!text) return;
                const key = cacheKey(text, type);
                if (seen.has(key)) return;
                seen.add(key);
                result.push({ type: type, text: text });
            });
        });
        return result;
    }

    // Прогрев маршрута: HEAD по всем фразам, синтез отсутствующих, скачивание
    // готовых файлов в blob-URL. Ошибки отдельных файлов не роняют весь прогрев:
    // у фразы остаётся удалённый URL, и она всё равно сможет проиграться.
    async function preload(batches) {
        const items = collect(batches);
        const missing = [];

        for (let i = 0; i < items.length; i += PARALLEL) {
            await Promise.all(items.slice(i, i + PARALLEL).map(async item => {
                const key = cacheKey(item.text, item.type);
                if (urls.has(key)) return;
                if (pending.has(key)) await pending.get(key).catch(() => {});
                if (urls.has(key)) return;
                try {
                    const url = await objectUrl(item.text, item.type);
                    if (await existsInBucket(url)) urls.set(key, url);
                    else missing.push(item);
                } catch (e) {
                    console.warn('[tts] не удалось проверить аудио:', item.text, e);
                    missing.push(item);
                }
            }));
        }

        // Функция принимает не больше MAX_SYNTH_ITEMS фраз за вызов.
        for (let i = 0; i < missing.length; i += MAX_SYNTH_ITEMS) {
            const part = missing.slice(i, i + MAX_SYNTH_ITEMS);
            const request = Object.keys(VOICES)
                .map(type => ({
                    voice_type: type,
                    texts: part.filter(item => item.type === type).map(item => item.text)
                }))
                .filter(batch => batch.texts.length);
            if (!request.length) continue;
            try {
                await synthesize(request);
            } catch (e) {
                console.warn('[tts] синтез не удался:', e);
            }
        }

        // Скачиваем в память. Уже готовые URL остаются доступны и без этого.
        const tasks = items.map(item => urls.get(cacheKey(item.text, item.type))).filter(Boolean);
        const unique = tasks.filter((url, index, all) => all.indexOf(url) === index && !downloaded.has(url));
        for (let i = 0; i < unique.length; i += PARALLEL) {
            await Promise.all(unique.slice(i, i + PARALLEL).map(async url => {
                try {
                    const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    const audio = await response.arrayBuffer();
                    if (!audio.byteLength) throw new Error('пустой файл');
                    downloaded.add(url);
                    const blob = new Blob([audio], { type: 'audio/mpeg' });
                    blobUrls.set(url, URL.createObjectURL(blob));
                } catch (e) {
                    console.warn('[tts] не удалось скачать аудио:', url, e);
                }
            }));
        }
    }

    window.NavigatorTTS = {
        getAudioUrl: resolve,
        preload: preload,
        has: (text, type) => urls.has(cacheKey(text, type || 'command'))
    };
})();
