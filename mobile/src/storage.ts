import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PairingState } from "./types";

const PAIRING_KEY = "barf_pairing_state_v1";

export async function savePairingState(state: PairingState): Promise<void> {
  await AsyncStorage.setItem(PAIRING_KEY, JSON.stringify(state));
}

export async function getPairingState(): Promise<PairingState | null> {
  const raw = await AsyncStorage.getItem(PAIRING_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as PairingState;
}

export async function clearPairingState(): Promise<void> {
  await AsyncStorage.removeItem(PAIRING_KEY);
}
