import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";

export function brandFor(name: string) {
  const key = name.toLowerCase();
  if (key.includes("spotify")) return { kind: "spotify", color: "#20b565", background: "#edf5ee", label: "Spotify" };
  if (key.includes("discord")) return { kind: "discord", color: "#5865f2", background: "#eeedfb", label: "Discord" };
  if (key.includes("notion")) return { kind: "notion", color: "#242424", background: "#f3f1ee", label: "Notion" };
  if (key.includes("canva")) return { kind: "canva", color: "#27bfbd", background: "#edf5f5", label: "Canva" };
  if (key.includes("steam")) return { kind: "steam", color: "#1c344a", background: "#ebf0f5", label: "Steam" };
  if (key.includes("figma")) return { kind: "figma", color: "#30323b", background: "#f4eff6", label: "Figma" };
  if (key.includes("lightroom") || key.includes("presets")) return { kind: "lightroom", color: "#153d68", background: "#eef3fa", label: "Lightroom" };
  if (key.includes("crunchyroll")) return { kind: "crunchyroll", color: "#f47f3d", background: "#fcf1e9", label: "Crunchyroll" };
  return { kind: "generic", color: "#7758bf", background: "#f0edf7", label: name };
}
export function BrandIcon({ name, small = false }: { name: string; small?: boolean }) {
  const brand = brandFor(name);
  return <span className={`brand-icon ${brand.kind} ${small ? "small" : ""}`} style={{ "--brand": brand.color } as CSSProperties} aria-hidden="true">
    {brand.kind === "spotify" ? <svg viewBox="0 0 40 40"><path d="M9 15c7-3 15-2 22 2M10.5 21c6-2.5 13-1.7 19 1.5M12 27c5-1.8 10-1.2 15 1" stroke="currentColor" fill="none" strokeWidth="3" strokeLinecap="round" /></svg>
      : brand.kind === "discord" ? <svg viewBox="0 0 40 40"><path d="M11 12l6-2 1 3h4l1-3 6 2c4 5 5 10 5 16l-7 3-2-3c-3 1-7 1-10 0l-2 3-7-3c0-6 1-11 5-16z" fill="currentColor"/><ellipse cx="15" cy="22" rx="2.2" ry="3" fill="#5865f2"/><ellipse cx="25" cy="22" rx="2.2" ry="3" fill="#5865f2"/></svg>
      : brand.kind === "notion" ? <b>N</b>
      : brand.kind === "canva" ? <i>Canva</i>
      : brand.kind === "figma" ? <svg viewBox="0 0 40 48"><path d="M20 2H12a8 8 0 000 16h8z" fill="#f24e1e"/><path d="M20 2h8a8 8 0 010 16h-8z" fill="#ff7262"/><path d="M20 18H12a8 8 0 000 16h8z" fill="#a259ff"/><circle cx="28" cy="26" r="8" fill="#1abcfe"/><path d="M20 34h-8a8 8 0 108 8z" fill="#0acf83"/></svg>
      : brand.kind === "lightroom" ? <b>Lr</b>
      : brand.kind === "steam" ? <svg viewBox="0 0 40 40"><circle cx="28" cy="13" r="7" fill="none" stroke="currentColor" strokeWidth="3"/><circle cx="12" cy="28" r="6" fill="none" stroke="currentColor" strokeWidth="3"/><path d="M17 26l7-7M7 25l-7-3" stroke="currentColor" strokeWidth="5"/></svg>
      : brand.kind === "crunchyroll" ? <svg viewBox="0 0 40 40"><path d="M33 19a13 13 0 10-10 15 10 10 0 119-15" fill="currentColor"/></svg>
      : <Sparkles size={30}/>}</span>;
}
/**
 * Product artwork for the Mini App.
 *
 * Renders the owner-supplied image link when one is set. If the link is missing,
 * blocked by the network, or fails to load, this falls back to the generated
 * brand tile so a card never shows a broken image.
 */
export function ProductArt({ name, imageUrl, small = false }: { name: string; imageUrl?: string | null; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!imageUrl || failed) return <BrandIcon name={name} small={small}/>;
  return (
    <img
      className={small ? "product-art small" : "product-art"}
      src={imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function IrisMark({ className = "" }: { className?: string }) {
  return <span className={`iris-mark ${className}`}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2c0 9-5 14-14 14 9 0 14 5 14 14 0-9 5-14 14-14C21 16 16 11 16 2z" fill="currentColor"/></svg></span>;
}
