export type PhotoPayload = {
  photo_id: string;
  pairing_id: string;
  sender_name: string;
  mime_type: string;
  image_b64: string;
  created_at: string;
  expires_in_seconds: number;
  queued_count?: number;
};

export type PairingState = {
  pairingId: string;
  authToken: string;
  userName: string;
  partnerName?: string;
};
