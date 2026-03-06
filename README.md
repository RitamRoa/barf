# barf

A minimal couple photo-sharing app:
- Pair once with a 6-digit code
- Store pairing UUID locally on both devices
- Store a signed pairing auth token locally on both devices
- Share exactly one active photo per pair
- Auto-expire photos with Redis TTL (24h by default)
- Live updates through WebSocket, plus polling fallback

## Project Structure

- `backend/`: FastAPI + Redis
- `mobile/`: React Native (Expo)
- `docker-compose.yml`: local Redis service

## 1. Start Redis

```bash
docker compose up -d
```

## 2. Run Backend

```bash
cd backend
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

If you are at project root and using the root virtual environment instead:

```bash
.\venv\Scripts\Activate.ps1
cd backend
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### FastAPI Endpoints

- `POST /pairing/create-code`
  - body: `{ "name": "A" }`
  - returns: `{ code, expires_in_seconds }`

- `POST /pairing/join-code`
  - body: `{ "name": "B", "code": "123456" }`
  - returns: `{ pairing_id, partner_name, auth_token }`

- `GET /pairing/status/{code}`
  - poll fallback for creator device
  - when matched, returns: `{ matched, pairing_id, partner_name, auth_token }`

- `POST /photo/upload` (multipart)
  - fields: `pairing_id`, `auth_token`, `ttl_hours`, `image`
  - overwrites existing pair photo and sets new TTL

- `GET /check_photo/{pairing_id}`
  - query: `auth_token`
  - check for waiting photo after offline period

- `WS /ws/pairing-code/{code}`
  - notifies creator when joiner matches

- `WS /ws/pairing/{pairing_id}`
  - query: `auth_token`
  - broadcasts `photo_uploaded` event instantly

## 3. Run Mobile App

```bash
cd mobile
npm install
npm run start
```

Important for emulators/devices:
- If Android emulator cannot reach backend, edit `mobile/src/api.ts` and change `API_BASE` to `http://10.0.2.2:8000`.
- For real devices, use your machine LAN IP (example `http://192.168.1.20:8000`).

Optional (recommended): set `EXPO_PUBLIC_API_BASE` before starting Expo so app and websocket use a stable host.

```bash
# Example (PowerShell)
$env:EXPO_PUBLIC_API_BASE="http://127.0.0.1:8000"
npm run start
```

## Pairing Flow

1. User A enters name and taps `Generate code`.
2. Backend stores 6-digit code in Redis with 10-min TTL.
3. User B enters same code and joins.
4. Backend generates UUID `pairing_id` and sends it to B immediately.
5. Backend notifies A over WebSocket (and A can poll `/pairing/status/{code}` fallback).
6. Both clients save `pairing_id` and `auth_token` in AsyncStorage so they remain paired without server-side permanent records.

## Photo Flow

1. Any paired user uploads one image with their signed `auth_token`.
2. Backend stores image in Redis key `photo:{pairing_id}` with TTL.
3. New upload overwrites the old one (same key) and resets TTL.
4. Backend pushes `photo_uploaded` event to connected partner.
5. Offline partner checks `/check_photo/{pairing_id}?auth_token=...` when app opens.

## Mobile Features Added

- Camera capture and gallery picker for sending photos
- TTL selector in app: `1h`, `6h`, `24h`, or custom (`1-168` hours)
- Tap photo to open a larger full-screen viewer
- Signed token guard in API client for upload/check/websocket

## Frontend 24-Hour Countdown

The backend returns `expires_in_seconds` for each photo fetch/upload event.

In the app:
1. Convert to absolute expiry timestamp: `expiresAtMs = Date.now() + expires_in_seconds * 1000`.
2. Run `setInterval` every second and compute:
   - `remaining = max(0, floor((expiresAtMs - Date.now()) / 1000))`
3. Display formatted `HH:MM:SS`.
4. When `remaining` hits `0`, clear photo from UI.

This keeps countdown accurate even if the app was backgrounded and resumed.
