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

  // Keeps the export alive while the user switches away / the screen dims.
  const lockRef: { current: { release: () => Promise<void> } | null } = { current: null };
  const requestWakeLock = async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      lockRef.current = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      lockRef.current = null;
    }
  };
  const onVisible = () => {
    if (!document.hidden) void requestWakeLock();
  };
  document.addEventListener("visibilitychange", onVisible);
  await requestWakeLock();

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
    let pendingWrite: Promise<void> = Promise.resolve();
    let writeError: Error | null = null;
    const bufferTarget = writable ? null : new ArrayBufferTarget();
    const target = writable
      ? new StreamTarget({
          onData: (data, position) => {
            const chunk = data.slice();
            pendingWrite = pendingWrite
              .then(() => writable.write({ type: "write", position, data: chunk }))
              .catch((error: unknown) => {
                writeError = error instanceof Error ? error : new Error(String(error));
              });
          },
          // Accumulate small muxer writes into larger chunks. This avoids
          // creating thousands of simultaneous disk writes on long videos.
          chunked: true,
          chunkSize: 2 ** 22,
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

    let encoderError: Error | null = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (e) {
          encoderError = e instanceof Error ? e : new Error(String(e));
        }
      },
      error: (e) => {
        encoderError = e instanceof Error ? e : new Error(String(e));
      },
    });
    const videoBitrate =
      quality === "small" ? (long ? 1_200_000 : 1_800_000) : long ? 8_000_000 : 14_000_000;
    videoEncoder.configure({
      codec,
      width: FRAME_W,
      height: FRAME_H,
      bitrate: videoBitrate,
      bitrateMode: "variable",
      latencyMode: "quality",
      framerate: 30,
    });


    // ---- video pass: play fast, encode each decoded frame with real timestamps
    let scroll = 0;
    let frames = 0;
    let lastTs = -1;
    let baseTs: number | null = null;
    let lastEncodedTs = -1;
    let lastFrameAt = performance.now();
    let throttled = false;

    const encodeCurrent = () => {
      const t = video.currentTime;
      const rawUs = Math.round(t * 1_000_000);
      if (rawUs <= lastTs) return;
      lastTs = rawUs;
      lastFrameAt = performance.now();
      const index = activeIndexAt(segments, t);
      const want = scrollTargetFor(blocks, index, aspect);
      scroll += (want - scroll) * 0.35;
      if (Math.abs(want - scroll) < 0.5) scroll = want;
      drawFrame(ctx, { video, videoAspect: aspect, blocks, activeIndex: index, scroll });

      // Backpressure: slow the source down instead of dropping frames. Dropping
      // frames is what made motion look choppy in the exported file.
      const queue = videoEncoder.encodeQueueSize;
      if (!throttled && queue > 10) {
        throttled = true;
        video.pause();
      } else if (throttled && queue < 4) {
        throttled = false;
        void video.play().catch(() => undefined);
      }

      // The muxer requires the first chunk to start at timestamp 0, so all
      // timestamps are rebased on the first frame we actually encode.
      if (baseTs === null) baseTs = rawUs;
      const tsUs = Math.max(0, rawUs - baseTs);
      // Real gap between frames keeps playback speed identical to the source
      // (variable frame rate) so picture and audio stay locked together.
      const gap = lastEncodedTs < 0 ? 33_333 : Math.min(200_000, Math.max(8_000, tsUs - lastEncodedTs));
      lastEncodedTs = tsUs;
      const frame = new VideoFrame(canvas, { timestamp: tsUs, duration: gap });
      videoEncoder.encode(frame, { keyFrame: frames % 60 === 0 });
      frame.close();
      frames += 1;
      if (duration) onProgress(Math.min(0.9, (t / duration) * 0.9));
    };


    video.currentTime = 0;
    try {
      video.playbackRate = speed;
    } catch {
      video.playbackRate = 4;
    }
    await video.play().catch(() => undefined);
    if (video.paused) throw new Error("تعذّر تشغيل الفيديو للتصدير السريع.");

    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      const finish = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(watchdog);
        resolve();
      };
      const fail = (err: Error) => {
        if (stopped) return;
        stopped = true;
        clearInterval(watchdog);
        reject(err);
      };
      // If decoding stalls for 30s we bail out so the caller can fall back to
      // the normal (real-time) recording path instead of hanging forever.
      const watchdog = setInterval(() => {
        if (encoderError) return fail(encoderError);
        if (video.ended) return finish();
        if (performance.now() - lastFrameAt > 30_000) {
          fail(new Error("توقّف فك ترميز الفيديو أثناء التصدير السريع."));
        } else if (video.paused && !throttled) {
          void video.play().catch(() => undefined);
        }
      }, 1000);

      video.onended = finish;
      const useRvfc = typeof video.requestVideoFrameCallback === "function";
      const tick = () => {
        if (stopped) return;
        try {
          encodeCurrent();
        } catch (e) {
          return fail(e instanceof Error ? e : new Error(String(e)));
        }
        if (video.ended) return finish();
        // rAF/rVFC are frozen while the tab is hidden, so a timer keeps the
        // export running in the background instead of pausing.
        if (document.hidden) setTimeout(tick, 0);
        else if (useRvfc) video.requestVideoFrameCallback!(tick);
        else requestAnimationFrame(tick);
      };
      tick();
    });


    if (encoderError) throw encoderError;
    if (frames === 0) throw new Error("لم يتم التقاط أي إطار أثناء التصدير السريع.");


    video.pause();
    await videoEncoder.flush();
    videoEncoder.close();

    // ---- audio pass
    if (audioBuffer) {
      const channels = Math.min(2, audioBuffer.numberOfChannels);
      let audioEncoderError: Error | null = null;
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          audioEncoderError = e instanceof Error ? e : new Error(String(e));
        },
      });
      audioEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: channels,
        bitrate: quality === "small" ? 96_000 : 192_000,
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
        // Do not queue an entire multi-hour audio track in AudioEncoder.
        // Draining periodically keeps memory stable and prevents a very long
        // final flush that appeared to users as a permanent stop at 99%.
        if (audioEncoder.encodeQueueSize > 24) await audioEncoder.flush();
        if (audioEncoderError) throw audioEncoderError;
        if (offset % (CHUNK * 40) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        onProgress(0.9 + (offset / total) * 0.085);
      }
      await audioEncoder.flush();
      if (audioEncoderError) throw audioEncoderError;
      audioEncoder.close();
    }

    onProgress(0.99);
    muxer.finalize();
    if (writable) {
      await pendingWrite;
      if (writeError) throw writeError;
      await writable.close();
      onProgress(1);
      return null;
    }
    onProgress(1);
    return new Blob([bufferTarget!.buffer], { type: "video/mp4" });
  } finally {
    document.removeEventListener("visibilitychange", onVisible);
    void lockRef.current?.release().catch(() => undefined);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();

    URL.revokeObjectURL(url);
  }
}
