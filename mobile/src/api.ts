import { Platform } from "react-native";

import type { PhotoPayload } from "./types";

// Prefer explicit env override. Fallback avoids localhost IPv6 websocket issues on some browsers.
const runtimeHost = Platform.OS === "web" && typeof window !== "undefined" ? window.location.hostname : "127.0.0.1";
const fallbackHost = runtimeHost === "localhost" ? "127.0.0.1" : runtimeHost;
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? `http://${fallbackHost}:8000`;

export async function createPairCode(name: string): Promise<{ code: string; expires_in_seconds: number }> {
  const res = await fetch(`${API_BASE}/pairing/create-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  if (!res.ok) throw new Error("Could not create code");
  return res.json();
}

export async function joinPairCode(name: string, code: string): Promise<{ pairing_id: string; partner_name: string }> {
  const res = await fetch(`${API_BASE}/pairing/join-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code })
  });

  if (!res.ok) throw new Error("Invalid or expired code");
  return res.json();
}

export async function checkPairStatus(code: string): Promise<{ matched: boolean; pairing_id?: string; partner_name?: string; expired?: boolean }> {
  const res = await fetch(`${API_BASE}/pairing/status/${code}`);
  if (!res.ok) throw new Error("Could not check pairing status");
  return res.json();
}

export async function uploadPhoto(params: {
  pairingId: string;
  senderName: string;
  imageUri: string;
  mimeType: string;
  ttlHours: number;
}): Promise<{ pairing_id: string; expires_in_seconds: number }> {
  const form = new FormData();
  form.append("pairing_id", params.pairingId);
  form.append("sender_name", params.senderName);
  form.append("ttl_hours", String(params.ttlHours));

  form.append("image", {
    uri: params.imageUri,
    type: params.mimeType,
    name: "photo.jpg"
  } as any);

  const res = await fetch(`${API_BASE}/photo/upload`, {
    method: "POST",
    body: form
  });

  if (!res.ok) throw new Error("Upload failed");
  return res.json();
}

export async function checkPhoto(pairingId: string): Promise<{ has_photo: false } | ({ has_photo: true } & PhotoPayload)> {
  const res = await fetch(`${API_BASE}/check_photo/${pairingId}`);
  if (!res.ok) throw new Error("Could not check photo");
  return res.json();
}

export function pairingCodeWsUrl(code: string): string {
  const wsBase = API_BASE.replace(/^http/, "ws");
  return `${wsBase}/ws/pairing-code/${code}`;
}

export function pairingWsUrl(pairingId: string): string {
  const wsBase = API_BASE.replace(/^http/, "ws");
  return `${wsBase}/ws/pairing/${pairingId}`;
}
