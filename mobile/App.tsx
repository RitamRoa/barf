import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import * as ImagePicker from "expo-image-picker";

import {
  checkPairStatus,
  checkPhoto,
  createPairCode,
  joinPairCode,
  markPhotoSeen,
  pairingCodeWsUrl,
  pairingWsUrl,
  uploadPhoto
} from "./src/api";
import { clearPairingState, getPairingState, savePairingState } from "./src/storage";
import { theme } from "./src/theme";
import type { PairingState, PhotoPayload } from "./src/types";

type UiPhoto = {
  photoId: string;
  senderName: string;
  mimeType: string;
  imageB64: string;
  expiresAtMs: number;
};

function toUiPhoto(payload: PhotoPayload): UiPhoto {
  return {
    photoId: payload.photo_id,
    senderName: payload.sender_name,
    mimeType: payload.mime_type,
    imageB64: payload.image_b64,
    expiresAtMs: Date.now() + payload.expires_in_seconds * 1000
  };
}

function formatRemaining(totalSeconds: number): string {
  const safe = Math.max(totalSeconds, 0);
  if (safe < 60) return "less than a minute left";
  if (safe < 3600) {
    const m = Math.round(safe / 60);
    return `${m} minute${m !== 1 ? "s" : ""} left`;
  }
  if (safe < 86400) {
    const h = Math.floor(safe / 3600);
    return `${h} hour${h !== 1 ? "s" : ""} left`;
  }
  const d = Math.floor(safe / 86400);
  return `${d} day${d !== 1 ? "s" : ""} left`;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState<PairingState | null>(null);

  const [mode, setMode] = useState<"create" | "join">("create");
  const [nameInput, setNameInput] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [photos, setPhotos] = useState<UiPhoto[]>([]);
  const [clock, setClock] = useState(Date.now());
  const [ttlPreset, setTtlPreset] = useState<"1h" | "6h" | "24h" | "custom">("24h");
  const [customHoursInput, setCustomHoursInput] = useState("48");
  const [viewerVisible, setViewerVisible] = useState(false);

  const pairCodeWsRef = useRef<WebSocket | null>(null);
  const pairWsRef = useRef<WebSocket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const photoPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairingResolvedRef = useRef(false);
  const dismissedPhotoIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const bootstrap = async () => {
      const stored = await getPairingState();
      if (stored) {
        if (stored.authToken) {
          setPairing(stored);
        } else {
          await clearPairingState();
        }
      }
      setLoading(false);
    };

    bootstrap().catch(() => setLoading(false));

    return () => {
      pairCodeWsRef.current?.close();
      pairWsRef.current?.close();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (photoPollTimerRef.current) clearInterval(photoPollTimerRef.current);
      if (wsRetryTimerRef.current) clearTimeout(wsRetryTimerRef.current);
    };
  }, []);

  const refreshLatestPhoto = async (state: PairingState) => {
    try {
      const res = await checkPhoto(state.pairingId, state.authToken);
      if (res.has_photo && !dismissedPhotoIds.current.has(res.photo_id)) {
        const incoming = toUiPhoto(res);
        setPhotos(prev => {
          if (prev.some(p => p.photoId === incoming.photoId)) return prev;
          return [incoming, ...prev.filter(p => p.photoId !== incoming.photoId)].slice(0, 2);
        });
      } else if (!res.has_photo) {
        setPhotos([]);
      }
    } catch {
      // Silent failure for background refresh calls.
    }
  };

  useEffect(() => {
    if (!pairing) return;

    let cancelled = false;
    let retries = 0;

    const connectPairingWs = () => {
      if (cancelled) return;

      const ws = new WebSocket(pairingWsUrl(pairing.pairingId, pairing.authToken));
      pairWsRef.current = ws;

      ws.onopen = () => {
        retries = 0;
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.event === "photo_uploaded" && payload.sender_name !== pairing.userName) {
            const incoming = toUiPhoto(payload as PhotoPayload);
            if (dismissedPhotoIds.current.has(incoming.photoId)) return;
            setPhotos(prev => {
              if (prev.some(p => p.photoId === incoming.photoId)) return prev;
              if (prev.length >= 2) return prev;
              return [...prev, incoming];
            });
          }
        } catch {
          // Ignore malformed messages.
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        const retryDelayMs = Math.min(1000 * Math.pow(2, retries), 15000);
        retries += 1;
        if (wsRetryTimerRef.current) clearTimeout(wsRetryTimerRef.current);
        wsRetryTimerRef.current = setTimeout(connectPairingWs, retryDelayMs);
      };

      ws.onerror = () => {
        // Browser may log transient socket errors; reconnect + polling handle recovery.
      };
    };

    void refreshLatestPhoto(pairing);
    connectPairingWs();

    if (photoPollTimerRef.current) clearInterval(photoPollTimerRef.current);
    photoPollTimerRef.current = setInterval(() => {
      void refreshLatestPhoto(pairing);
    }, 15000);

    return () => {
      cancelled = true;
      pairWsRef.current?.close();
      pairWsRef.current = null;
      if (photoPollTimerRef.current) {
        clearInterval(photoPollTimerRef.current);
        photoPollTimerRef.current = null;
      }
      if (wsRetryTimerRef.current) {
        clearTimeout(wsRetryTimerRef.current);
        wsRetryTimerRef.current = null;
      }
    };
  }, [pairing]);

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingSeconds = useMemo(() => {
    if (photos.length === 0) return 0;
    return Math.max(0, Math.floor((photos[0].expiresAtMs - clock) / 1000));
  }, [photos, clock]);

  useEffect(() => {
    if (photos.length > 0 && remainingSeconds <= 0) {
      setPhotos(prev => prev.slice(1));
    }
  }, [photos, remainingSeconds]);

  const finalizePairing = async (state: PairingState) => {
    if (pairingResolvedRef.current) return;
    pairingResolvedRef.current = true;

    await savePairingState(state);
    setPairing(state);
    setGeneratedCode(null);
    setPairingError(null);

    pairCodeWsRef.current?.close();
    pairCodeWsRef.current = null;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const startCreateCode = async () => {
    const cleanName = nameInput.trim();
    if (!cleanName) {
      setPairingError("Enter your name first.");
      return;
    }

    try {
      pairingResolvedRef.current = false;
      setBusy(true);
      setPairingError(null);

      const data = await createPairCode(cleanName);
      setGeneratedCode(data.code);

      const ws = new WebSocket(pairingCodeWsUrl(data.code));
      pairCodeWsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.event === "pairing_matched") {
            if (pairingResolvedRef.current) return;
            finalizePairing({
              pairingId: payload.pairing_id,
              authToken: payload.auth_token,
              userName: cleanName,
              partnerName: payload.partner_name
            }).catch(() => {});
          }
        } catch {
          // Ignore malformed messages.
        }
      };

      ws.onerror = () => {
        // Pairing status polling remains active as fallback.
      };

      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        try {
          if (pairingResolvedRef.current) return;
          const status = await checkPairStatus(data.code);
          if (status.matched && status.pairing_id && status.auth_token) {
            await finalizePairing({
              pairingId: status.pairing_id,
              authToken: status.auth_token,
              userName: cleanName,
              partnerName: status.partner_name
            });
          }
          if (status.expired) {
            setPairingError("Code expired. Create a new one.");
            setGeneratedCode(null);
          }
        } catch {
          // Keep waiting silently.
        }
      }, 5000);
    } catch {
      setPairingError("Could not generate code.");
    } finally {
      setBusy(false);
    }
  };

  const startJoinCode = async () => {
    const cleanName = nameInput.trim();
    const cleanCode = joinCodeInput.trim();

    if (!cleanName || cleanCode.length !== 6) {
      setPairingError("Add your name and a valid 6-digit code.");
      return;
    }

    try {
      pairingResolvedRef.current = false;
      setBusy(true);
      setPairingError(null);

      const data = await joinPairCode(cleanName, cleanCode);
      await finalizePairing({
        pairingId: data.pairing_id,
        authToken: data.auth_token,
        userName: cleanName,
        partnerName: data.partner_name
      });
    } catch {
      setPairingError("That code is invalid or expired.");
    } finally {
      setBusy(false);
    }
  };

  const resolveTtlHours = (): number | null => {
    if (ttlPreset === "1h") return 1;
    if (ttlPreset === "6h") return 6;
    if (ttlPreset === "24h") return 24;
    const parsed = Number.parseInt(customHoursInput.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    return Math.min(parsed, 168);
  };

  const pickAndSendPhoto = async (source: "camera" | "library") => {
    if (!pairing) return;

    const ttlHours = resolveTtlHours();
    if (!ttlHours) {
      Alert.alert("Invalid duration", "Set custom hours to a number >= 1.");
      return;
    }

    let selected: ImagePicker.ImagePickerResult;

    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission needed", "Allow camera access to capture photos.");
        return;
      }

      selected = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.85,
        mediaTypes: ["images"]
      });
    } else {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission needed", "Allow photo library access to share pictures.");
        return;
      }

      selected = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        quality: 0.85,
        mediaTypes: ["images"]
      });
    }

    if (selected.canceled || selected.assets.length === 0) return;

    const asset = selected.assets[0];
    const mimeType = asset.mimeType ?? "image/jpeg";

    try {
      setBusy(true);
      await uploadPhoto({
        pairingId: pairing.pairingId,
        authToken: pairing.authToken,
        imageUri: asset.uri,
        mimeType,
        ttlHours
      });
    } catch (err: any) {
      Alert.alert("Cannot send", err?.message ?? "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const dismissViewer = async () => {
    setViewerVisible(false);
    if (photos.length === 0 || !pairing) return;
    const current = photos[0];
    // Register as dismissed immediately — before any async work — so polls
    // and WS replays cannot re-add this photo while mark-seen is in flight.
    dismissedPhotoIds.current.add(current.photoId);
    setPhotos(prev => prev.slice(1));
    try {
      await markPhotoSeen(pairing.pairingId, pairing.authToken, current.photoId);
      await refreshLatestPhoto(pairing);
    } catch {
      // Best-effort; local state already updated.
    }
  };

  const resetPairing = async () => {
    await clearPairingState();
    setPairing(null);
    setPhotos([]);
    setGeneratedCode(null);
    setJoinCodeInput("");
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.centeredScreen}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color={theme.colors.accent} size="large" />
      </SafeAreaView>
    );
  }

  if (!pairing) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <View style={styles.blobA} />
        <View style={styles.blobB} />

        <ScrollView contentContainerStyle={styles.authWrap} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>barf</Text>
          <Text style={styles.title}>Quiet Pair</Text>
          <Text style={styles.subtitle}>One private photo, always temporary.</Text>

          <View style={styles.modeRow}>
            <Pressable onPress={() => setMode("create")} style={[styles.modeBtn, mode === "create" && styles.modeBtnActive]}>
              <Text style={[styles.modeText, mode === "create" && styles.modeTextActive]}>Create</Text>
            </Pressable>
            <Pressable onPress={() => setMode("join")} style={[styles.modeBtn, mode === "join" && styles.modeBtnActive]}>
              <Text style={[styles.modeText, mode === "join" && styles.modeTextActive]}>Join</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <TextInput
              value={nameInput}
              onChangeText={setNameInput}
              placeholder="Your name"
              placeholderTextColor={theme.colors.textSecondary}
              style={styles.input}
              autoCapitalize="words"
            />

            {mode === "join" ? (
              <TextInput
                value={joinCodeInput}
                onChangeText={(v: string) => setJoinCodeInput(v.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="6-digit code"
                placeholderTextColor={theme.colors.textSecondary}
                style={styles.input}
                keyboardType="number-pad"
              />
            ) : null}

            {mode === "create" && generatedCode ? (
              <View style={styles.codeCard}>
                <Text style={styles.codeLabel}>Share this code</Text>
                <Text style={styles.codeValue}>{generatedCode}</Text>
                <Text style={styles.codeHint}>Waiting for your partner to join...</Text>
              </View>
            ) : null}

            {pairingError ? <Text style={styles.errorText}>{pairingError}</Text> : null}

            <Pressable
              onPress={mode === "create" ? startCreateCode : startJoinCode}
              style={[styles.primaryButton, busy && styles.buttonDisabled]}
              disabled={busy}
            >
              <Text style={styles.primaryButtonText}>{mode === "create" ? "Generate code" : "Match now"}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={styles.blobA} />
      <View style={styles.blobB} />

      <ScrollView contentContainerStyle={styles.homeWrap}>
        <Text style={styles.eyebrow}>paired</Text>
        <Text style={styles.title}>Photo Loop</Text>
        <Text style={styles.subtitle}>You are connected as {pairing.userName}.</Text>

        <View style={styles.panel}>
          <View style={styles.headerRow}>
            <Text style={styles.sectionTitle}>Shared Photo</Text>
            <Text style={styles.metaText}>ID {pairing.pairingId.slice(0, 8)}</Text>
          </View>

          {photos.length > 0 ? (
            <Pressable onPress={() => setViewerVisible(true)} style={styles.photoRow}>
              <View style={styles.photoThumb}>
                <Image source={{ uri: `data:${photos[0].mimeType};base64,${photos[0].imageB64}` }} style={styles.photoThumbImg} />
                <View style={styles.photoThumbOverlay}>
                  <Text style={styles.photoThumbIcon}>🔍</Text>
                </View>
              </View>
              <View style={styles.photoInfo}>
                <Text style={styles.photoInfoTitle}>Photo received</Text>
                <Text style={styles.metaText}>from {photos[0].senderName}</Text>
                <Text style={styles.timerText}>{formatRemaining(remainingSeconds)}</Text>
                {photos.length > 1 ? <Text style={styles.metaText}>+{photos.length - 1} more queued</Text> : null}
                <Text style={styles.photoHint}>Tap to view once</Text>
              </View>
            </Pressable>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.metaText}>No active photo right now.</Text>
            </View>
          )}

          <View style={styles.ttlWrap}>
            <Text style={styles.metaText}>Photo duration</Text>
            <View style={styles.ttlRow}>
              {[
                { key: "1h", label: "1h" },
                { key: "6h", label: "6h" },
                { key: "24h", label: "24h" },
                { key: "custom", label: "Custom" }
              ].map((item) => (
                <Pressable
                  key={item.key}
                  onPress={() => setTtlPreset(item.key as "1h" | "6h" | "24h" | "custom")}
                  style={[styles.ttlChip, ttlPreset === item.key && styles.ttlChipActive]}
                >
                  <Text style={[styles.ttlChipText, ttlPreset === item.key && styles.ttlChipTextActive]}>{item.label}</Text>
                </Pressable>
              ))}
            </View>

            {ttlPreset === "custom" ? (
              <TextInput
                value={customHoursInput}
                onChangeText={(v) => setCustomHoursInput(v.replace(/[^0-9]/g, "").slice(0, 3))}
                placeholder="Hours (1-168)"
                placeholderTextColor={theme.colors.textSecondary}
                style={styles.input}
                keyboardType="number-pad"
              />
            ) : null}
          </View>

          <View style={styles.actionRow}>
            <Pressable onPress={() => pickAndSendPhoto("camera")} style={[styles.primaryButton, styles.actionButton, busy && styles.buttonDisabled]} disabled={busy}>
              <Text style={styles.primaryButtonText}>Camera</Text>
            </Pressable>

            <Pressable onPress={() => pickAndSendPhoto("library")} style={[styles.primaryButton, styles.actionButton, busy && styles.buttonDisabled]} disabled={busy}>
              <Text style={styles.primaryButtonText}>Gallery</Text>
            </Pressable>
          </View>

          <Pressable onPress={resetPairing} style={styles.ghostButton}>
            <Text style={styles.ghostButtonText}>Reset local pairing</Text>
          </Pressable>
        </View>
      </ScrollView>

      <Modal visible={viewerVisible} transparent animationType="fade" onRequestClose={() => { void dismissViewer(); }}>
        <View style={styles.viewerBackdrop}>
          <Pressable style={styles.viewerDismiss} onPress={() => { void dismissViewer(); }}>
            <Text style={styles.viewerDismissText}>Close</Text>
          </Pressable>
          {photos[0] ? <Image source={{ uri: `data:${photos[0].mimeType};base64,${photos[0].imageB64}` }} style={styles.viewerImage} /> : null}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background
  },
  centeredScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background
  },
  blobA: {
    position: "absolute",
    top: -50,
    right: -30,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#241F17"
  },
  blobB: {
    position: "absolute",
    bottom: 90,
    left: -80,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#17130F"
  },
  authWrap: {
    padding: theme.spacing.xl,
    paddingTop: 42,
    gap: theme.spacing.md
  },
  homeWrap: {
    padding: theme.spacing.xl,
    paddingTop: 42,
    gap: theme.spacing.md,
    paddingBottom: 30
  },
  eyebrow: {
    color: theme.colors.accent,
    letterSpacing: 2,
    textTransform: "uppercase",
    fontSize: 12
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 50,
    lineHeight: 52,
    fontFamily: "serif"
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 300
  },
  modeRow: {
    flexDirection: "row",
    backgroundColor: theme.colors.panelSoft,
    borderRadius: 999,
    padding: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm
  },
  modeBtn: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: "center"
  },
  modeBtnActive: {
    backgroundColor: theme.colors.accent
  },
  modeText: {
    color: theme.colors.textSecondary,
    fontWeight: "600"
  },
  modeTextActive: {
    color: "#1B1A17"
  },
  panel: {
    backgroundColor: theme.colors.panel,
    borderRadius: theme.radius.xl,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing.md
  },
  input: {
    backgroundColor: "#1F1F1F",
    color: theme.colors.textPrimary,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15
  },
  codeCard: {
    backgroundColor: "#121212",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    alignItems: "center",
    gap: theme.spacing.xs
  },
  codeLabel: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 1.4
  },
  codeValue: {
    color: theme.colors.accent,
    fontSize: 42,
    lineHeight: 44,
    fontFamily: "serif",
    letterSpacing: 2
  },
  codeHint: {
    color: theme.colors.textSecondary,
    fontSize: 12
  },
  errorText: {
    color: "#FFA6A6"
  },
  primaryButton: {
    backgroundColor: theme.colors.button,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14
  },
  buttonDisabled: {
    opacity: 0.5
  },
  primaryButtonText: {
    color: theme.colors.buttonText,
    fontWeight: "700",
    fontSize: 15
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sectionTitle: {
    color: theme.colors.textPrimary,
    fontSize: 28,
    fontFamily: "serif"
  },
  metaText: {
    color: theme.colors.textSecondary,
    fontSize: 12
  },
  photoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    backgroundColor: "#121212",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.sm
  },
  photoThumb: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.md,
    overflow: "hidden",
    position: "relative"
  },
  photoThumbImg: {
    width: 64,
    height: 64
  },
  photoThumbOverlay: {
    position: "absolute",
    bottom: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderTopLeftRadius: theme.radius.md,
    paddingHorizontal: 4,
    paddingVertical: 1
  },
  photoThumbIcon: {
    fontSize: 13
  },
  photoInfo: {
    flex: 1,
    gap: 3
  },
  photoInfoTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "600"
  },
  timerText: {
    color: theme.colors.accent,
    fontSize: 16,
    fontWeight: "700"
  },
  photoHint: {
    color: theme.colors.textSecondary,
    fontSize: 12
  },
  ttlWrap: {
    gap: theme.spacing.sm
  },
  ttlRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs
  },
  ttlChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "#121212",
    paddingVertical: 8,
    paddingHorizontal: 12
  },
  ttlChipActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent
  },
  ttlChipText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: "600"
  },
  ttlChipTextActive: {
    color: "#1B1A17"
  },
  actionRow: {
    flexDirection: "row",
    gap: theme.spacing.sm
  },
  actionButton: {
    flex: 1
  },
  emptyState: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "#121212",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 160
  },
  ghostButton: {
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "#111111"
  },
  ghostButtonText: {
    color: theme.colors.textSecondary,
    fontSize: 13
  },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.9)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.md
  },
  viewerImage: {
    width: "100%",
    height: "82%",
    borderRadius: theme.radius.lg,
    resizeMode: "contain"
  },
  viewerDismiss: {
    position: "absolute",
    top: 52,
    right: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "#121212",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    zIndex: 10
  },
  viewerDismissText: {
    color: theme.colors.textPrimary,
    fontSize: 12,
    fontWeight: "700"
  }
});
