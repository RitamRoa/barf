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
