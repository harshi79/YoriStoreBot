import { describe, expect, it } from "vitest";
import { richCallbackButton, richDataTable, richHeading, richKeyValueTable } from "../src/messages/rich-ui.js";
import { smallCaps } from "../src/utils/format.js";

describe("store UI formatting", () => {
  it("maps Latin UI copy to small caps while preserving punctuation, emoji, and other scripts", () => {
    expect(smallCaps("Rich messages: 2 items! 🛍 中文 x"))
      .toBe("ʀɪᴄʜ ᴍᴇꜱꜱᴀɢᴇꜱ: 2 ɪᴛᴇᴍꜱ! 🛍 中文 x");
    expect(smallCaps("ɪʀɪꜱ")).toBe("ɪʀɪꜱ");
  });

  it("builds bordered, striped tables with headed columns and small-cap captions", () => {
    const table = richDataTable(
      ["Product", "Price"],
      [["Premium item", "50 credits"]],
      "Catalog",
      ["left", "right"],
    );

    expect(table).toMatchObject({
      type: "table",
      caption: "ᴄᴀᴛᴀʟᴏɢ",
      is_bordered: true,
      is_striped: true,
      cells: [
        [
          { text: "ᴘʀᴏᴅᴜᴄᴛ", is_header: true, align: "left", valign: "middle" },
          { text: "ᴘʀɪᴄᴇ", is_header: true, align: "right", valign: "middle" },
        ],
        [
          { text: "Premium item", align: "left", valign: "middle" },
          { text: "50 credits", align: "right", valign: "middle" },
        ],
      ],
    });
  });

  it("styles detail labels without changing copyable credential values", () => {
    const table = richKeyValueTable(
      [["Login", { type: "code", text: "user@example.test:Secret123" }]],
      "Delivery details",
    );

    expect(table.caption).toBe("ᴅᴇʟɪᴠᴇʀʏ ᴅᴇᴛᴀɪʟꜱ");
    expect(table.cells[1]?.[0]?.text).toBe("ʟᴏɢɪɴ");
    expect(table.cells[1]?.[1]?.text).toEqual({ type: "code", text: "user@example.test:Secret123" });
  });

  it("preserves case-sensitive code labels inside rich headings and buttons", () => {
    const code = "AbC-79Qx";
    const heading = richHeading([smallCaps("🔑 "), { type: "code", text: code }], 1);
    const button = richCallbackButton(code, "admin:code:view:123", "link", false);

    expect(heading.text).toEqual([smallCaps("🔑 "), { type: "code", text: code }]);
    expect(button.text).toBe(code);
  });

  it("rejects malformed table rows and overlong callback data", () => {
    expect(() => richDataTable(["Product", "Price"], [["Only one cell"]], "Catalog"))
      .toThrow("Every rich table row must have the same number of cells as its header.");
    expect(() => richCallbackButton("Open", "x".repeat(65)))
      .toThrow("Rich-message callback data must be at most 64 bytes.");
  });
});
