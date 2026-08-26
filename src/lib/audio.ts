/** Client-side audio extraction: video file -> 16kHz mono WAV chunks. */

export type AudioChunk = {
  /** Base64-encoded WAV bytes (no data: prefix). */
  base64: string;
  /** Start time of the chunk inside the original media, in seconds. */
  start: number;
  /** Duration of the chunk in seconds. */
  duration: number;
};

const TARGET_RATE = 16000;
const ANALYSIS_FRAME_SECONDS = 0.02;
const TARGET_CHUNK_SECONDS = 12;
const MAX_CHUNK_SECONDS = 18;
const EDGE_PADDING_SECONDS = 0.12;

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

/**
 * Splits on real pauses instead of fixed clock boundaries. This keeps each
 * transcript anchored to the moment speech starts and greatly reduces drift.
 */
function speechRanges(samples: Float32Array): Array<{ from: number; to: number }> {
  const frameSize = Math.round(TARGET_RATE * ANALYSIS_FRAME_SECONDS);
  const levels: number[] = [];
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    let energy = 0;
    const end = Math.min(offset + frameSize, samples.length);
    for (let i = offset; i < end; i++) {
      const value = samples[i] ?? 0;
      energy += value * value;
    }
    levels.push(Math.sqrt(energy / Math.max(1, end - offset)));
  }

  const threshold = Math.min(0.04, Math.max(0.006, percentile(levels, 0.2) * 3.5));
  const active = levels.map((level) => level >= threshold);
  const bridgeFrames = Math.round(0.3 / ANALYSIS_FRAME_SECONDS);
  const minimumSpeechFrames = Math.round(0.16 / ANALYSIS_FRAME_SECONDS);

  // Short quiet gaps inside a word or sentence are not useful cut points.
  let quietStart = -1;
  for (let i = 0; i <= active.length; i++) {
    if (i < active.length && !active[i]) {
      if (quietStart < 0) quietStart = i;
    } else if (quietStart >= 0) {
      if (i - quietStart <= bridgeFrames) active.fill(true, quietStart, i);
      quietStart = -1;
    }
  }

  const utterances: Array<{ from: number; to: number }> = [];
  let speechStart = -1;
  for (let i = 0; i <= active.length; i++) {
    if (i < active.length && active[i]) {
      if (speechStart < 0) speechStart = i;
    } else if (speechStart >= 0) {
      if (i - speechStart >= minimumSpeechFrames) {
        utterances.push({ from: speechStart * frameSize, to: Math.min(i * frameSize, samples.length) });
      }
      speechStart = -1;
    }
  }

  const targetSamples = TARGET_CHUNK_SECONDS * TARGET_RATE;
  const maxSamples = MAX_CHUNK_SECONDS * TARGET_RATE;
  const padding = Math.round(EDGE_PADDING_SECONDS * TARGET_RATE);
  const ranges: Array<{ from: number; to: number }> = [];

  for (const utterance of utterances) {
    let from = Math.max(0, utterance.from - padding);
    const paddedTo = Math.min(samples.length, utterance.to + padding);
    while (paddedTo - from > maxSamples) {
      const target = from + targetSamples;
      const searchRadius = 2 * TARGET_RATE;
      let best = target;
      let bestLevel = Number.POSITIVE_INFINITY;
      const firstFrame = Math.max(0, Math.floor((target - searchRadius) / frameSize));
      const lastFrame = Math.min(levels.length - 1, Math.ceil((target + searchRadius) / frameSize));
      for (let frame = firstFrame; frame <= lastFrame; frame++) {
        const level = levels[frame] ?? Number.POSITIVE_INFINITY;
        if (level < bestLevel) {
          bestLevel = level;
          best = frame * frameSize;
        }
      }
      ranges.push({ from, to: best });
      from = best;
    }

    const previous = ranges[ranges.length - 1];
    // Nearby utterances belong in one request, while preserving a short pause.
    if (previous && from - previous.to < TARGET_RATE * 0.65 && paddedTo - previous.from <= maxSamples) {
      previous.to = paddedTo;
    } else {
      ranges.push({ from, to: paddedTo });
    }
  }

  return ranges;
}

function getAudioCtor(): typeof AudioContext {
  return (
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

function resampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_RATE) return input;
  const ratio = sourceRate / TARGET_RATE;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(input.length - 1, index + 1);
    const frac = position - index;
    output[i] = (input[index] ?? 0) * (1 - frac) + (input[next] ?? 0) * frac;
  }
  return output;
}

/**
 * Fallback for files the browser can play but cannot decode in one shot
 * (large files, or codecs unsupported by decodeAudioData). Captures the audio
 * graph while the media element plays back silently.
 */
async function captureViaPlayback(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<{ data: Float32Array; duration: number }> {
  const url = URL.createObjectURL(file);
  const media = document.createElement("video");
  media.src = url;
  media.preload = "auto";
  media.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      media.onloadedmetadata = () => resolve();
      media.onerror = () => reject(new Error("تعذّر تشغيل هذا الملف في المتصفح."));
    });

    const ctx = new (getAudioCtor())();
    const source = ctx.createMediaElementSource(media);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const silence = ctx.createGain();
    silence.gain.value = 0;
    source.connect(processor);
    processor.connect(silence);
    silence.connect(ctx.destination);

    const parts: Float32Array[] = [];
    let captured = 0;
    processor.onaudioprocess = (event) => {
      const frame = event.inputBuffer.getChannelData(0);
      parts.push(new Float32Array(frame));
      captured += frame.length;
      if (media.duration) onProgress?.(Math.min(1, captured / ctx.sampleRate / media.duration));
    };

    await ctx.resume();
    await media.play();
    await new Promise<void>((resolve) => {
      media.onended = () => resolve();
    });

    processor.onaudioprocess = null;
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    const rate = ctx.sampleRate;
    const duration = Number.isFinite(media.duration) ? media.duration : total / rate;
    void ctx.close();
    if (total === 0) throw new Error("لم يتم العثور على صوت في هذا الفيديو.");
    return { data: resampleTo16k(merged, rate), duration };
  } finally {
    media.pause();
    media.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes the media file's audio track and returns 16kHz mono WAV chunks.
 */
export async function extractAudioChunks(
  file: File,
  chunkSeconds = MAX_CHUNK_SECONDS,
  onProgress?: (ratio: number) => void,
): Promise<{ chunks: AudioChunk[]; duration: number }> {
  let data: Float32Array;
  let duration: number;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const decodeCtx = new (getAudioCtor())();
    let decoded: AudioBuffer;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      void decodeCtx.close();
    }
    duration = decoded.duration;
    const offline = new OfflineAudioContext(1, Math.ceil(duration * TARGET_RATE), TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    data = (await offline.startRendering()).getChannelData(0);
    onProgress?.(0.5);
  } catch {
    // Real-time capture is slower but works with any file the browser can play.
    const captured = await captureViaPlayback(file, (r) => onProgress?.(r * 0.9));
    data = captured.data;
    duration = captured.duration;
  }


  const chunks: AudioChunk[] = [];
  const detected = speechRanges(data);
  // Keep the argument as a hard upper bound for callers that request smaller chunks.
  const maxSamples = Math.max(TARGET_RATE, chunkSeconds * TARGET_RATE);
  const ranges = detected.flatMap(({ from, to }) => {
    const result: Array<{ from: number; to: number }> = [];
    for (let cursor = from; cursor < to; cursor += maxSamples) {
      result.push({ from: cursor, to: Math.min(cursor + maxSamples, to) });
    }
    return result;
  });
  const total = Math.max(1, ranges.length);
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range) continue;
    const slice = data.subarray(range.from, range.to);
    if (slice.length < TARGET_RATE * 0.2) continue;
    chunks.push({
      base64: toBase64(encodeWav(new Float32Array(slice), TARGET_RATE)),
      start: range.from / TARGET_RATE,
      duration: slice.length / TARGET_RATE,
    });
    onProgress?.((i + 1) / total);
  }

  return { chunks, duration };
}
