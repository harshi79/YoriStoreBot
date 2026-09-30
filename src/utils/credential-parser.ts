export interface ParsedCredentialField {
  icon: string;
  label: string;
  value: string;
  copyable: boolean;
}

export interface ParsedDeliveryPayload {
  kind: "account" | "key" | "structured" | "raw";
  login?: string;
  password?: string;
  extraFields: ParsedCredentialField[];
  rawPayload: string;
}

export interface ProductPreset {
  id: string;
  buttonLabel: string;
  title: string;
  planDetails: string;
  warrantyHours: number;
  deliveryInstructions: string;
}

export const PRODUCT_DELIVERY_PRESETS: Record<string, ProductPreset> = {
  crunchyroll: {
    id: "crunchyroll",
    buttonLabel: "🟠 Crunchyroll / Anime",
    title: "Crunchyroll / Anime Streaming",
    planDetails: "Mega Fan · Ad-Free · Simulcast · Offline Viewing",
    warrantyHours: 24,
    deliveryInstructions:
      "• Sign in at crunchyroll.com or the Crunchyroll app.\n" +
      "• Do NOT change the email, password, or billing settings (voids warranty).\n" +
      "• Use an unoccupied profile and stream on 1 device at a time.\n" +
      "• If login fails within warranty, open My Orders → Report Issue for a replacement.",
  },
  streaming: {
    id: "streaming",
    buttonLabel: "🎬 Netflix / OTT",
    title: "Netflix / OTT Streaming",
    planDetails: "Premium UHD 4K · Shared Profile · Ad-Free",
    warrantyHours: 24,
    deliveryInstructions:
      "• Sign in on the official app or website.\n" +
      "• Do NOT change account email, password, or delete profiles (voids warranty).\n" +
      "• Stream on 1 screen at a time.\n" +
      "• Report any login issue via My Orders → Report Issue within warranty.",
  },
  music: {
    id: "music",
    buttonLabel: "🎵 Spotify / App",
    title: "Music / Premium App",
    planDetails: "Premium Plan · Ad-Free · Offline Mode",
    warrantyHours: 24,
    deliveryInstructions:
      "• Log in using the credentials delivered above.\n" +
      "• Do NOT alter account email, password, or subscription settings.\n" +
      "• Use My Orders → Report Issue within warranty if login fails.",
  },
  gaming: {
    id: "gaming",
    buttonLabel: "🎮 Gaming / Steam",
    title: "Gaming / Launcher Account",
    planDetails: "Verified Account · Instant Delivery",
    warrantyHours: 24,
    deliveryInstructions:
      "• Sign in through the official game launcher.\n" +
      "• Do NOT change security settings unless the product states Full Access (FA).\n" +
      "• Open My Orders → Report Issue within warranty if there is a login problem.",
  },
  license: {
    id: "license",
    buttonLabel: "🔑 License / Key",
    title: "License Key / Activation Code",
    planDetails: "Instant Activation Key · Single Use",
    warrantyHours: 24,
    deliveryInstructions:
      "• Copy the activation code/key above and redeem it on the official platform.\n" +
      "• Redeem promptly and keep your order receipt for reference.",
  },
};

function iconForLabel(rawLabel: string): { icon: string; label: string; copyable: boolean } {
  const clean = rawLabel.trim();
  const lower = clean.toLowerCase();
  if (/^(email|e-mail|mail|user|username|login|id|account)$/.test(lower)) {
    return { icon: "📧", label: "Login / Email", copyable: true };
  }
  if (/^(pass|password|pwd|secret)$/.test(lower)) {
    return { icon: "🔑", label: "Password", copyable: true };
  }
  if (/^(plan|tier|type|subscription|sub|package)$/.test(lower)) {
    return { icon: "💎", label: "Plan / Tier", copyable: false };
  }
  if (/^(exp|expiry|expires|validity|valid|until|renewal|renews|duration)$/.test(lower)) {
    return { icon: "⏳", label: "Validity / Expiry", copyable: false };
  }
  if (/^(region|country|geo|server|locale)$/.test(lower)) {
    return { icon: "🌍", label: "Region", copyable: false };
  }
  if (/^(profile|screen|slot|member)$/.test(lower)) {
    return { icon: "👤", label: "Profile / Screen", copyable: false };
  }
  if (/^(pin|2fa|otp|code|token|backup|recovery)$/.test(lower)) {
    return { icon: "🔢", label: clean.toUpperCase(), copyable: true };
  }
  if (/^(url|link|site|invite)$/.test(lower)) {
    return { icon: "🌐", label: "Link", copyable: true };
  }
  return {
    icon: "📌",
    label: clean.charAt(0).toUpperCase() + clean.slice(1),
    copyable: false,
  };
}

function splitCredPair(segment: string): { login: string; password: string } | null {
  // Don't split URLs like https://...
  if (/^https?:\/\//i.test(segment.trim())) return null;
  const idx = segment.indexOf(":");
  if (idx <= 0 || idx >= segment.length - 1) return null;
  const left = segment.slice(0, idx).trim();
  const right = segment.slice(idx + 1).trim();
  if (!left || !right) return null;
  // Avoid treating "Plan: Mega Fan" as login:password if left has spaces or is a known metadata key
  if (/\s/.test(left)) return null;
  if (/^(plan|tier|exp|expiry|expires|validity|region|country|profile|screen|pin|note|info|status|renewal|url|link)$/i.test(left)) {
    return null;
  }
  return { login: left, password: right };
}

export function parseDeliveryPayload(raw: string): ParsedDeliveryPayload {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\n")) {
    return { kind: "raw", extraFields: [], rawPayload: trimmed };
  }

  // Case 1: Pipe-delimited segments, e.g.:
  // "email@domain.com:pass123 | Plan: Mega Fan | Expiry: 2027-01-15 | Profile: #2 | PIN: 1234"
  if (trimmed.includes("|")) {
    const segments = trimmed.split("|").map((part) => part.trim()).filter(Boolean);
    if (segments.length > 0) {
      let login: string | undefined;
      let password: string | undefined;
      const extraFields: ParsedCredentialField[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        if (i === 0) {
          const cred = splitCredPair(seg);
          if (cred && !cred.password.includes(":")) {
            login = cred.login;
            password = cred.password;
            continue;
          }
        }
        const kvMatch = /^([^:=]{1,32})\s*[:=]\s*(.+)$/.exec(seg);
        if (kvMatch) {
          const meta = iconForLabel(kvMatch[1]!);
          const val = kvMatch[2]!.trim();
          if (meta.label === "Login / Email" && !login) {
            login = val;
          } else if (meta.label === "Password" && !password) {
            password = val;
          } else {
            extraFields.push({ icon: meta.icon, label: meta.label, value: val, copyable: meta.copyable });
          }
        } else {
          const positionalLabels = ["Plan / Tier", "Validity / Expiry", "Region", "Profile / Screen", "Note"];
          const label = positionalLabels[extraFields.length] ?? `Detail ${extraFields.length + 1}`;
          const meta = iconForLabel(label.split("/")[0]!.trim());
          extraFields.push({ icon: meta.icon, label, value: seg, copyable: false });
        }
      }

      if (login && password) {
        return { kind: "account", login, password, extraFields, rawPayload: trimmed };
      }
      if (extraFields.length > 0) {
        return { kind: "structured", extraFields, rawPayload: trimmed };
      }
    }
  }

  // Case 2: Colon-delimited account line:
  // "email:pass" or "email:pass:Mega Fan:2027-01-15:Profile 2"
  if (!/^https?:\/\//i.test(trimmed) && trimmed.includes(":")) {
    const parts = trimmed.split(":").map((part) => part.trim());
    const first = parts[0] ?? "";
    const second = parts[1] ?? "";
    if (parts.length >= 2 && first && second && !/\s/.test(first)) {
      const extraFields: ParsedCredentialField[] = [];
      const rest = parts.slice(2).filter(Boolean);
      const colonMeta = [
        { icon: "💎", label: "Plan / Tier", copyable: false },
        { icon: "⏳", label: "Validity / Expiry", copyable: false },
        { icon: "👤", label: "Profile / Extra", copyable: false },
        { icon: "🔢", label: "PIN / Code", copyable: true },
      ];
      for (let i = 0; i < rest.length; i++) {
        const meta = colonMeta[i] ?? { icon: "📌", label: `Detail ${i + 1}`, copyable: false };
        extraFields.push({
          icon: meta.icon,
          label: meta.label,
          value: rest[i]!,
          copyable: meta.copyable,
        });
      }
      return {
        kind: "account",
        login: first,
        password: second,
        extraFields,
        rawPayload: trimmed,
      };
    }
  }

  // Case 3: Single-line key / token / URL
  if (trimmed.length <= 256 && !/\s/.test(trimmed)) {
    return { kind: "key", extraFields: [], rawPayload: trimmed };
  }

  return { kind: "raw", extraFields: [], rawPayload: trimmed };
}

export function buildOrderReceiptText(input: {
  purchaseId: string;
  productName: string;
  categoryName?: string;
  paid: number;
  createdAt: Date;
  payload: string;
  planDetails?: string;
  deliveryInstructions?: string;
  warrantyHours?: number;
}): string {
  const parsed = parseDeliveryPayload(input.payload);
  const lines: string[] = [
    "==================================================",
    "                IRIS STORE RECEIPT                ",
    "==================================================",
    `Order ID      : ${input.purchaseId}`,
    `Product       : ${input.productName}`,
    ...(input.categoryName ? [`Category      : ${input.categoryName}`] : []),
    `Paid          : ${input.paid} credits`,
    `Purchased At  : ${input.createdAt.toISOString()}`,
    ...(input.warrantyHours && input.warrantyHours > 0
      ? [`Warranty      : ${input.warrantyHours}h replacement coverage`]
      : []),
    "--------------------------------------------------",
    "DELIVERED CREDENTIALS / DETAILS",
    "--------------------------------------------------",
  ];

  if (parsed.kind === "account" && parsed.login && parsed.password) {
    lines.push(`Login / Email : ${parsed.login}`);
    lines.push(`Password      : ${parsed.password}`);
    for (const field of parsed.extraFields) {
      lines.push(`${field.label.padEnd(14, " ")}: ${field.value}`);
    }
    lines.push("");
    lines.push(`Raw Line      : ${input.payload}`);
  } else {
    lines.push(input.payload);
  }

  if (input.planDetails?.trim()) {
    lines.push("--------------------------------------------------");
    lines.push("ACCOUNT / PLAN DETAILS");
    lines.push("--------------------------------------------------");
    lines.push(input.planDetails.trim());
  }

  if (input.deliveryInstructions?.trim()) {
    lines.push("--------------------------------------------------");
    lines.push("IMPORTANT RULES & LOGIN INSTRUCTIONS");
    lines.push("--------------------------------------------------");
    lines.push(input.deliveryInstructions.trim());
  }

  lines.push("==================================================");
  return lines.join("\n") + "\n";
}
