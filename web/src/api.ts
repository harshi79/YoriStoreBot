import type { AuthDto, MiniConfig } from "../../src/mini-app/contracts.js";

export class RequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
let token = sessionStorage.getItem("iris-session");
export function setSession(value: string | null) {
  token = value;
  if (value) sessionStorage.setItem("iris-session", value);
  else sessionStorage.removeItem("iris-session");
}
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
  } catch { throw new RequestError("NETWORK", "Couldn't reach Iris. Check your connection and try again.", 0); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) {
      window.dispatchEvent(new CustomEvent("iris-session-expired", { detail: data.error?.message ?? "Your session expired. Reopen Iris through Telegram." }));
    }
    throw new RequestError(data.error?.code ?? "UNKNOWN", data.error?.message ?? "Something went wrong. Please try again.", response.status);
  }
  return data as T;
}
export async function authenticate(config: MiniConfig) {
  const telegram = window.Telegram?.WebApp;
  if (telegram?.initData) {
    const result = await api<AuthDto>("/auth/telegram", "POST", { initData: telegram.initData });
    setSession(result.token);
    telegram.ready(); telegram.expand();
    return;
  }
  if (config.demoMode) {
    const result = await api<AuthDto>("/auth/demo", "POST", {}); setSession(result.token); return;
  }
  if (!token) throw new RequestError("TELEGRAM_AUTH", "Open Iris through Telegram to access your private account.", 401);
}
export async function downloadReceipt(id: string) {
  const response = await fetch(`/api/orders/${encodeURIComponent(id)}/receipt`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) { const data = await response.json(); throw new RequestError(data.error?.code ?? "UNKNOWN", data.error?.message ?? "Could not download that receipt.", response.status); }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `iris-order-${id.slice(0, 8)}.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openTelegram(url: string) {
  const app = window.Telegram?.WebApp;
  if (app?.initData && app.openTelegramLink) app.openTelegramLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
export function haptic() { if (window.Telegram?.WebApp.initData) window.Telegram.WebApp.HapticFeedback?.impactOccurred("light"); }
