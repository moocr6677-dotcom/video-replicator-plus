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

/**
 * Decodes the media file's audio track and returns 16kHz mono WAV chunks.
 */
export async function extractAudioChunks(
  file: File,
  chunkSeconds = MAX_CHUNK_SECONDS,
  onProgress?: (ratio: number) => void,
): Promise<{ chunks: AudioChunk[]; duration: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error("تعذّر قراءة صوت هذا الملف. جرّب فيديو MP4 يحتوي على صوت، أو افتح الموقع من متصفح Chrome.");
  } finally {
    void decodeCtx.close();
  }

  const duration = decoded.duration;
  const offline = new OfflineAudioContext(1, Math.ceil(duration * TARGET_RATE), TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = await offline.startRendering();
  const data = mono.getChannelData(0);

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
