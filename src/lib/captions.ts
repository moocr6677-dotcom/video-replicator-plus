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

/** Splits a pause-aligned transcript chunk and estimates timing by spoken words. */
export function segmentsFromChunk(text: string, start: number, duration: number, idOffset: number): Segment[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…؟])\s+/)
    .flatMap((sentence) => (sentence.length > 180 ? sentence.split(/(?<=,)\s+/) : [sentence]))
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return [];

  const weights = parts.map((part) => Math.max(1, part.split(/\s+/).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start;
  return parts.map((sentence, index) => {
    const span = ((weights[index] ?? 1) / totalWeight) * duration;
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
