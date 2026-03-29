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
  return pathname === '/raw' || pathname === '/srt' || pathname === '/vtt' || pathname === '/txt' || pathname === '/subtitle';
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

  if (url.pathname === '/subtitle') {
    return handleSubtitleTranslationRequest(request, env, url);
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

async function handleSubtitleTranslationRequest(request, env, url) {
  const sourceLanguage = normalizeTranslationLanguage(getTrimmedParam(url.searchParams.get('language')) || '');

  if (!sourceLanguage) {
    return buildJsonResponse(
      { error: 'Standalone subtitle translation requires a source language code such as en, ja, ko, fr, or de.' },
      400
    );
  }

  let subtitleText;
  try {
    subtitleText = await request.text();
  } catch (error) {
    return buildJsonResponse({ error: 'Could not read the uploaded subtitle file.' }, 400);
  }

  let subtitleDocument;
  try {
    subtitleDocument = parseSubtitleDocument(
      subtitleText,
      getTrimmedParam(url.searchParams.get('filename')) || 'subtitles.srt'
    );
  } catch (error) {
    return buildJsonResponse({ error: getPublicErrorMessage(error) }, 400);
  }

  try {
    const translatedDocument = await translateSubtitleDocumentToChinese(subtitleDocument, sourceLanguage, env);
    return buildJsonResponse({
      mode: 'subtitle_to_zh',
      response: translatedDocument.response,
      original_response: translatedDocument.originalResponse,
      translation: translatedDocument.translation,
    });
  } catch (error) {
    console.error('Subtitle translation request failed');
    return buildJsonResponse({ error: getPublicErrorMessage(error) }, 500);
  }
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
  const translatedSegments = await translateSegments(whisperResponse.segments || [], sourceLanguage, 'zh', env, {
    maxItems: 24,
    maxCharacters: 2600,
  });
  const translatedText = translatedSegments.length
    ? collectSegmentText(translatedSegments, ' ')
    : await translateText(whisperResponse.text || '', sourceLanguage, 'zh', env);

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
      segment_count: translatedSegments.length,
    }
  );
}

async function translateSubtitleDocumentToChinese(subtitleDocument, sourceLanguage, env) {
  const translatedSegments = await translateSubtitleSegmentsBatch(subtitleDocument.segments, sourceLanguage, 'zh', env);
  const translatedText = collectSegmentText(translatedSegments, '\n');
  const translatedResponse = addTranslationMetadata(
    {
      text: translatedText,
      segments: translatedSegments,
      vtt: convertSegmentsToVTT(translatedSegments),
      subtitle_format: subtitleDocument.format,
    },
    {
      enabled: true,
      skipped: false,
      source_language: sourceLanguage,
      target_language: 'zh',
      translated_text: translatedText,
      segment_count: translatedSegments.length,
    },
    {
      subtitle_format: subtitleDocument.format,
      segment_count: translatedSegments.length,
    }
  );

  return {
    response: translatedResponse,
    originalResponse: {
      text: subtitleDocument.text,
      segments: subtitleDocument.segments,
      vtt: convertSegmentsToVTT(subtitleDocument.segments),
      subtitle_format: subtitleDocument.format,
    },
    translation: translatedResponse.translation_info,
  };
}

async function translateSubtitleSegmentsBatch(segments, sourceLanguage, targetLanguage, env) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  const requests = segments.map(function(segment) {
    return {
      text: normalizeInlineText(segment && segment.text ? segment.text : ''),
      source_lang: mapTranslationModelLanguage(sourceLanguage),
      target_lang: mapTranslationModelLanguage(targetLanguage),
    };
  });

  const response = await env.AI.run('@cf/meta/m2m100-1.2b', { requests });
  const translatedItems = Array.isArray(response) ? response : response && Array.isArray(response.result) ? response.result : null;

  if (!translatedItems || translatedItems.length !== segments.length) {
    throw new Error('Subtitle batch translation did not return the expected number of items.');
  }

  return segments.map(function(segment, index) {
    const item = translatedItems[index] || {};
    const translatedText = getTrimmedParam(item.translated_text) || segment.text;
    return {
      ...segment,
      text: translatedText,
    };
  });
}

async function translateSegments(segments, sourceLanguage, targetLanguage, env, options) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  const batchOptions = {
    maxItems: 12,
    maxCharacters: 1600,
    ...(options || {}),
  };
  const batches = createTranslationBatches(segments, batchOptions.maxItems, batchOptions.maxCharacters);
  const translated = [];

  for (let i = 0; i < batches.length; i++) {
    const translatedBatch = await translateSegmentBatch(batches[i], sourceLanguage, targetLanguage, env);
    translated.push(...translatedBatch);
  }

  return translated;
}

async function translateSegmentBatch(segments, sourceLanguage, targetLanguage, env) {
  if (segments.length === 1) {
    const segment = segments[0];
    if (!segment || !segment.text) return [segment];
    const translatedText = await translateText(segment.text, sourceLanguage, targetLanguage, env);
    return [
      {
        ...segment,
        text: translatedText,
      },
    ];
  }

  try {
    const taggedPayload = buildTaggedTranslationPayload(segments);
    const translatedPayload = await translateText(taggedPayload, sourceLanguage, targetLanguage, env);
    const extractedTexts = extractTaggedTranslations(translatedPayload, segments.length);

    if (extractedTexts) {
      return segments.map(function(segment, index) {
        return {
          ...segment,
          text: extractedTexts[index] || segment.text,
        };
      });
    }
  } catch (error) {
    if (segments.length === 1) {
      throw error;
    }
  }

  const midpoint = Math.ceil(segments.length / 2);
  const left = await translateSegmentBatch(segments.slice(0, midpoint), sourceLanguage, targetLanguage, env);
  const right = await translateSegmentBatch(segments.slice(midpoint), sourceLanguage, targetLanguage, env);
  return left.concat(right);
}

function createTranslationBatches(segments, maxItems, maxCharacters) {
  const batches = [];
  let currentBatch = [];
  let currentCharacters = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment || !segment.text) {
      currentBatch.push(segment);
      continue;
    }

    const estimatedSize = normalizeInlineText(segment.text).length + 12;
    const shouldStartNewBatch =
      currentBatch.length > 0 && (currentBatch.length >= maxItems || currentCharacters + estimatedSize > maxCharacters);

    if (shouldStartNewBatch) {
      batches.push(currentBatch);
      currentBatch = [];
      currentCharacters = 0;
    }

    currentBatch.push(segment);
    currentCharacters += estimatedSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function buildTaggedTranslationPayload(segments) {
  return segments
    .map(function(segment, index) {
      return '[[' + index + ']] ' + normalizeInlineText(segment && segment.text ? segment.text : '');
    })
    .join('\n');
}

function extractTaggedTranslations(text, expectedCount) {
  const normalized = normalizeLineEndings(text);
  const markers = [];
  const markerPattern = /\[\[(\d+)\]\]/g;
  let match;

  while ((match = markerPattern.exec(normalized)) !== null) {
    markers.push({
      index: Number(match[1]),
      start: match.index,
      end: markerPattern.lastIndex,
    });
  }

  if (markers.length !== expectedCount) {
    return null;
  }

  const extracted = new Array(expectedCount);

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!Number.isInteger(marker.index) || marker.index < 0 || marker.index >= expectedCount) {
      return null;
    }

    const nextStart = i + 1 < markers.length ? markers[i + 1].start : normalized.length;
    extracted[marker.index] = normalized.slice(marker.end, nextStart).trim();
  }

  if (extracted.some(function(value) {
    return typeof value !== 'string';
  })) {
    return null;
  }

  return extracted;
}

async function translateText(text, sourceLanguage, targetLanguage, env) {
  const trimmed = getTrimmedParam(text);
  if (!trimmed) return text;
  if (sourceLanguage === targetLanguage) return text;

  const translation = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text: trimmed,
    source_lang: mapTranslationModelLanguage(sourceLanguage),
    target_lang: mapTranslationModelLanguage(targetLanguage),
  });

  return getTrimmedParam(translation.translated_text) || text;
}

function mapTranslationModelLanguage(value) {
  const normalized = normalizeTranslationLanguage(value) || String(value || '').trim().toLowerCase();
  const labels = {
    ar: 'arabic',
    cs: 'czech',
    da: 'danish',
    de: 'german',
    en: 'english',
    es: 'spanish',
    fa: 'persian',
    fi: 'finnish',
    fr: 'french',
    hi: 'hindi',
    hu: 'hungarian',
    id: 'indonesian',
    it: 'italian',
    ja: 'japanese',
    ko: 'korean',
    nl: 'dutch',
    no: 'norwegian',
    pl: 'polish',
    pt: 'portuguese',
    ro: 'romanian',
    ru: 'russian',
    sv: 'swedish',
    th: 'thai',
    tr: 'turkish',
    uk: 'ukrainian',
    vi: 'vietnamese',
    zh: 'chinese',
  };

  return labels[normalized] || normalized;
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

function addTranslationMetadata(response, translationInfo, extraTranscriptionInfo) {
  return {
    ...response,
    transcription_info: {
      ...(response.transcription_info || {}),
      ...(extraTranscriptionInfo || {}),
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

  if (message.includes('Too many subrequests')) {
    return 'This request triggered too many Worker subrequests. This usually means the current audio or subtitle content has too many segments or too much text work for a single Worker invocation, not necessarily that the uploaded file is large in bytes. Try splitting the content into smaller parts and process them separately.';
  }

  if (message.includes('could not safely map translated lines back to subtitle indexes')) {
    return 'Subtitle translation returned unstable line indexes, so the translated text could not be safely mapped back to subtitle cues. Please shorten the subtitle file or split it manually before retrying.';
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

function parseSubtitleDocument(text, filename) {
  const normalizedText = normalizeLineEndings(text || '').trim();
  if (!normalizedText) {
    throw new Error('Subtitle file is empty.');
  }

  const format = detectSubtitleFormat(filename, normalizedText);
  let segments = [];

  if (format === 'srt') {
    segments = parseSRTSegments(normalizedText);
  } else if (format === 'vtt') {
    segments = parseVTTSegments(normalizedText);
  }

  if (!segments.length) {
    throw new Error('Could not parse subtitle cues. Please upload a valid SRT or VTT subtitle file.');
  }

  return {
    format,
    text: collectSegmentText(segments, '\n'),
    segments,
  };
}

function detectSubtitleFormat(filename, text) {
  const lowerName = (filename || '').toLowerCase();
  if (lowerName.endsWith('.srt')) return 'srt';
  if (lowerName.endsWith('.vtt')) return 'vtt';
  if (text.startsWith('WEBVTT')) return 'vtt';
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text)) return 'srt';
  throw new Error('Unsupported subtitle format. Please upload an SRT or VTT file.');
}

function parseSRTSegments(text) {
  const blocks = normalizeLineEndings(text).split(/\n{2,}/);
  const segments = [];

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n').map(trimLineEnd);
    if (!lines.length) continue;

    let timingIndex = 0;
    if (/^\d+$/.test(lines[0].trim()) && lines.length > 1) {
      timingIndex = 1;
    }

    const timing = parseCueTimingLine(lines[timingIndex]);
    if (!timing) continue;

    const cueText = lines.slice(timingIndex + 1).join('\n').trim();
    if (!cueText) continue;

    segments.push({
      start: timing.start,
      end: timing.end,
      text: cueText,
    });
  }

  return segments;
}

function parseVTTSegments(text) {
  const blocks = normalizeLineEndings(text)
    .replace(/^\uFEFF?WEBVTT[^\n]*\n*/, '')
    .split(/\n{2,}/);
  const segments = [];

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n').map(trimLineEnd).filter(Boolean);
    if (!lines.length) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

    const timingIndex = lines.findIndex(function(line) {
      return line.includes('-->');
    });

    if (timingIndex === -1) continue;

    const timing = parseCueTimingLine(lines[timingIndex]);
    if (!timing) continue;

    const cueText = lines.slice(timingIndex + 1).join('\n').trim();
    if (!cueText) continue;

    segments.push({
      start: timing.start,
      end: timing.end,
      text: cueText,
    });
  }

  return segments;
}

function parseCueTimingLine(line) {
  const match = String(line || '').match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/);
  if (!match) return null;

  const start = parseSubtitleTimestamp(match[1]);
  const end = parseSubtitleTimestamp(match[2]);
  if (start === null || end === null) return null;

  return { start, end };
}

function parseSubtitleTimestamp(value) {
  const normalized = getTrimmedParam(String(value || '').replace(',', '.'));
  if (!normalized) return null;

  const match = normalized.match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;

  const hours = Number(match[1] || '0');
  const minutes = Number(match[2] || '0');
  const seconds = Number(match[3] || '0');
  const milliseconds = Number((match[4] || '0').padEnd(3, '0'));

  if ([hours, minutes, seconds, milliseconds].some(function(part) {
    return !Number.isFinite(part);
  })) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function collectSegmentText(segments, separator) {
  if (!Array.isArray(segments) || segments.length === 0) return '';

  return segments
    .map(function(segment) {
      return getTrimmedParam(segment && segment.text ? String(segment.text) : '');
    })
    .filter(Boolean)
    .join(separator || ' ');
}

function normalizeInlineText(value) {
  return normalizeLineEndings(String(value || ''))
    .split('\n')
    .map(function(line) {
      return line.trim();
    })
    .filter(Boolean)
    .join(' / ');
}

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimLineEnd(value) {
  return String(value || '').replace(/\s+$/, '');
}
