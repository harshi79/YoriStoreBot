import type {
  InputRichBlock,
  InputRichBlockButtons,
  InputRichBlockFooter,
  InputRichBlockParagraph,
  InputRichBlockSectionHeading,
  InputRichBlockTable,
  RichBlockTableCell,
  RichMessageButton,
  RichText,
} from "grammy/types";
import { smallCaps } from "../utils/format.js";

export type RichButtonStyle = "danger" | "success" | "primary" | "link";
export type RichTableAlignment = RichBlockTableCell["align"];

export function richHeading(
  text: RichText,
  size: 1 | 2 | 3 | 4 | 5 | 6 = 2,
  smallCapsCopy = true,
): InputRichBlockSectionHeading {
  return { type: "heading", size, text: smallCapsCopy && typeof text === "string" ? smallCaps(text) : text };
}

export function richParagraph(text: RichText, smallCapsCopy = false): InputRichBlockParagraph {
  return { type: "paragraph", text: smallCapsCopy && typeof text === "string" ? smallCaps(text) : text };
}

export function richFooter(text: RichText, smallCapsCopy = false): InputRichBlockFooter {
  return { type: "footer", text: smallCapsCopy && typeof text === "string" ? smallCaps(text) : text };
}

function tableCell(
  text: RichText,
  header = false,
  align: RichTableAlignment = "left",
): RichBlockTableCell {
  return {
    text,
    ...(header ? { is_header: true as const } : {}),
    align,
    valign: "middle",
  };
}

/** A fully bordered, striped table for compact operational data. */
export function richDataTable(
  headers: string[],
  rows: ReadonlyArray<ReadonlyArray<RichText>>,
  caption: string,
  alignments: RichTableAlignment[] = [],
  compact = false,
): InputRichBlockTable {
  if (headers.length === 0) throw new RangeError("Rich data tables need at least one column.");
  if (rows.some((row) => row.length !== headers.length)) {
    throw new RangeError("Every rich table row must have the same number of cells as its header.");
  }

  return {
    type: "table",
    caption: smallCaps(caption),
    is_bordered: true,
    is_striped: true,
    ...(compact ? { is_compact: true as const } : {}),
    cells: [
      headers.map((header, index) => tableCell(smallCaps(header), true, alignments[index] ?? "left")),
      ...rows.map((row) => row.map((value, index) => tableCell(value, false, alignments[index] ?? "left"))),
    ],
  };
}

/** A two-column, properly headed table for item details and summaries. */
export function richKeyValueTable(
  rows: ReadonlyArray<readonly [string, RichText]>,
  caption: string,
  compact = false,
): InputRichBlockTable {
  return richDataTable(
    ["Detail", "Value"],
    rows.map(([label, value]) => [smallCaps(label), value]),
    caption,
    ["left", "left"],
    compact,
  );
}

export function richCallbackButton(
  text: string,
  callbackData: string,
  style?: RichButtonStyle,
  smallCapsLabel = true,
): RichMessageButton {
  if (new TextEncoder().encode(callbackData).byteLength > 64) {
    throw new RangeError("Rich-message callback data must be at most 64 bytes.");
  }
  return {
    text: smallCapsLabel ? smallCaps(text) : text,
    callback_data: callbackData,
    ...(style ? { style } : {}),
  };
}

export function richButtonRow(
  buttons: RichMessageButton[],
  align: InputRichBlockButtons["align"] = "left",
): InputRichBlockButtons {
  if (buttons.length < 1 || buttons.length > 8) {
    throw new RangeError("Rich-message button rows must contain between one and eight buttons.");
  }
  return { type: "buttons", buttons, align };
}

export function richActionBlocks(buttonRows: ReadonlyArray<RichMessageButton[]> = []): InputRichBlock[] {
  return buttonRows.map((buttons) => richButtonRow(buttons));
}
