import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

async function gatewayError(res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  if (res.status === 402) throw new Error("رصيد الذكاء الاصطناعي غير كافٍ. أضف رصيدًا من إعدادات مساحة العمل.");
  if (res.status === 403) throw new Error("الذكاء الاصطناعي غير مفعّل لمساحة العمل هذه.");
  if (res.status === 429) throw new Error("الطلبات كثيرة حاليًا، حاول بعد قليل.");
  throw new Error(`فشل الطلب [${res.status}]: ${body.slice(0, 300)}`);
}

/** Transcribes one WAV chunk (base64) in its original language. */
export const transcribeChunk = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ base64: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const form = new FormData();
    form.append("model", "openai/gpt-4o-transcribe");
    form.append("file", new Blob([base64ToBytes(data.base64)], { type: "audio/wav" }), "chunk.wav");

    const res = await fetch(`${GATEWAY}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) await gatewayError(res);
    const json = (await res.json()) as { text?: string };
    return { text: (json.text ?? "").trim() };
  });

/** Translates a batch of sentences into Arabic, keeping index alignment. */
export const translateBatch = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ lines: z.array(z.string()).min(1).max(60) }).parse(input))
  .handler(async ({ data }) => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const res = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.7-flash",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You translate subtitle lines into natural Modern Standard Arabic. " +
              'Reply ONLY with JSON: {"items":[{"i":0,"ar":"..."}]} — one item per input line, same indexes, same count. ' +
              "Never merge, split, skip or add lines. Keep the tone conversational.",
          },
          {
            role: "user",
            content: JSON.stringify({ lines: data.lines.map((text, i) => ({ i, text })) }),
          },
        ],
      }),
    });
    if (!res.ok) await gatewayError(res);

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? "{}";
    let items: Array<{ i: number; ar: string }> = [];
    try {
      const parsed = JSON.parse(content) as { items?: Array<{ i: number; ar: string }> };
      items = parsed.items ?? [];
    } catch {
      items = [];
    }

    const out = data.lines.map(() => "");
    for (const item of items) {
      if (typeof item?.i === "number" && item.i >= 0 && item.i < out.length) {
        out[item.i] = String(item.ar ?? "");
      }
    }
    return { translations: out };
  });
