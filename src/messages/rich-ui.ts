import type { InputRichBlockButtons, RichMessageButton } from "grammy/types";

export type RichButtonStyle = NonNullable<RichMessageButton["style"]>;

export function richCallbackButton(
  text: string,
  callbackData: string,
  style?: RichButtonStyle,
): RichMessageButton {
  if (new TextEncoder().encode(callbackData).byteLength > 64) {
    throw new RangeError("Rich-message callback data must be at most 64 bytes.");
  }
  return {
    text,
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
