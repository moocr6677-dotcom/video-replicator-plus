/** Shared caption types and browser-safe helpers. */

export type Segment = {
  id: number;
  start: number;
  end: number;
  /** Original-language sentence. */
  text: string;
  /** Arabic translation. */
  ar: string;
};

/** Splits a transcript chunk into sentences and spreads timings by text length. */
export function segmentsFromChunk(text: string, start: number, duration: number, idOffset: number): Segment[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…؟])\s+/)
    .flatMap((sentence) => (sentence.length > 180 ? sentence.split(/(?<=,)\s+/) : [sentence]))
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return [];

  const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
  let cursor = start;
  return parts.map((sentence, index) => {
    const span = (sentence.length / totalChars) * duration;
    const segment: Segment = {
      id: idOffset + index,
      start: cursor,
      end: cursor + span,
      text: sentence,
      ar: "",
    };
    cursor += span;
    return segment;
  });
}

export function activeIndexAt(segments: Segment[], time: number): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg && time >= seg.start) return i;
  }
  return 0;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
