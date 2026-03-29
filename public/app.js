const resultBox = document.getElementById('result');
const downloadBtn = document.getElementById('downloadBtn');
const outputFormatSelect = document.getElementById('outputFormat');
const modeSelect = document.getElementById('mode');
const modeHint = document.getElementById('modeHint');
const languagePresetSelect = document.getElementById('languagePreset');
const languageInput = document.getElementById('language');
const languageHint = document.getElementById('languageHint');
const audioFileInput = document.getElementById('audioFile');
const dropzone = document.getElementById('dropzone');
const dropzoneHint = document.getElementById('dropzoneHint');
const fileMeta = document.getElementById('fileMeta');
const subtitleForm = document.getElementById('subtitleForm');
const subtitleFileInput = document.getElementById('subtitleFile');
const subtitleDropzone = document.getElementById('subtitleDropzone');
const subtitleDropzoneHint = document.getElementById('subtitleDropzoneHint');
const subtitleFileMeta = document.getElementById('subtitleFileMeta');
const subtitleLanguagePresetSelect = document.getElementById('subtitleLanguagePreset');
const subtitleLanguageInput = document.getElementById('subtitleLanguage');
const subtitleLanguageHint = document.getElementById('subtitleLanguageHint');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const metadataBox = document.getElementById('metadata');
const resultDescription = document.getElementById('resultDescription');
const presetSelect = document.getElementById('preset');
const presetHint = document.getElementById('presetHint');
const resetAdvancedBtn = document.getElementById('resetAdvancedBtn');
const customSelects = Array.from(document.querySelectorAll('.custom-select'));

const advancedFieldIds = [
  'beam_size',
  'condition_on_previous_text',
  'no_speech_threshold',
  'compression_ratio_threshold',
  'log_prob_threshold',
  'hallucination_silence_threshold'
];

const PRESETS = {
  balanced: {
    description: '官方默认值，适合大多数正常音频。',
    values: {
      beam_size: 5,
      condition_on_previous_text: true,
      no_speech_threshold: 0.6,
      compression_ratio_threshold: 2.4,
      log_prob_threshold: -1,
      hallucination_silence_threshold: ''
    }
  },
  fast: {
    description: '降低 beam_size，换取更快的返回速度，适合草稿转写。',
    values: {
      beam_size: 2,
      condition_on_previous_text: true,
      no_speech_threshold: 0.6,
      compression_ratio_threshold: 2.4,
      log_prob_threshold: -1,
      hallucination_silence_threshold: ''
    }
  },
  anti_loop: {
    description: '针对长音频重复、串段或幻觉循环，关闭前文依赖并加强过滤。',
    values: {
      beam_size: 5,
      condition_on_previous_text: false,
      no_speech_threshold: 0.6,
      compression_ratio_threshold: 2.2,
      log_prob_threshold: -0.8,
      hallucination_silence_threshold: 1.2
    }
  },
  noisy: {
    description: '提高过滤强度，适合背景噪声、会议空白段、环境音较多的音频。',
    values: {
      beam_size: 6,
      condition_on_previous_text: true,
      no_speech_threshold: 0.7,
      compression_ratio_threshold: 2.2,
      log_prob_threshold: -0.6,
      hallucination_silence_threshold: 0.8
    }
  },
  custom: {
    description: '已切换为自定义参数，请根据音频情况手动微调。',
    values: null
  }
};

let latestResponseData = null;
let latestRawPayload = null;
let currentOutputContent = '';
let isApplyingPreset = false;
let activeCustomSelect = null;
let currentResultFileName = 'result.txt';
let currentResultKind = 'audio';

function pad(num, size) {
  const width = size === undefined ? 2 : size;
  return num.toString().padStart(width, '0');
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

function convertSegmentsToSRT(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 'No transcription data.';

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
  if (!Array.isArray(segments) || segments.length === 0) return 'WEBVTT\n\nNo transcription data.';

  let vtt = 'WEBVTT\n\n';
  const lineBreak = String.fromCharCode(10);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    vtt += formatVTTTime(segment.start) + ' --> ' + formatVTTTime(segment.end) + lineBreak;
    vtt += segment.text + lineBreak + lineBreak;
  }
  return vtt;
}

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimLineEnd(value) {
  return String(value || '').replace(/\s+$/, '');
}

function parseSubtitleTimestamp(value) {
  const normalized = String(value || '').trim().replace(',', '.');
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

function parseCueTimingLine(line) {
  const match = String(line || '').match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/);
  if (!match) return null;

  const start = parseSubtitleTimestamp(match[1]);
  const end = parseSubtitleTimestamp(match[2]);
  if (start === null || end === null) return null;

  return { start: start, end: end };
}

function detectSubtitleFormatFromText(fileName, text) {
  const lowerName = (fileName || '').toLowerCase();
  if (lowerName.endsWith('.srt')) return 'srt';
  if (lowerName.endsWith('.vtt')) return 'vtt';
  if (/^\uFEFF?WEBVTT/.test(text)) return 'vtt';
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text)) return 'srt';
  return null;
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

function parseSubtitleDocumentClient(text, fileName) {
  const normalizedText = normalizeLineEndings(text || '').trim();
  if (!normalizedText) {
    throw new Error('Subtitle file is empty.');
  }

  const format = detectSubtitleFormatFromText(fileName, normalizedText);
  if (!format) {
    throw new Error('Unsupported subtitle format. Please upload an SRT or VTT file.');
  }

  const segments = format === 'vtt' ? parseVTTSegments(normalizedText) : parseSRTSegments(normalizedText);
  if (!segments.length) {
    throw new Error('Could not parse subtitle cues. Please upload a valid SRT or VTT subtitle file.');
  }

  return {
    format: format,
    segments: segments,
    text: segments.map(function(segment) {
      return segment.text;
    }).join('\n'),
  };
}

function setFieldValue(id, value) {
  const field = document.getElementById(id);
  if (!field) return;
  if (field.type === 'checkbox') {
    field.checked = Boolean(value);
    return;
  }
  field.value = value === '' || value === null || value === undefined ? '' : String(value);
  syncCustomSelectById(id);
}

function setupCustomSelects() {
  customSelects.forEach(function(wrapper) {
    const select = wrapper.querySelector('select');
    const trigger = wrapper.querySelector('.custom-select-trigger');
    const label = wrapper.querySelector('.custom-select-label');
    const menu = wrapper.querySelector('.custom-select-menu');

    if (!select || !trigger || !label || !menu) return;

    renderCustomSelectOptions(select, label, menu);

    trigger.addEventListener('click', function() {
      const isOpen = wrapper.classList.contains('is-open');
      closeAllCustomSelects();
      if (!isOpen) {
        wrapper.classList.add('is-open');
        menu.classList.remove('hidden');
        activeCustomSelect = wrapper;
      }
    });

    select.addEventListener('change', function() {
      renderCustomSelectOptions(select, label, menu);
    });
  });

  document.addEventListener('click', function(event) {
    if (!activeCustomSelect) return;
    if (activeCustomSelect.contains(event.target)) return;
    closeAllCustomSelects();
  });

  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeAllCustomSelects();
  });
}

function renderCustomSelectOptions(select, label, menu) {
  const options = Array.from(select.options);
  const selectedOption = options[select.selectedIndex] || options[0];
  label.textContent = selectedOption ? selectedOption.textContent : '';
  menu.innerHTML = '';

  options.forEach(function(option) {
    const optionButton = document.createElement('button');
    optionButton.type = 'button';
    optionButton.className = 'custom-select-option' + (option.selected ? ' is-active' : '');
    optionButton.textContent = option.textContent;
    optionButton.addEventListener('click', function() {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closeAllCustomSelects();
    });
    menu.appendChild(optionButton);
  });
}

function closeAllCustomSelects() {
  customSelects.forEach(function(wrapper) {
    wrapper.classList.remove('is-open');
    const menu = wrapper.querySelector('.custom-select-menu');
    if (menu) menu.classList.add('hidden');
  });
  activeCustomSelect = null;
}

function getAudioContentType(file) {
  if (file && file.type) return file.type;

  const fileName = file && file.name ? file.name.toLowerCase() : '';

  if (fileName.endsWith('.mp3') || fileName.endsWith('.mpga') || fileName.endsWith('.mpeg')) return 'audio/mpeg';
  if (fileName.endsWith('.wav')) return 'audio/wav';
  if (fileName.endsWith('.m4a')) return 'audio/mp4';
  if (fileName.endsWith('.mp4')) return 'audio/mp4';
  if (fileName.endsWith('.webm')) return 'audio/webm';

  return 'application/octet-stream';
}

function getSubtitleContentType(file) {
  if (file && file.type) return file.type;

  const fileName = file && file.name ? file.name.toLowerCase() : '';
  if (fileName.endsWith('.vtt')) return 'text/vtt';
  return 'text/plain';
}

function syncCustomSelectById(id) {
  const wrapper = customSelects.find(function(item) {
    const select = item.querySelector('select');
    return select && select.id === id;
  });

  if (!wrapper) return;

  const select = wrapper.querySelector('select');
  const label = wrapper.querySelector('.custom-select-label');
  const menu = wrapper.querySelector('.custom-select-menu');
  if (!select || !label || !menu) return;
  renderCustomSelectOptions(select, label, menu);
}

function updatePresetHint(message) {
  const selectedPreset = PRESETS[presetSelect.value];
  presetHint.textContent = message || (selectedPreset ? selectedPreset.description : '');
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset || !preset.values) {
    updatePresetHint();
    return;
  }

  isApplyingPreset = true;
  advancedFieldIds.forEach(function(id) {
    setFieldValue(id, preset.values[id]);
  });
  presetSelect.value = name;
  updatePresetHint();
  isApplyingPreset = false;
}

function markPresetCustom() {
  presetSelect.value = 'custom';
  updatePresetHint();
}

function attachAdvancedFieldListeners() {
  advancedFieldIds.forEach(function(id) {
    const field = document.getElementById(id);
    if (!field) return;
    const eventName = field.type === 'checkbox' ? 'change' : 'input';
    field.addEventListener(eventName, function() {
      if (!isApplyingPreset) markPresetCustom();
    });
  });
}

function appendTrimmedParam(params, key, value) {
  const trimmed = value.trim();
  if (trimmed) params.set(key, trimmed);
}

function appendNumericParam(params, key, value) {
  const trimmed = value.trim();
  if (trimmed !== '') params.set(key, trimmed);
}

function getSelectedMode() {
  return modeSelect.value || 'zh_transcribe';
}

function updateFileMeta() {
  const file = audioFileInput.files[0];
  if (!file) {
    fileMeta.textContent = '尚未选择文件';
    if (dropzoneHint) {
      dropzoneHint.textContent = '支持 `MP3`、`MP4`、`MPEG`、`MPGA`、`M4A`、`WAV`、`WEBM`，可点击选择，也可直接拖拽文件到这里。';
    }
    return;
  }

  const sizeInMb = file.size / (1024 * 1024);
  const roundedSize = sizeInMb >= 1 ? sizeInMb.toFixed(2) + ' MB' : Math.max(1, Math.round(file.size / 1024)) + ' KB';
  const typeLabel = file.type ? file.type : '未知类型';
  fileMeta.textContent = file.name + ' | ' + typeLabel + ' | ' + roundedSize;
  if (dropzoneHint) {
    dropzoneHint.textContent = '已选择文件；如需替换，可重新点击选择，或直接拖拽另一个音频文件覆盖。';
  }
}

function updateSubtitleFileMeta() {
  const file = subtitleFileInput.files[0];
  if (!file) {
    subtitleFileMeta.textContent = '尚未选择字幕文件';
    if (subtitleDropzoneHint) {
      subtitleDropzoneHint.textContent = '支持 `SRT` 与 `VTT`，可直接上传现成字幕文件翻译为中文。';
    }
    return;
  }

  const sizeInKb = Math.max(1, Math.round(file.size / 1024));
  const typeLabel = file.type ? file.type : '未知类型';
  subtitleFileMeta.textContent = file.name + ' | ' + typeLabel + ' | ' + sizeInKb + ' KB';
  if (subtitleDropzoneHint) {
    subtitleDropzoneHint.textContent = '已选择字幕文件；如需替换，可重新点击选择，或直接拖拽另一个字幕文件覆盖。';
  }
}

function wireDropzone(dropzoneElement, fileInput, updateMeta, activeClassName) {
  if (!dropzoneElement || !fileInput || !updateMeta) return;

  const dragClassName = activeClassName || 'is-dragover';

  ['dragenter', 'dragover'].forEach(function(eventName) {
    dropzoneElement.addEventListener(eventName, function(event) {
      event.preventDefault();
      dropzoneElement.classList.add(dragClassName);
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach(function(eventName) {
    dropzoneElement.addEventListener(eventName, function(event) {
      event.preventDefault();
      if (eventName !== 'drop' && dropzoneElement.contains(event.relatedTarget)) return;
      dropzoneElement.classList.remove(dragClassName);
    });
  });

  dropzoneElement.addEventListener('drop', function(event) {
    const files = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : null;
    if (!files || !files.length) return;

    fileInput.files = files;
    updateMeta();
  });
}

function getNormalizedLanguage() {
  const presetValue = languagePresetSelect.value;
  const manualValue = languageInput.value.trim();
  if (presetValue === 'custom') return manualValue;
  if (presetValue !== 'auto') return presetValue;
  return manualValue;
}

function handleLanguagePresetChange() {
  const presetValue = languagePresetSelect.value;

  if (presetValue === 'auto') {
    languageInput.value = '';
  } else if (presetValue !== 'custom') {
    languageInput.value = presetValue;
  }

  syncLanguageControls();
}

function syncModeControls() {
  const mode = getSelectedMode();

  if (mode === 'zh_transcribe') {
    if (languagePresetSelect.value === 'auto' || !languageInput.value.trim()) {
      languagePresetSelect.value = 'zh';
      languageInput.value = 'zh';
    }
    modeHint.textContent = '中文语音转中文：默认把语言锁到中文，更适合会议、课程和口播内容。';
    languageHint.textContent = '中文语音转中文模式下，默认锁定为中文更稳；如果你的内容主要是其它语言，请切换其它模式。';
  } else if (mode === 'foreign_transcribe') {
    if (languagePresetSelect.value === 'zh' && languageInput.value.trim().toLowerCase() === 'zh') {
      languagePresetSelect.value = 'auto';
      languageInput.value = '';
    }
    modeHint.textContent = '外语语音保留原文：适合做原文字幕或先看原始识别效果。';
    languageHint.textContent = '想保留外语原文时，推荐自动检测或手动指定实际语言，例如 en / ja / ko。';
  } else {
    if (languagePresetSelect.value === 'zh' && languageInput.value.trim().toLowerCase() === 'zh') {
      languagePresetSelect.value = 'auto';
      languageInput.value = '';
    }
    modeHint.textContent = '外语语音转中文：系统会先转写，再用 m2m100-1.2b 翻译成中文。';
    languageHint.textContent = '外语转中文模式会先转写再翻译；为提升稳定性，建议手动指定源语言，例如 en / ja / ko。';
  }

  syncLanguageControls();
  syncCustomSelectById('mode');
}

function syncLanguageControls() {
  const presetValue = languagePresetSelect.value;

  if (presetValue === 'custom') {
    languageInput.placeholder = '输入自定义语言代码，例如 it / pt / ar';
    return;
  }
  if (presetValue === 'auto') {
    languageInput.placeholder = '留空自动检测，或输入自定义语言代码';
    return;
  }
  languageInput.placeholder = '已选择常用语言，也可改成其它代码';
}

function syncLanguagePresetFromInput() {
  const manualValue = languageInput.value.trim().toLowerCase();
  const knownOptions = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];
  if (!manualValue) {
    languagePresetSelect.value = 'auto';
  } else if (knownOptions.indexOf(manualValue) !== -1) {
    languagePresetSelect.value = manualValue;
  } else {
    languagePresetSelect.value = 'custom';
  }
  syncLanguageControls();
  syncCustomSelectById('languagePreset');
}

function getNormalizedSubtitleLanguage() {
  const presetValue = subtitleLanguagePresetSelect.value;
  const manualValue = subtitleLanguageInput.value.trim();
  if (presetValue === 'custom') return manualValue;
  return manualValue || presetValue;
}

function handleSubtitleLanguagePresetChange() {
  const presetValue = subtitleLanguagePresetSelect.value;

  if (presetValue !== 'custom') {
    subtitleLanguageInput.value = presetValue;
  }

  syncSubtitleLanguageControls();
}

function syncSubtitleLanguageControls() {
  const presetValue = subtitleLanguagePresetSelect.value;

  if (presetValue === 'custom') {
    subtitleLanguageInput.placeholder = '输入字幕原语言代码，例如 it / pt / ar';
    subtitleLanguageHint.textContent = '字幕翻译不会自动识别语种，请填写原字幕语言代码。';
    syncCustomSelectById('subtitleLanguagePreset');
    return;
  }

  subtitleLanguageInput.placeholder = '已选择常用语言，也可改成其它代码';
  subtitleLanguageHint.textContent = '字幕翻译不会自动识别语种，请明确填写原字幕语言代码。';
  syncCustomSelectById('subtitleLanguagePreset');
}

function syncSubtitleLanguagePresetFromInput() {
  const manualValue = subtitleLanguageInput.value.trim().toLowerCase();
  const knownOptions = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];
  if (!manualValue) {
    subtitleLanguagePresetSelect.value = 'en';
  } else if (knownOptions.indexOf(manualValue) !== -1) {
    subtitleLanguagePresetSelect.value = manualValue;
  } else {
    subtitleLanguagePresetSelect.value = 'custom';
  }
  syncSubtitleLanguageControls();
}

function formatSeconds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.round(value * 10) / 10 + 's';
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.round(value * 1000) / 10 + '%';
}

function renderMetadata(responseData) {
  const info = responseData && responseData.transcription_info ? responseData.transcription_info : {};
  const items = [];
  const probability = formatPercent(info.language_probability);
  const duration = formatSeconds(info.duration);
  const durationAfterVad = formatSeconds(info.duration_after_vad);

  if (info.language) items.push('语言 ' + info.language);
  if (probability) items.push('语言置信度 ' + probability);
  if (duration) items.push('音频时长 ' + duration);
  if (durationAfterVad) items.push('VAD 后 ' + durationAfterVad);
  if (info.translation_applied) items.push('已翻译为中文');
  if (info.translation_skipped) items.push('原文已是中文');
  if (info.subtitle_format) items.push('字幕格式 ' + String(info.subtitle_format).toUpperCase());
  if (typeof info.segment_count === 'number') items.push('字幕段数 ' + info.segment_count);
  if (typeof responseData.word_count === 'number') items.push('词数 ' + responseData.word_count);

  metadataBox.textContent = items.join(' | ');
}

function setProgressMessage(message) {
  if (progressLabel) progressLabel.textContent = message;
}

function setResultDescription(message) {
  if (resultDescription) resultDescription.textContent = message;
}

function startProgress(message) {
  setProgressMessage(message);
  progressContainer.classList.remove('hidden');
  resetResultState();

  let progress = 0;
  const progressInterval = setInterval(function() {
    if (progress < 90) {
      progress += 0.9;
      progressBar.style.width = progress + '%';
    }
  }, 200);

  return progressInterval;
}

function stopProgress(progressInterval, hideWithDelay) {
  clearInterval(progressInterval);
  progressBar.style.width = '100%';

  if (hideWithDelay) {
    setTimeout(function() {
      progressContainer.classList.add('hidden');
    }, 500);
    return;
  }

  progressContainer.classList.add('hidden');
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function getOutputDescriptor(responseData) {
  const format = outputFormatSelect.value;

  if (format === 'json') {
    return {
      content: formatJson(latestRawPayload || { response: responseData || {} }),
      extension: '.json',
      mimeType: 'application/json;charset=utf-8'
    };
  }

  if (!responseData) {
    return {
      content: 'No transcription data.',
      extension: format === 'vtt' ? '.vtt' : format === 'srt' ? '.srt' : '.txt',
      mimeType: 'text/plain;charset=utf-8'
    };
  }

  if (format === 'txt') {
    return {
      content: responseData.text || 'No transcription data.',
      extension: '.txt',
      mimeType: 'text/plain;charset=utf-8'
    };
  }

  if (format === 'vtt') {
    return {
      content: responseData.vtt || convertSegmentsToVTT(responseData.segments || []),
      extension: '.vtt',
      mimeType: 'text/vtt;charset=utf-8'
    };
  }

  return {
    content: convertSegmentsToSRT(responseData.segments || []),
    extension: '.srt',
    mimeType: 'text/plain;charset=utf-8'
  };
}

function renderOutput(responseData) {
  const descriptor = getOutputDescriptor(responseData);
  currentOutputContent = descriptor.content;
  resultBox.value = currentOutputContent;
  downloadBtn.disabled = !currentOutputContent;
}

function resetResultState() {
  progressBar.style.width = '0%';
  resultBox.value = '';
  metadataBox.textContent = '';
  downloadBtn.disabled = true;
  latestResponseData = null;
  latestRawPayload = null;
  currentOutputContent = '';
}

attachAdvancedFieldListeners();
setupCustomSelects();
wireDropzone(dropzone, audioFileInput, updateFileMeta, 'is-dragover');
wireDropzone(subtitleDropzone, subtitleFileInput, updateSubtitleFileMeta, 'is-dragover-subtle');
applyPreset('balanced');
syncModeControls();
syncSubtitleLanguageControls();
updateFileMeta();
updateSubtitleFileMeta();

presetSelect.addEventListener('change', function() {
  if (presetSelect.value === 'custom') return updatePresetHint();
  applyPreset(presetSelect.value);
});

resetAdvancedBtn.addEventListener('click', function() {
  applyPreset('balanced');
});

modeSelect.addEventListener('change', syncModeControls);
languagePresetSelect.addEventListener('change', handleLanguagePresetChange);
languageInput.addEventListener('input', syncLanguagePresetFromInput);
audioFileInput.addEventListener('change', updateFileMeta);
subtitleLanguagePresetSelect.addEventListener('change', handleSubtitleLanguagePresetChange);
subtitleLanguageInput.addEventListener('input', syncSubtitleLanguagePresetFromInput);
subtitleFileInput.addEventListener('change', updateSubtitleFileMeta);

outputFormatSelect.addEventListener('change', function() {
  if (latestResponseData) renderOutput(latestResponseData);
});

document.getElementById('uploadForm').addEventListener('submit', async function(event) {
  event.preventDefault();

  const file = audioFileInput.files[0];
  if (!file) {
    alert('Please select a file.');
    return;
  }

  currentResultKind = 'audio';
  currentResultFileName = file.name;
  setResultDescription('支持在 SRT、VTT、TXT 和 Raw JSON 之间切换；外语转中文模式会直接展示翻译后的中文结果。');

  const params = new URLSearchParams({ mode: getSelectedMode() });
  const normalizedLanguage = getNormalizedLanguage();
  if (normalizedLanguage) params.set('language', normalizedLanguage);
  appendTrimmedParam(params, 'initial_prompt', document.getElementById('initial_prompt').value);
  appendTrimmedParam(params, 'prefix', document.getElementById('prefix').value);
  params.set('vad_filter', document.getElementById('vad_filter').checked ? 'true' : 'false');
  params.set('condition_on_previous_text', document.getElementById('condition_on_previous_text').checked ? 'true' : 'false');
  appendNumericParam(params, 'beam_size', document.getElementById('beam_size').value);
  appendNumericParam(params, 'no_speech_threshold', document.getElementById('no_speech_threshold').value);
  appendNumericParam(params, 'compression_ratio_threshold', document.getElementById('compression_ratio_threshold').value);
  appendNumericParam(params, 'log_prob_threshold', document.getElementById('log_prob_threshold').value);
  appendNumericParam(params, 'hallucination_silence_threshold', document.getElementById('hallucination_silence_threshold').value);

  const progressInterval = startProgress('正在提交音频并等待 Whisper 返回结果，请稍候。');

  try {
    const contentType = getAudioContentType(file);
    const response = await fetch('/raw?' + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: file
    });

    if (!response.ok) {
      clearInterval(progressInterval);
      progressContainer.classList.add('hidden');
      resultBox.value = 'Error: ' + await response.text();
      return;
    }

    const rawData = await response.json();
    latestRawPayload = rawData;
    latestResponseData = rawData && rawData.response ? rawData.response : null;
    renderMetadata(latestResponseData || {});

    stopProgress(progressInterval, true);

    renderOutput(latestResponseData);
  } catch (error) {
    clearInterval(progressInterval);
    progressContainer.classList.add('hidden');
    resultBox.value = 'Error: ' + error.message;
  }
});

subtitleForm.addEventListener('submit', async function(event) {
  event.preventDefault();

  const file = subtitleFileInput.files[0];
  if (!file) {
    alert('Please select a subtitle file.');
    return;
  }

  const normalizedLanguage = getNormalizedSubtitleLanguage();
  if (!normalizedLanguage) {
    alert('Please provide the subtitle source language.');
    return;
  }

  currentResultKind = 'subtitle';
  currentResultFileName = file.name;
  setResultDescription('这里展示的是上传字幕文件翻译后的结果；系统会把字幕整理成 `[[[0001]]] + 文本` 的整份内容直接翻译，再按标记回填到原时间轴。');

  const progressInterval = startProgress('正在上传字幕文件并整份翻译为中文，请稍候。');

  try {
    const params = new URLSearchParams({
      language: normalizedLanguage,
      filename: file.name,
    });
    const response = await fetch('/subtitle?' + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': getSubtitleContentType(file) },
      body: file,
    });

    if (!response.ok) {
      clearInterval(progressInterval);
      progressContainer.classList.add('hidden');
      resultBox.value = 'Error: ' + await response.text();
      return;
    }

    const rawData = await response.json();
    latestRawPayload = rawData;
    latestResponseData = rawData && rawData.response ? rawData.response : null;
    renderMetadata(latestResponseData || {});
    stopProgress(progressInterval, true);
    renderOutput(latestResponseData);
  } catch (error) {
    clearInterval(progressInterval);
    progressContainer.classList.add('hidden');
    resultBox.value = 'Error: ' + error.message;
  }
});

downloadBtn.addEventListener('click', function() {
  if (!latestResponseData) return;

  const descriptor = getOutputDescriptor(latestResponseData);
  const outputFileName = currentResultFileName.replace(/\.[^/.]+$/, '') + descriptor.extension;
  const blob = new Blob([descriptor.content], { type: descriptor.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = outputFileName;
  anchor.click();
  URL.revokeObjectURL(url);
});
