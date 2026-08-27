import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { activeIndexAt, formatTime, type Segment } from "@/lib/captions";
import {
  AR_FONT,
  blockIndexAtY,
  drawFrame,
  FRAME_H,
  FRAME_W,
  layoutBlocks,
  ORIG_FONT,
  scrollTargetFor,
  type Block,
} from "@/lib/render-frame";

type Props = {
  videoFile: File;
  segments: Segment[];
  onReset: () => void;
};

function normalizedVideoType(file: File): string {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (name.endsWith(".mp4") || name.endsWith(".m4v") || name.endsWith(".mov")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (type.startsWith("video/")) return type;
  return "video/mp4";
}

function pickMimeType(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}

export function CaptionPlayer({ videoFile, segments, onReset }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const blocksRef = useRef<Block[]>([]);
  const scrollRef = useRef(0);
  const activeRef = useRef(0);
  const aspectRef = useRef(16 / 9);
  const audioRef = useRef<{ ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  // Some Android file pickers return MP4 files as application/octet-stream (or
  // with an empty type). A blob URL preserves that wrong type and Chrome then
  // reports MEDIA_ERR_SRC_NOT_SUPPORTED even when the bytes are valid MP4.
  useEffect(() => {
    const source =
      attempt === 0
        ? videoFile.slice(0, videoFile.size, normalizedVideoType(videoFile))
        : videoFile;
    const url = URL.createObjectURL(source);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile, attempt]);


  // Layout + render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let cancelled = false;

    const relayout = () => {
      blocksRef.current = layoutBlocks(ctx, segments);
    };

    const ready = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (ready) {
      void Promise.all([ready.load(ORIG_FONT), ready.load(AR_FONT)])
        .catch(() => undefined)
        .then(() => !cancelled && relayout());
    }
    relayout();

    const loop = () => {
      if (video.videoWidth && video.videoHeight) {
        aspectRef.current = video.videoWidth / video.videoHeight;
      }
      const index = activeIndexAt(segments, video.currentTime);
      activeRef.current = index;
      const target = scrollTargetFor(blocksRef.current, index, aspectRef.current);
      scrollRef.current += (target - scrollRef.current) * 0.12;
      if (Math.abs(target - scrollRef.current) < 0.5) scrollRef.current = target;

      drawFrame(ctx, {
        video,
        videoAspect: aspectRef.current,
        blocks: blocksRef.current,
        activeIndex: index,
        scroll: scrollRef.current,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [segments]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const handleCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video || recording) return;
      const rect = canvas.getBoundingClientRect();
      const y = ((event.clientY - rect.top) / rect.height) * FRAME_H;
      const index = blockIndexAtY(blocksRef.current, y, scrollRef.current, aspectRef.current);
      if (index >= 0) {
        const segment = segments[index];
        if (segment) video.currentTime = segment.start;
      } else {
        togglePlay();
      }
    },
    [recording, segments, togglePlay],
  );

  const ensureAudioGraph = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    if (!audioRef.current) {
      const AudioCtor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtor();
      const source = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      source.connect(ctx.destination);
      source.connect(dest);
      audioRef.current = { ctx, dest };
    }
    void audioRef.current.ctx.resume();
    return audioRef.current;
  }, []);

  const startRecording = useCallback(async () => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || recording) return;

    const audio = ensureAudioGraph();
    const stream = canvas.captureStream(30);
    audio?.dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    const parts: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(parts, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `video-with-captions.${mimeType.includes("mp4") ? "mp4" : "webm"}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        resolve();
      };
    });

    video.pause();
    video.currentTime = 0;
    scrollRef.current = 0;
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
    });

    setRecording(true);
    setRecordProgress(0);
    recorder.start(1000);
    await video.play();

    const onEnded = () => {
      video.removeEventListener("ended", onEnded);
      if (recorder.state !== "inactive") recorder.stop();
    };
    video.addEventListener("ended", onEnded);

    await finished;
    setRecording(false);
    setRecordProgress(1);
  }, [ensureAudioGraph, recording]);

  return (
    <div className="mx-auto w-full max-w-[420px] px-3 pb-10">
      {/* Kept in the layout (1px, transparent) instead of display:none — hidden videos
          don't decode frames on iOS/Safari, which produced a black canvas. */}
      <video
        ref={videoRef}
        src={videoUrl ?? undefined}
        playsInline
        preload="auto"
        controls={false}
        className="pointer-events-none absolute h-px w-px opacity-0"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setTime(el.currentTime);
          if (recording && el.duration) setRecordProgress(el.currentTime / el.duration);
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setDuration(el.duration);
          setLoadError(null);
        }}
        onLoadedData={(e) => {
          const el = e.currentTarget;
          setLoadError(null);
          // Seek only after the first frame is available; seeking during
          // metadata loading can abort the source on some Android devices.
          if (el.currentTime === 0 && el.duration > 0.01) el.currentTime = 0.01;
        }}
        onError={(e) => {
          const code = e.currentTarget.error?.code ?? 0;
          // Retry once with the untouched File. This covers both incorrect MIME
          // metadata and transient blob-source failures on memory-constrained phones.
          if (attempt < 1) {
            setLoadError(null);
            setAttempt((n) => n + 1);
            return;
          }
          setLoadError(
            code === 4
              ? "صيغة الفيديو الداخلية غير مدعومة في Chrome. حوّل الفيديو إلى MP4 بترميز H.264 ثم ارفعه مرة أخرى."
              : "تعذّر تحميل الفيديو. اضغط «فيديو جديد» وأعد المحاولة، أو افتح الموقع من Chrome.",
          );
        }}
      />

      {loadError ? <p className="mb-3 text-center text-sm text-destructive">{loadError}</p> : null}


      <canvas
        ref={canvasRef}
        width={FRAME_W}
        height={FRAME_H}
        onClick={handleCanvasClick}
        className="w-full cursor-pointer rounded-xl border border-border shadow-sm"
        style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}
      />

      <div className="mt-4 flex items-center gap-2">
        <Button size="icon" onClick={togglePlay} disabled={recording} aria-label={playing ? "إيقاف" : "تشغيل"}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          {formatTime(time)} / {formatTime(duration)}
        </span>
        <div className="ms-auto flex gap-2">
          <Button variant="outline" size="icon" onClick={onReset} disabled={recording} aria-label="فيديو جديد">
            <RotateCcw className="size-4" />
          </Button>
          <Button onClick={() => void startRecording()} disabled={recording}>
            <Download className="size-4" />
            {recording ? `جارٍ التسجيل ${Math.round(recordProgress * 100)}%` : "تحميل الفيديو"}
          </Button>
        </div>
      </div>

      {recording ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          سيبه يكمّل للآخر من غير ما تقفل الصفحة — التسجيل بياخد نفس مدة الفيديو.
        </p>
      ) : null}
    </div>
  );
}
