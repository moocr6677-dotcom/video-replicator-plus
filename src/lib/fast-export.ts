import { ArrayBufferTarget, Muxer, StreamTarget } from "mp4-muxer";
import { activeIndexAt, type Segment } from "@/lib/captions";
import { drawFrame, FRAME_H, FRAME_W, layoutBlocks, scrollTargetFor, type Block } from "@/lib/render-frame";

type VideoFrameCallbackEl = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

type SavePicker = (options: {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

export function fastExportSupported(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "AudioEncoder" in window;
}

/** Long exports are streamed straight to disk so memory never holds the whole MP4. */
async function pickSaveHandle(): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker({
      suggestedName: "video-with-captions.mp4",
      types: [{ description: "MP4", accept: { "video/mp4": [".mp4"] } }],
    });
  } catch {
    return null;
  }
}

async function pickVideoCodec(): Promise<string | null> {
  const candidates = ["avc1.640028", "avc1.4D0028", "avc1.42E01E"];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: FRAME_W,
        height: FRAME_H,
        bitrate: 5_000_000,
        framerate: 30,
      });
      if (support.supported) return codec;
    } catch {
      // try next
    }
  }
  return null;
}

async function decodeAudio(file: File): Promise<AudioBuffer | null> {
  try {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    void ctx.close();
    return buffer.numberOfChannels > 0 && buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Renders the captioned frame offline (faster than real time) with WebCodecs
 * and muxes it into an MP4, so the user does not have to sit through playback.
 */
export type ExportQuality = "small" | "high";

export async function fastExport(
  file: File,
  segments: Segment[],
  onProgress: (ratio: number) => void,
  speed = 16,
  quality: ExportQuality = "high",
): Promise<Blob | null> {
  const codec = await pickVideoCodec();
  if (!codec) throw new Error("متصفحك لا يدعم التصدير السريع.");

  const audioBuffer = await decodeAudio(file);

  const url = URL.createObjectURL(file);
  const video = document.createElement("video") as VideoFrameCallbackEl;
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Detached/hidden elements don't decode frames in some browsers, so keep a
  // 1px transparent element in the page while exporting.
  video.setAttribute("style", "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none");
  document.body.appendChild(video);

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("تعذّر قراءة الفيديو للتصدير."));
    });


    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const long = duration > 20 * 60;

    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("تعذّر تجهيز لوحة الرسم.");
    const blocks: Block[] = layoutBlocks(ctx, segments);

    // Long exports stream to a real file; short ones stay in memory as a blob.
    const handle = long ? await pickSaveHandle() : null;
    const writable = handle ? await handle.createWritable() : null;
    const bufferTarget = writable ? null : new ArrayBufferTarget();
    const target = writable
      ? new StreamTarget({
          onData: (data, position) => {
            void writable.write({ type: "write", position, data: data.slice().buffer as ArrayBuffer });
          },
        })
      : bufferTarget!;

    const muxer = new Muxer({
      target: target as ArrayBufferTarget,
      fastStart: writable ? false : "in-memory",
      video: { codec: "avc", width: FRAME_W, height: FRAME_H },
      ...(audioBuffer
        ? {
            audio: {
              codec: "aac" as const,
              sampleRate: audioBuffer.sampleRate,
              numberOfChannels: Math.min(2, audioBuffer.numberOfChannels),
            },
          }
        : {}),
    });

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error(e),
    });
    const videoBitrate =
      quality === "small" ? (long ? 700_000 : 900_000) : long ? 2_200_000 : 5_000_000;
    videoEncoder.configure({
      codec,
      width: FRAME_W,
      height: FRAME_H,
      bitrate: videoBitrate,
      framerate: 30,
    });

    // ---- video pass: play fast, encode each decoded frame with real timestamps
    let scroll = 0;
    let frames = 0;
    let lastTs = -1;

    const encodeCurrent = () => {
      const t = video.currentTime;
      const tsUs = Math.round(t * 1_000_000);
      if (tsUs <= lastTs) return;
      lastTs = tsUs;
      const index = activeIndexAt(segments, t);
      const want = scrollTargetFor(blocks, index, aspect);
      scroll += (want - scroll) * 0.35;
      if (Math.abs(want - scroll) < 0.5) scroll = want;
      drawFrame(ctx, { video, videoAspect: aspect, blocks, activeIndex: index, scroll });
      const frame = new VideoFrame(canvas, { timestamp: tsUs, duration: 33_333 });
      videoEncoder.encode(frame, { keyFrame: frames % 60 === 0 });
      frame.close();
      frames += 1;
      if (duration) onProgress(Math.min(0.9, (t / duration) * 0.9));
    };

    video.playbackRate = speed;
    video.currentTime = 0;
    await video.play().catch(() => undefined);

    await new Promise<void>((resolve) => {
      let stopped = false;
      const finish = () => {
        if (stopped) return;
        stopped = true;
        resolve();
      };
      video.onended = finish;
      const useRvfc = typeof video.requestVideoFrameCallback === "function";
      const tick = () => {
        if (stopped) return;
        encodeCurrent();
        if (video.ended) return finish();
        if (useRvfc) video.requestVideoFrameCallback!(tick);
        else requestAnimationFrame(tick);
      };
      if (useRvfc) video.requestVideoFrameCallback!(tick);
      else requestAnimationFrame(tick);
    });

    video.pause();
    await videoEncoder.flush();
    videoEncoder.close();

    // ---- audio pass
    if (audioBuffer) {
      const channels = Math.min(2, audioBuffer.numberOfChannels);
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error(e),
      });
      audioEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: channels,
        bitrate: quality === "small" ? 64_000 : 128_000,
      });

      const CHUNK = 4096;
      const total = audioBuffer.length;
      const left = audioBuffer.getChannelData(0);
      const right = channels > 1 ? audioBuffer.getChannelData(1) : null;
      for (let offset = 0; offset < total; offset += CHUNK) {
        const size = Math.min(CHUNK, total - offset);
        const data = new Float32Array(size * channels);
        for (let i = 0; i < size; i++) {
          data[i * channels] = left[offset + i] ?? 0;
          if (right) data[i * channels + 1] = right[offset + i] ?? 0;
        }
        const audioData = new AudioData({
          format: "f32",
          sampleRate: audioBuffer.sampleRate,
          numberOfFrames: size,
          numberOfChannels: channels,
          timestamp: Math.round((offset / audioBuffer.sampleRate) * 1_000_000),
          data,
        });
        audioEncoder.encode(audioData);
        audioData.close();
        if (offset % (CHUNK * 40) === 0) await new Promise((r) => setTimeout(r, 0));
        onProgress(0.9 + (offset / total) * 0.09);
      }
      await audioEncoder.flush();
      audioEncoder.close();
    }

    muxer.finalize();
    if (writable) {
      await writable.close();
      onProgress(1);
      return null;
    }
    onProgress(1);
    return new Blob([bufferTarget!.buffer], { type: "video/mp4" });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
