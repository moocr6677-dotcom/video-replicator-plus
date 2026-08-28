import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CaptionPlayer } from "@/components/CaptionPlayer";
import { extractAudioChunks } from "@/lib/audio";
import { segmentsFromChunk, type Segment } from "@/lib/captions";
import { parseTranscript } from "@/lib/parse-transcript";
import { transcribeChunk, translateBatch } from "@/lib/transcribe.functions";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ترجمة الفيديو تلقائيًا | نص أصلي + ترجمة عربية" },
      {
        name: "description",
        content:
          "ارفع أي فيديو ليتحوّل صوته إلى نص بلغته الأصلية مع ترجمة عربية متزامنة، ثم حمّل الفيديو النهائي بالنص المدمج.",
      },
      { property: "og:title", content: "ترجمة الفيديو تلقائيًا | نص أصلي + ترجمة عربية" },
      {
        property: "og:description",
        content: "تفريغ صوتي وترجمة عربية متزامنة لأي فيديو، مع تحميل الفيديو النهائي بالنص.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const MAX_SECONDS = 10 * 60;

type Phase = "idle" | "audio" | "transcribe" | "translate" | "ready";

function Index() {
  const inputRef = useRef<HTMLInputElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [manualText, setManualText] = useState("");
  const [manualFile, setManualFile] = useState<File | null>(null);

  const transcribe = useServerFn(transcribeChunk);
  const translate = useServerFn(translateBatch);

  const reset = useCallback(() => {
    setVideoFile(null);
    setSegments([]);
    setPhase("idle");
    setProgress(0);
    setError(null);
    setManualFile(null);
    setManualText("");
  }, []);

  const handleManual = useCallback(async () => {
    setError(null);
    if (!manualFile) {
      setError("اختر ملف الفيديو أولًا.");
      return;
    }
    const parsed = parseTranscript(manualText);
    if (parsed.length === 0) {
      setError("لم أتمكن من قراءة التوقيتات. استخدم صيغة SRT أو أسطر مثل: 00:12 النص هنا");
      return;
    }

    setVideoFile(manualFile);
    setSegments(parsed);
    setPhase("translate");
    setProgress(0);

    try {
      const BATCH = 25;
      for (let i = 0; i < parsed.length; i += BATCH) {
        const slice = parsed.slice(i, i + BATCH);
        const { translations } = await translate({ data: { lines: slice.map((s) => s.text) } });
        translations.forEach((ar, index) => {
          const target = parsed[i + index];
          if (target) target.ar = ar;
        });
        setSegments([...parsed]);
        setProgress(Math.min(1, (i + BATCH) / parsed.length));
      }
    } catch {
      // Translation is optional here — the pasted transcript still plays.
    }
    setPhase("ready");
  }, [manualFile, manualText, translate]);


  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setProgress(0);

      try {
        setPhase("audio");
        const { chunks, duration } = await extractAudioChunks(file, 18, (r) => setProgress(r * 0.2));
        if (duration > MAX_SECONDS) {
          throw new Error("الفيديو أطول من 10 دقائق. جرّب فيديو أقصر.");
        }
        if (chunks.length === 0) throw new Error("لم يتم العثور على صوت في هذا الفيديو.");

        setPhase("transcribe");
        const texts = new Array<string>(chunks.length).fill("");
        let done = 0;
        let cursor = 0;
        const CONCURRENCY = 2;
        const worker = async () => {
          while (cursor < chunks.length) {
            const index = cursor++;
            const chunk = chunks[index]!;
            const { text } = await transcribe({ data: { base64: chunk.base64 } });
            texts[index] = text ?? "";
            done += 1;
            setProgress(0.2 + (done / chunks.length) * 0.5);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

        const collected: Segment[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const text = texts[i];
          if (text) collected.push(...segmentsFromChunk(text, chunk.start, chunk.duration, collected.length));
        }

        if (collected.length === 0) throw new Error("تعذّر استخراج النص من هذا الفيديو.");

        setVideoFile(file);
        setSegments(collected);

        setPhase("translate");
        const BATCH = 25;
        for (let i = 0; i < collected.length; i += BATCH) {
          const slice = collected.slice(i, i + BATCH);
          const { translations } = await translate({ data: { lines: slice.map((s) => s.text) } });
          translations.forEach((ar, index) => {
            const target = collected[i + index];
            if (target) target.ar = ar;
          });
          setSegments([...collected]);
          setProgress(0.7 + Math.min(1, (i + BATCH) / collected.length) * 0.3);
        }

        setPhase("ready");
      } catch (err) {
        setVideoFile(null);
        setPhase("idle");
        setError(err instanceof Error ? err.message : "حصل خطأ غير متوقع.");
      }
    },
    [transcribe, translate],
  );

  const busy = phase === "audio" || phase === "transcribe" || phase === "translate";
  const phaseLabel =
    phase === "audio"
      ? "جارٍ استخراج الصوت…"
      : phase === "transcribe"
        ? "جارٍ تفريغ النص…"
        : phase === "translate"
          ? "جارٍ الترجمة للعربية…"
          : "";

  return (
    <main dir="rtl" className="min-h-screen bg-background py-8">
      <header className="mx-auto max-w-[420px] px-4 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">فيديو بنص وترجمة عربية</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          ارفع أي فيديو، والتطبيق يستخرج النص بلغته الأصلية ويضيف الترجمة العربية تحته — ثم حمّله بالنص مدمج.
        </p>
      </header>

      <section className="mt-6">
        {phase === "ready" && videoFile ? (
          <CaptionPlayer videoFile={videoFile} segments={segments} onReset={reset} />
        ) : (
          <div className="mx-auto max-w-[420px] px-4">
            {!busy ? (
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
                <Button
                  variant={mode === "auto" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => {
                    setMode("auto");
                    setError(null);
                  }}
                >
                  استخراج تلقائي
                </Button>
                <Button
                  variant={mode === "manual" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => {
                    setMode("manual");
                    setError(null);
                  }}
                >
                  ألصق النص بالتوقيت
                </Button>
              </div>
            ) : null}

            <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center">
              {busy ? (
                <div className="space-y-4">
                  <Loader2 className="mx-auto size-8 animate-spin text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">{phaseLabel}</p>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                </div>
              ) : mode === "auto" ? (
                <div className="space-y-4">
                  <Upload className="mx-auto size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">اختر ملف فيديو (حتى 10 دقائق)</p>
                  <Button onClick={() => inputRef.current?.click()}>اختيار فيديو</Button>
                </div>
              ) : (
                <div className="space-y-4 text-right">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-muted-foreground">
                      {manualFile ? manualFile.name : "لم يتم اختيار فيديو"}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => manualInputRef.current?.click()}>
                      اختيار فيديو
                    </Button>
                  </div>
                  <Textarea
                    dir="auto"
                    rows={10}
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    placeholder={"00:00 --> 00:04\nErster Satz hier\n\n00:04 --> 00:08\nZweiter Satz hier"}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    مدعوم: SRT / VTT أو أسطر مثل «00:12 النص هنا». الترجمة العربية تتولّد تلقائيًا.
                  </p>
                  <Button className="w-full" onClick={() => void handleManual()}>
                    عرض الفيديو بالنص
                  </Button>
                </div>
              )}
            </div>
            {error ? <p className="mt-4 text-center text-sm text-destructive">{error}</p> : null}
          </div>
        )}
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleFile(file);
        }}
      />
      <input
        ref={manualInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) setManualFile(file);
        }}
      />

    </main>
  );
}
