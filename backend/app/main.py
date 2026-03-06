import base64
import hashlib
import hmac
import json
import random
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import redis.asyncio as redis
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import settings

PAIRING_CODE_TTL_SECONDS = 10 * 60
PAIRING_RESULT_TTL_SECONDS = 10 * 60
DEFAULT_PHOTO_TTL_SECONDS = 24 * 60 * 60
MAX_PHOTO_TTL_SECONDS = 7 * 24 * 60 * 60


class CreateCodeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class JoinCodeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    code: str = Field(pattern=r"^\d{6}$")


class UploadResponse(BaseModel):
    pairing_id: str
    expires_in_seconds: int


class ConnectionHub:
    def __init__(self) -> None:
        self.rooms: dict[str, set[WebSocket]] = {}

    async def connect(self, room: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.rooms.setdefault(room, set()).add(websocket)

    def disconnect(self, room: str, websocket: WebSocket) -> None:
        clients = self.rooms.get(room)
        if not clients:
            return
        clients.discard(websocket)
        if not clients:
            self.rooms.pop(room, None)

    async def broadcast(self, room: str, payload: dict[str, Any]) -> None:
        clients = list(self.rooms.get(room, set()))
        stale: list[WebSocket] = []
        for client in clients:
            try:
                await client.send_json(payload)
            except Exception:
                stale.append(client)
        for client in stale:
            self.disconnect(room, client)


app = FastAPI(title="barf-api", version="1.0.0")
hub = ConnectionHub()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.allowed_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    app.state.redis = redis.from_url(settings.redis_url, decode_responses=True)


@app.on_event("shutdown")
async def shutdown() -> None:
    await app.state.redis.close()


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def pairing_code_key(code: str) -> str:
    return f"pairing:code:{code}"


def pairing_result_key(code: str) -> str:
    return f"pairing:result:{code}"


def photo_key(pairing_id: str) -> str:
    return f"photo:{pairing_id}"


def _token_signature(payload_b64: str) -> str:
    secret = settings.pairing_token_secret.encode("utf-8")
    digest = hmac.new(secret, payload_b64.encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def issue_pairing_token(*, pairing_id: str, user_name: str) -> str:
    payload = {
        "pairing_id": pairing_id,
        "user_name": user_name,
        "iat": utc_now_iso(),
    }
    payload_json = json.dumps(payload, separators=(",", ":"))
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode("utf-8")).decode("ascii").rstrip("=")
    signature = _token_signature(payload_b64)
    return f"{payload_b64}.{signature}"


def verify_pairing_token(token: str) -> dict[str, Any]:
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid auth token") from exc

    expected = _token_signature(payload_b64)
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid auth token")

    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    try:
        payload_raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        payload = json.loads(payload_raw)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid auth token") from exc

    if not payload.get("pairing_id") or not payload.get("user_name"):
        raise HTTPException(status_code=401, detail="Invalid auth token")

    return payload


async def reserve_unique_code(r: redis.Redis) -> str:
    for _ in range(20):
        code = f"{random.randint(0, 999999):06d}"
        locked = await r.set(pairing_code_key(code), "_pending_", ex=PAIRING_CODE_TTL_SECONDS, nx=True)
        if locked:
            return code
    raise HTTPException(status_code=500, detail="Could not generate unique code")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/pairing/create-code")
async def create_code(body: CreateCodeRequest) -> dict[str, Any]:
    r: redis.Redis = app.state.redis
    code = await reserve_unique_code(r)

    payload = {
        "initiator_name": body.name.strip(),
        "created_at": utc_now_iso(),
    }
    await r.set(pairing_code_key(code), json.dumps(payload), ex=PAIRING_CODE_TTL_SECONDS)

    return {
        "code": code,
        "expires_in_seconds": PAIRING_CODE_TTL_SECONDS,
    }


@app.post("/pairing/join-code")
async def join_code(body: JoinCodeRequest) -> dict[str, Any]:
    r: redis.Redis = app.state.redis
    code = body.code.strip()

    raw = await r.get(pairing_code_key(code))
    if not raw or raw == "_pending_":
        raise HTTPException(status_code=404, detail="Code is invalid or expired")

    waiting = json.loads(raw)
    pairing_id = str(uuid4())
    initiator_name = waiting["initiator_name"]
    joiner_name = body.name.strip()
    initiator_token = issue_pairing_token(pairing_id=pairing_id, user_name=initiator_name)
    joiner_token = issue_pairing_token(pairing_id=pairing_id, user_name=joiner_name)

    result = {
        "pairing_id": pairing_id,
        "initiator_name": initiator_name,
        "joiner_name": joiner_name,
        "initiator_auth_token": initiator_token,
        "joiner_auth_token": joiner_token,
        "matched_at": utc_now_iso(),
    }

    await r.set(pairing_result_key(code), json.dumps(result), ex=PAIRING_RESULT_TTL_SECONDS)
    await r.delete(pairing_code_key(code))

    await hub.broadcast(
        room=f"pairing_code:{code}",
        payload={
            "event": "pairing_matched",
            "pairing_id": pairing_id,
            "partner_name": joiner_name,
            "auth_token": initiator_token,
        },
    )

    return {
        "pairing_id": pairing_id,
        "partner_name": initiator_name,
        "auth_token": joiner_token,
    }


@app.get("/pairing/status/{code}")
async def pairing_status(code: str) -> dict[str, Any]:
    if not code.isdigit() or len(code) != 6:
        raise HTTPException(status_code=400, detail="Invalid code format")

    r: redis.Redis = app.state.redis
    result_raw = await r.get(pairing_result_key(code))
    if result_raw:
        result = json.loads(result_raw)
        ttl = await r.ttl(pairing_result_key(code))
        return {
            "matched": True,
            "pairing_id": result["pairing_id"],
            "partner_name": result["joiner_name"],
            "auth_token": result["initiator_auth_token"],
            "expires_in_seconds": max(ttl, 0),
        }

    code_ttl = await r.ttl(pairing_code_key(code))
    if code_ttl > 0:
        return {"matched": False, "expires_in_seconds": code_ttl}

    return {"matched": False, "expired": True}


@app.post("/photo/upload", response_model=UploadResponse)
async def upload_photo(
    pairing_id: str = Form(...),
    auth_token: str = Form(...),
    ttl_hours: int = Form(24),
    image: UploadFile = File(...),
) -> UploadResponse:
    if ttl_hours < 1:
        raise HTTPException(status_code=400, detail="ttl_hours must be >= 1")

    ttl_seconds = min(ttl_hours * 3600, MAX_PHOTO_TTL_SECONDS)

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are allowed")

    token_payload = verify_pairing_token(auth_token)
    if token_payload["pairing_id"] != pairing_id:
        raise HTTPException(status_code=403, detail="Token does not match pairing")
    sender_name = str(token_payload["user_name"]).strip()

    raw_image = await image.read()
    if len(raw_image) > settings.max_upload_size_bytes:
        raise HTTPException(status_code=413, detail="Image exceeds max allowed size")

    encoded = base64.b64encode(raw_image).decode("ascii")
    payload = {
        "pairing_id": pairing_id,
        "sender_name": sender_name.strip(),
        "mime_type": image.content_type,
        "image_b64": encoded,
        "created_at": utc_now_iso(),
    }

    r: redis.Redis = app.state.redis
    await r.set(photo_key(pairing_id), json.dumps(payload), ex=ttl_seconds)

    await hub.broadcast(
        room=f"pairing:{pairing_id}",
        payload={
            "event": "photo_uploaded",
            "pairing_id": pairing_id,
            "sender_name": sender_name.strip(),
            "mime_type": image.content_type,
            "image_b64": encoded,
            "expires_in_seconds": ttl_seconds,
            "created_at": payload["created_at"],
        },
    )

    return UploadResponse(pairing_id=pairing_id, expires_in_seconds=ttl_seconds)


@app.get("/check_photo/{pairing_id}")
async def check_photo(pairing_id: str, auth_token: str) -> dict[str, Any]:
    token_payload = verify_pairing_token(auth_token)
    if token_payload["pairing_id"] != pairing_id:
        raise HTTPException(status_code=403, detail="Token does not match pairing")

    r: redis.Redis = app.state.redis
    raw = await r.get(photo_key(pairing_id))
    if not raw:
        return {"has_photo": False}

    ttl = await r.ttl(photo_key(pairing_id))
    payload = json.loads(raw)
    return {
        "has_photo": True,
        "pairing_id": pairing_id,
        "sender_name": payload["sender_name"],
        "mime_type": payload["mime_type"],
        "image_b64": payload["image_b64"],
        "created_at": payload["created_at"],
        "expires_in_seconds": max(ttl, 0),
    }


@app.websocket("/ws/pairing-code/{code}")
async def ws_pairing_code(websocket: WebSocket, code: str) -> None:
    if not code.isdigit() or len(code) != 6:
        await websocket.close(code=1008)
        return

    room = f"pairing_code:{code}"
    await hub.connect(room, websocket)
    await websocket.send_json({"event": "connected", "room": room})

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect(room, websocket)


@app.websocket("/ws/pairing/{pairing_id}")
async def ws_pairing(websocket: WebSocket, pairing_id: str) -> None:
    auth_token = websocket.query_params.get("auth_token")
    if not auth_token:
        await websocket.close(code=1008)
        return

    try:
        token_payload = verify_pairing_token(auth_token)
    except HTTPException:
        await websocket.close(code=1008)
        return

    if token_payload["pairing_id"] != pairing_id:
        await websocket.close(code=1008)
        return

    room = f"pairing:{pairing_id}"
    await hub.connect(room, websocket)
    await websocket.send_json({"event": "connected", "room": room})

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect(room, websocket)
