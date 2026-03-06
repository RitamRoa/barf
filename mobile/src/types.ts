export type PhotoPayload = {
  pairing_id: string;
  sender_name: string;
  mime_type: string;
  image_b64: string;
  created_at: string;
  expires_in_seconds: number;
};

export type PairingState = {
  pairingId: string;
  userName: string;
  partnerName?: string;
};
