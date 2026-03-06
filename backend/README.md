# backend

FastAPI server for pairing + ephemeral photo storage using Redis only.

## Run

From inside `backend/`:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

From project root (if your venv is at `barf/venv`):

```bash
.\venv\Scripts\Activate.ps1
cd backend
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Redis is required at `REDIS_URL`.

## Security

Set a strong secret in `.env`:

```bash
PAIRING_TOKEN_SECRET=replace-with-a-long-random-secret
```

`join-code` and `pairing/status` return a signed `auth_token` for each user.
Use that token for:

- `POST /photo/upload` as multipart field `auth_token`
- `GET /check_photo/{pairing_id}` as query `auth_token`
- `WS /ws/pairing/{pairing_id}` as query `auth_token`
