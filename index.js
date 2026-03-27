export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isApiRoute(url.pathname)) {
      return handleApiRequest(request, env, url);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Static assets binding is not configured.', { status: 500 });
  },
};

function isApiRoute(pathname) {
  return pathname === '/raw' || pathname === '/srt' || pathname === '/vtt' || pathname === '/txt';
}

async function handleApiRequest(request, env, url) {
  if (request.method !== 'POST') {
    return new Response('Only POST method is supported', {
      status: 405,
      headers: buildNoStoreHeaders(),
    });
  }

  if (!env.AI) {
    return buildJsonResponse(
      { error: 'Workers AI binding is not configured. Add [ai] binding = "AI" to wrangler.toml and redeploy.' },
      500
    );
  }

  let requestConfig;
  try {
    requestConfig = await buildRequestConfig(request, url);
  } catch (error) {
    return buildJsonResponse({ error: getPublicErrorMessage(error) }, 400);
  }

  let whisperResponse;
  try {
    whisperResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', requestConfig.inputs);
  } catch (error) {
    console.error('Whisper request failed');
    return buildJsonResponse({ error: getPublicErrorMessage(error) }, 500);
  }

  let processedResponse;
  try {
    processedResponse = await buildProcessedResponse(whisperResponse, requestConfig, env);
  } catch (error) {
    console.error('Translation request failed');
    return buildJsonResponse({ error: getPublicErrorMessage(error) }, 500);
  }

  if (url.pathname === '/raw') {
    return buildJsonResponse(buildRawPayload(processedResponse, requestConfig.mode));
  }

  if (url.pathname === '/srt') {
    return new Response(convertSegmentsToSRT(processedResponse.response.segments || []), {
      headers: buildTextHeaders('subtitles.srt', 'text/plain; charset=utf-8'),
    });
  }

  if (url.pathname === '/vtt') {
    const vtt = processedResponse.response.vtt || convertSegmentsToVTT(processedResponse.response.segments || []);
    return new Response(vtt, {
      headers: buildTextHeaders('subtitles.vtt', 'text/vtt; charset=utf-8'),
    });
  }

  if (url.pathname === '/txt') {
    return new Response(processedResponse.response.text || 'No transcription data.', {
      headers: buildTextHeaders('transcript.txt', 'text/plain; charset=utf-8'),
    });
  }

  return new Response('Not Found', { status: 404, headers: buildNoStoreHeaders() });
}

async function buildRequestConfig(request, url) {
  const mode = normalizeMode(url.searchParams.get('mode'));
  let task = getTrimmedParam(url.searchParams.get('task')) || 'transcribe';
  let language = getTrimmedParam(url.searchParams.get('language'));
  const vadFilter = parseOptionalBoolean(url.searchParams.get('vad_filter'));
  const initialPrompt = getTrimmedParam(url.searchParams.get('initial_prompt'));
  const prefix = getTrimmedParam(url.searchParams.get('prefix'));
  const beamSize = parseOptionalInteger(url.searchParams.get('beam_size'));
  const conditionOnPreviousText = parseOptionalBoolean(url.searchParams.get('condition_on_previous_text'));
  const noSpeechThreshold = parseOptionalNumber(url.searchParams.get('no_speech_threshold'));
  const compressionRatioThreshold = parseOptionalNumber(url.searchParams.get('compression_ratio_threshold'));
  const logProbThreshold = parseOptionalNumber(url.searchParams.get('log_prob_threshold'));
  const hallucinationSilenceThreshold = parseOptionalNumber(url.searchParams.get('hallucination_silence_threshold'));
  const contentType = normalizeAudioContentType(request.headers.get('content-type'));

  if (!contentType) {
    throw new Error('Invalid audio content type. Use a supported audio MIME type such as audio/mpeg, audio/wav, audio/mp4, or audio/webm.');
  }

  if (mode === 'zh_transcribe') {
    task = 'transcribe';
    if (!language) language = 'zh';
  }

  if (mode === 'foreign_transcribe' || mode === 'translate_to_zh') {
    task = 'transcribe';
  }

  if (task !== 'transcribe' && task !== 'translate') {
    task = 'transcribe';
  }

  const inputs = {
    audio: {
      body: request.body,
      contentType,
    },
    task,
  };

  if (language) inputs.language = language;
  if (vadFilter !== null) inputs.vad_filter = vadFilter;
  if (initialPrompt) inputs.initial_prompt = initialPrompt;
  if (prefix) inputs.prefix = prefix;
  if (beamSize !== null) inputs.beam_size = beamSize;
  if (conditionOnPreviousText !== null) inputs.condition_on_previous_text = conditionOnPreviousText;
  if (noSpeechThreshold !== null) inputs.no_speech_threshold = noSpeechThreshold;
  if (compressionRatioThreshold !== null) inputs.compression_ratio_threshold = compressionRatioThreshold;
  if (logProbThreshold !== null) inputs.log_prob_threshold = logProbThreshold;
  if (hallucinationSilenceThreshold !== null) {
    inputs.hallucination_silence_threshold = hallucinationSilenceThreshold;
  }

  return {
    inputs,
    mode,
    requestedLanguage: language,
  };
}

async function buildProcessedResponse(whisperResponse, requestConfig, env) {
  if (requestConfig.mode !== 'translate_to_zh') {
    return {
      response: whisperResponse,
      originalResponse: null,
      translation: null,
    };
  }

  const sourceLanguage = normalizeTranslationLanguage(
    requestConfig.requestedLanguage ||
      (whisperResponse.transcription_info && whisperResponse.transcription_info.language) ||
      ''
  );

  if (!sourceLanguage) {
    throw new Error('Could not determine the source language for Chinese translation.');
  }

  if (sourceLanguage === 'zh') {
    return {
      response: addTranslationMetadata(whisperResponse, {
        enabled: false,
        skipped: true,
        source_language: sourceLanguage,
        target_language: 'zh',
        reason: 'source_already_chinese',
      }),
      originalResponse: null,
      translation: {
        enabled: false,
        skipped: true,
        source_language: sourceLanguage,
        target_language: 'zh',
        reason: 'source_already_chinese',
      },
    };
  }

  const translatedResponse = await translateWhisperResponseToChinese(whisperResponse, sourceLanguage, env);

  return {
    response: translatedResponse,
    originalResponse: whisperResponse,
    translation: translatedResponse.translation_info,
  };
}

async function translateWhisperResponseToChinese(whisperResponse, sourceLanguage, env) {
  const translatedText = await translateText(whisperResponse.text || '', sourceLanguage, 'zh', env);
  const translatedSegments = await translateSegments(whisperResponse.segments || [], sourceLanguage, env);

  return addTranslationMetadata(
    {
      ...whisperResponse,
      text: translatedText,
      segments: translatedSegments,
      vtt: convertSegmentsToVTT(translatedSegments),
    },
    {
      enabled: true,
      skipped: false,
      source_language: sourceLanguage,
      target_language: 'zh',
      translated_text: translatedText,
    }
  );
}

async function translateSegments(segments, sourceLanguage, env) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  return mapWithConcurrency(segments, 4, async function(segment) {
    if (!segment || !segment.text) return segment;
    const translatedText = await translateText(segment.text, sourceLanguage, 'zh', env);
    return {
      ...segment,
      text: translatedText,
    };
  });
}

async function translateText(text, sourceLanguage, targetLanguage, env) {
  const trimmed = getTrimmedParam(text);
  if (!trimmed) return text;
  if (sourceLanguage === targetLanguage) return text;

  const translation = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text: trimmed,
    source_lang: sourceLanguage,
    target_lang: targetLanguage,
  });

  return getTrimmedParam(translation.translated_text) || text;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = [];
  const workerCount = Math.min(limit, items.length);

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

function addTranslationMetadata(response, translationInfo) {
  return {
    ...response,
    transcription_info: {
      ...(response.transcription_info || {}),
      translation_source_language: translationInfo.source_language,
      translation_target_language: translationInfo.target_language,
      translation_applied: Boolean(translationInfo.enabled),
      translation_skipped: Boolean(translationInfo.skipped),
    },
    translation_info: translationInfo,
  };
}

function buildRawPayload(processedResponse, mode) {
  const payload = {
    mode,
    response: processedResponse.response,
  };

  if (processedResponse.originalResponse) {
    payload.original_response = processedResponse.originalResponse;
  }

  if (processedResponse.translation) {
    payload.translation = processedResponse.translation;
  }

  return payload;
}

function buildTextHeaders(filename, contentType) {
  return {
    ...buildNoStoreHeaders(),
    'Content-Type': contentType,
    'Content-Disposition': 'inline; filename="' + filename + '"',
  };
}

function buildNoStoreHeaders() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  };
}

function buildJsonResponse(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: buildNoStoreHeaders(),
  });
}

function getPublicErrorMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';

  if (message.includes('3030: Failed to decode audio file')) {
    return 'Failed to decode audio file. Please upload a valid audio file and consider converting it to MP3 or WAV first.';
  }

  if (message.includes('resource limits') || message.includes('1102')) {
    return 'Worker exceeded resource limits. Please retry with a shorter or smaller audio file.';
  }

  if (message) {
    return message;
  }

  return 'An unexpected error occurred.';
}

function convertSegmentsToSRT(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return 'No transcription data.';
  }

  let srt = '';
  const lineBreak = String.fromCharCode(10);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    srt += String(i + 1) + lineBreak;
    srt += formatSRTTime(segment.start) + ' --> ' + formatSRTTime(segment.end) + lineBreak;
    srt += segment.text + lineBreak + lineBreak;
  }

  return srt;
}

function convertSegmentsToVTT(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return 'WEBVTT\n\nNo transcription data.';
  }

  let vtt = 'WEBVTT\n\n';
  const lineBreak = String.fromCharCode(10);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    vtt += formatVTTTime(segment.start) + ' --> ' + formatVTTTime(segment.end) + lineBreak;
    vtt += segment.text + lineBreak + lineBreak;
  }

  return vtt;
}

function formatSRTTime(seconds) {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(ms, 3);
}

function formatVTTTime(seconds) {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return pad(h) + ':' + pad(m) + ':' + pad(s) + '.' + pad(ms, 3);
}

function pad(num, size = 2) {
  return num.toString().padStart(size, '0');
}

function getTrimmedParam(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseOptionalBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parseOptionalNumber(value) {
  const trimmed = getTrimmedParam(value);
  if (trimmed === null) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalInteger(value) {
  const parsed = parseOptionalNumber(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeAudioContentType(value) {
  const normalized = getTrimmedParam(value);
  if (!normalized) return null;

  const contentType = normalized.split(';')[0].trim().toLowerCase();
  const allowed = {
    'application/octet-stream': 'application/octet-stream',
    'audio/mpeg': 'audio/mpeg',
    'audio/mp3': 'audio/mpeg',
    'audio/mp4': 'audio/mp4',
    'audio/x-m4a': 'audio/mp4',
    'audio/m4a': 'audio/mp4',
    'audio/wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/x-wav': 'audio/wav',
    'audio/webm': 'audio/webm',
  };

  return allowed[contentType] || null;
}

function normalizeMode(value) {
  const normalized = getTrimmedParam(value);
  if (normalized === 'zh_transcribe') return normalized;
  if (normalized === 'foreign_transcribe') return normalized;
  if (normalized === 'translate_to_zh') return normalized;
  return 'direct';
}

function normalizeTranslationLanguage(value) {
  const normalized = getTrimmedParam(value);
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
  const simple = lower.split(/[-_]/)[0];
  const aliases = {
    ar: 'ar',
    arabic: 'ar',
    cs: 'cs',
    czech: 'cs',
    da: 'da',
    danish: 'da',
    de: 'de',
    german: 'de',
    english: 'en',
    en: 'en',
    es: 'es',
    spanish: 'es',
    fa: 'fa',
    persian: 'fa',
    fi: 'fi',
    finnish: 'fi',
    fr: 'fr',
    french: 'fr',
    hi: 'hi',
    hindi: 'hi',
    hu: 'hu',
    hungarian: 'hu',
    id: 'id',
    indonesian: 'id',
    it: 'it',
    italian: 'it',
    ja: 'ja',
    japanese: 'ja',
    ko: 'ko',
    korean: 'ko',
    mandarin: 'zh',
    nl: 'nl',
    dutch: 'nl',
    no: 'no',
    norwegian: 'no',
    pl: 'pl',
    polish: 'pl',
    portuguese: 'pt',
    pt: 'pt',
    ro: 'ro',
    romanian: 'ro',
    ru: 'ru',
    russian: 'ru',
    sv: 'sv',
    swedish: 'sv',
    th: 'th',
    thai: 'th',
    tr: 'tr',
    turkish: 'tr',
    uk: 'uk',
    ukrainian: 'uk',
    vi: 'vi',
    vietnamese: 'vi',
    zh: 'zh',
    chinese: 'zh',
  };

  if (aliases[lower]) return aliases[lower];
  if (aliases[simple]) return aliases[simple];
  if (/^[a-z]{2,3}$/.test(simple)) return simple;

  return null;
}
