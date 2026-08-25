import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requestTranscription, requestTranslations } from "./ai-gateway.server";

/** Transcribes one WAV chunk (base64) in its original language. */
export const transcribeChunk = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ base64: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    return { text: await requestTranscription(data.base64, key) };
  });

/** Translates a batch of sentences into Arabic, keeping index alignment. */
export const translateBatch = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ lines: z.array(z.string()).min(1).max(60) }).parse(input))
  .handler(async ({ data }) => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    return { translations: await requestTranslations(data.lines, key) };
  });
