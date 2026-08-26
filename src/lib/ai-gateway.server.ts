const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const MAX_ATTEMPTS = 4;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(1_000, dateDelay);
  }
  return Math.min(12_000, 1_500 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function messageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: { message?: string } };
    return parsed.message ?? parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

async function terminalError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  const detail = messageFromBody(body).slice(0, 500);
  if (response.status === 401) throw new Error("إعداد خدمة الذكاء الاصطناعي غير صالح حاليًا.");
  if (response.status === 402) throw new Error(detail || "رصيد الذكاء الاصطناعي غير كافٍ. أضف رصيدًا من إعدادات مساحة العمل.");
  if (response.status === 403) throw new Error(detail || "الذكاء الاصطناعي غير مفعّل لمساحة العمل هذه.");
  if (response.status === 404) throw new Error("خدمة التفريغ الصوتي غير متاحة لمساحة العمل هذه.");
  if (response.status === 429) throw new Error(detail || "الطلبات كثيرة حاليًا. انتظر قليلًا ثم حاول مرة أخرى.");
  throw new Error(detail || `فشل الطلب [${response.status}]`);
}

async function fetchWithBackoff(path: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`${GATEWAY}${path}`, init);
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS - 1) await terminalError(response);
    const delay = retryDelay(response, attempt);
    await response.body?.cancel().catch(() => undefined);
    await wait(delay);
  }
  throw new Error("تعذّر إكمال الطلب بعد عدة محاولات.");
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

export async function requestTranscription(base64: string, key: string, prompt?: string): Promise<string> {
  const form = new FormData();
  form.append("model", "openai/gpt-4o-transcribe");
  form.append("file", new Blob([base64ToBytes(base64)], { type: "audio/wav" }), "chunk.wav");
  if (prompt) form.append("prompt", prompt.slice(-800));

  const response = await fetchWithBackoff("/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const json = (await response.json()) as { text?: string };
  return (json.text ?? "").trim();
}

export async function requestTranslations(lines: string[], key: string): Promise<string[]> {
  const response = await fetchWithBackoff("/chat/completions", {
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
        { role: "user", content: JSON.stringify({ lines: lines.map((text, i) => ({ i, text })) }) },
      ],
    }),
  });

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? "{}";
  let items: Array<{ i: number; ar: string }> = [];
  try {
    const parsed = JSON.parse(content) as { items?: Array<{ i: number; ar: string }> };
    items = parsed.items ?? [];
  } catch {
    items = [];
  }

  const output = lines.map(() => "");
  for (const item of items) {
    if (typeof item?.i === "number" && item.i >= 0 && item.i < output.length) {
      output[item.i] = String(item.ar ?? "");
    }
  }
  return output;
}
