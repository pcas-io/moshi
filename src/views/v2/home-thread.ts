// The bubble geometry of Home's "Latest conversation" card.
//
// This module used to carry a second renderer as well: a client script that
// built the same bubbles from an SSE stream. Server and client drifted apart
// anyway (the preview cap, the emblem lookup). The card now refreshes itself
// as a server-rendered fragment (src/views/v2/live-refresh.ts), so there is
// exactly one place that draws a bubble.

import { V2_FONT_FAMILY_MONO, V2_TOKENS } from "./tokens.js";

const T = V2_TOKENS;

const BUBBLE_BASE =
  `border-radius:13px;padding:11px 14px;font-size:14px;line-height:1.6;color:${T.ink};white-space:pre-wrap`;

/** Bubble edges are softer than `greenLine`/`line`, which read as panel rules. */
export function bubbleStyle(isMine: boolean): string {
  return isMine
    ? `${BUBBLE_BASE};background:${T.greenSoft};border:1px solid #cfe9d7;border-bottom-right-radius:5px`
    : `${BUBBLE_BASE};background:${T.subtle};border:1px solid #eae3d7;border-bottom-left-radius:5px`;
}

export function rowStyle(isMine: boolean): string {
  return `display:flex;gap:11px;align-items:flex-end;flex-direction:${isMine ? "row-reverse" : "row"}`;
}

export function colStyle(isMine: boolean): string {
  return `max-width:80%;display:flex;flex-direction:column;align-items:${isMine ? "flex-end" : "flex-start"}`;
}

export function headStyle(isMine: boolean): string {
  return `display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-direction:${isMine ? "row-reverse" : "row"}`;
}

export const TIME_STYLE = `font-family:${V2_FONT_FAMILY_MONO};font-size:11px;color:${T.faint}`;

/** Longest payload a bubble shows. */
export const PREVIEW_MAX = 240;
