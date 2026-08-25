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

/**
 * Decodes the media file's audio track and returns 16kHz mono WAV chunks.
 */
export async function extractAudioChunks(
  file: File,
  chunkSeconds = 45,
  onProgress?: (ratio: number) => void,
): Promise<{ chunks: AudioChunk[]; duration: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
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
  const samplesPerChunk = chunkSeconds * TARGET_RATE;
  const total = Math.max(1, Math.ceil(data.length / samplesPerChunk));
  for (let i = 0; i < total; i++) {
    const slice = data.subarray(i * samplesPerChunk, Math.min((i + 1) * samplesPerChunk, data.length));
    if (slice.length < TARGET_RATE * 0.2) continue;
    chunks.push({
      base64: toBase64(encodeWav(new Float32Array(slice), TARGET_RATE)),
      start: (i * samplesPerChunk) / TARGET_RATE,
      duration: slice.length / TARGET_RATE,
    });
    onProgress?.((i + 1) / total);
  }

  return { chunks, duration };
}
