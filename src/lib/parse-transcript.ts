import type { Segment } from "./captions";

/** Parses "hh:mm:ss,mmm" / "mm:ss.mmm" / "90.5" into seconds. */
function toSeconds(raw: string): number | null {
  const value = raw.trim().replace(",", ".");
  if (!value) return null;
  const parts = value.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

const RANGE = /(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*(?:-->|-|–|—|>)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)/;
const START_ONLY = /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\)?\]?\s*[-–—:]?\s*(.*)$/;

type Raw = { start: number; end: number | null; lines: string[] };

const ARABIC = /[؀-ۿ]/;

/** Splits cue lines into original text and a ready-made Arabic translation. */
function splitBilingual(lines: string[]): { text: string; ar: string } {
  const original: string[] = [];
  const arabic: string[] = [];
  for (const line of lines) {
    // Explicit separator: "Original || العربية"
    if (line.includes("||")) {
      const [a, b] = line.split("||", 2);
      if (a?.trim()) original.push(a.trim());
      if (b?.trim()) arabic.push(b.trim());
      continue;
    }
    (ARABIC.test(line) ? arabic : original).push(line);
  }
  return { text: original.join(" "), ar: arabic.join(" ") };
}

/**
 * Parses a pasted transcript. Supports SRT, WebVTT, "00:12 --> 00:15" ranges,
 * and simple "00:12 text" lines. Timings come from the pasted text as-is.
 */
export function parseTranscript(input: string, fallbackDuration = 0): Segment[] {
  const lines = input.replace(/\r/g, "").split("\n");
  const raws: Raw[] = [];
  let pending: Raw | null = null;

  const push = () => {
    if (pending && pending.lines.some((l) => l.trim())) raws.push(pending);
    pending = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^WEBVTT/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue; // SRT cue index

    const range = trimmed.match(RANGE);
    if (range) {
      push();
      const start = toSeconds(range[1]!);
      const end = toSeconds(range[2]!);
      if (start === null) continue;
      const rest = trimmed.slice((range.index ?? 0) + range[0].length).trim();
      pending = { start, end, lines: rest ? [rest] : [] };
      continue;
    }

    const startOnly = trimmed.match(START_ONLY);
    if (startOnly && /^\[?\(?\d{1,2}:\d{2}/.test(trimmed)) {
      push();
      const start = toSeconds(startOnly[1]!);
      if (start === null) continue;
      const rest = (startOnly[2] ?? "").trim();
      pending = { start, end: null, lines: rest ? [rest] : [] };
      continue;
    }

    if (pending) pending.lines.push(trimmed);
  }
  push();

  raws.sort((a, b) => a.start - b.start);

  return raws.map((raw, index) => {
    const next = raws[index + 1];
    const end = raw.end ?? next?.start ?? Math.max(raw.start + 3, fallbackDuration);
    const { text, ar } = splitBilingual(raw.lines);
    return {
      id: index,
      start: raw.start,
      end: Math.max(end, raw.start + 0.3),
      text,
      ar,
    } satisfies Segment;
  });
}
