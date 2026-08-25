/** Canvas renderer that draws the reference layout: video on top, bilingual transcript below. */
import type { Segment } from "./captions";

export const FRAME_W = 720;
export const FRAME_H = 1052;

const PAPER = "#FCFBF8";
const INK = "#141414";
const MUTED = "#6E6E6E";
const HIGHLIGHT = "#E9F0E6";

const PAD_X = 16;
const CARD_W = FRAME_W - PAD_X * 2;
const TEXT_RIGHT = FRAME_W - 40;
const TEXT_W = CARD_W - 48;
const ORIG_LINE = 42;
const AR_LINE = 34;
const BLOCK_PAD_Y = 22;
const BLOCK_GAP = 6;

export const ORIG_FONT = '700 30px Roboto, "Helvetica Neue", Arial, sans-serif';
export const AR_FONT = '400 22px Cairo, "Segoe UI", Tahoma, sans-serif';

export type Block = {
  top: number;
  height: number;
  origLines: string[];
  arLines: string[];
};

function wrap(ctx: CanvasRenderingContext2D, text: string, font: string, maxWidth: number): string[] {
  ctx.font = font;
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function layoutBlocks(ctx: CanvasRenderingContext2D, segments: Segment[]): Block[] {
  let top = 0;
  return segments.map((segment) => {
    const origLines = wrap(ctx, segment.text, ORIG_FONT, TEXT_W);
    const arLines = segment.ar ? wrap(ctx, segment.ar, AR_FONT, TEXT_W) : [];
    const height =
      BLOCK_PAD_Y * 2 + origLines.length * ORIG_LINE + (arLines.length ? 6 + arLines.length * AR_LINE : 0);
    const block: Block = { top, height, origLines, arLines };
    top += height + BLOCK_GAP;
    return block;
  });
}

export function videoRect(videoAspect: number) {
  const w = FRAME_W - 40;
  const h = Math.round(w / (videoAspect || 16 / 9));
  return { x: 20, y: 24, w, h };
}

export function transcriptTop(videoAspect: number) {
  const r = videoRect(videoAspect);
  return r.y + r.h + 22;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  opts: {
    video: HTMLVideoElement | null;
    videoAspect: number;
    blocks: Block[];
    activeIndex: number;
    scroll: number;
  },
) {
  const { video, videoAspect, blocks, activeIndex, scroll } = opts;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);

  const r = videoRect(videoAspect);
  ctx.save();
  roundRect(ctx, r.x, r.y, r.w, r.h, 10);
  ctx.clip();
  ctx.fillStyle = "#000";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (video && video.readyState >= 2) {
    ctx.drawImage(video, r.x, r.y, r.w, r.h);
  }
  ctx.restore();

  const top = transcriptTop(videoAspect);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, FRAME_W, FRAME_H - top);
  ctx.clip();
  ctx.translate(0, top - scroll);
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.direction = "rtl";

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const y = block.top - scroll + top;
    if (y + block.height < top - 60 || y > FRAME_H + 60) continue;

    const isActive = i === activeIndex;
    if (isActive) {
      ctx.fillStyle = HIGHLIGHT;
      roundRect(ctx, PAD_X, block.top, CARD_W, block.height, 14);
      ctx.fill();
    }

    let cursor = block.top + BLOCK_PAD_Y;
    ctx.font = ORIG_FONT;
    ctx.fillStyle = INK;
    for (const line of block.origLines) {
      ctx.fillText(line, TEXT_RIGHT, cursor);
      cursor += ORIG_LINE;
    }
    if (block.arLines.length) {
      cursor += 6;
      ctx.font = AR_FONT;
      ctx.fillStyle = MUTED;
      for (const line of block.arLines) {
        ctx.fillText(line, TEXT_RIGHT, cursor);
        cursor += AR_LINE;
      }
    }
  }
  ctx.restore();
}

export function scrollTargetFor(blocks: Block[], index: number, videoAspect: number): number {
  const block = blocks[index];
  if (!block) return 0;
  const visible = FRAME_H - transcriptTop(videoAspect);
  const total = blocks.reduce((sum, b) => sum + b.height + BLOCK_GAP, 0);
  const target = block.top - visible * 0.32;
  return Math.max(0, Math.min(target, Math.max(0, total - visible)));
}

export function blockIndexAtY(blocks: Block[], y: number, scroll: number, videoAspect: number): number {
  const local = y - transcriptTop(videoAspect) + scroll;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && local >= b.top && local <= b.top + b.height) return i;
  }
  return -1;
}
