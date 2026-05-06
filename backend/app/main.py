import asyncio
import csv
import io
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .db import get_conn, init_db, open_pool
from .security import hash_secret, sign_token, verify_secret, verify_token

app = FastAPI(title="Move-a-thon")
live_clients: set[asyncio.Queue[dict[str, Any]]] = set()

if settings.cors_origin:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


class LoginRequest(BaseModel):
    code: str = Field(min_length=1, max_length=128)


class EventRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    lap_distance_miles: Decimal = Field(gt=0)
    official_code: str = Field(min_length=1, max_length=128)


class EventPatchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    lap_distance_miles: Decimal = Field(gt=0)
    official_code: str | None = Field(default=None, max_length=128)


class LapEntryRequest(BaseModel):
    client_entry_id: str = Field(min_length=1, max_length=120)
    client_created_at: datetime | None = None


class LapBatchRequest(BaseModel):
    entries: list[LapEntryRequest] = Field(default_factory=list, max_length=1000)


class CorrectionRequest(BaseModel):
    delta: int = Field(ge=-100000, le=100000)


class SettingsRequest(BaseModel):
    school_name: str = Field(min_length=1, max_length=120)


def admin_required(admin_token: str | None = Cookie(default=None)) -> None:
    if not verify_token(admin_token, "admin"):
        raise HTTPException(status_code=401, detail="Admin login required")


def official_required(official_token: str | None = Cookie(default=None)) -> None:
    if not verify_token(official_token, "official"):
        raise HTTPException(status_code=401, detail="Official login required")


def row_to_json(row: dict[str, Any]) -> dict[str, Any]:
    return {key: float(value) if isinstance(value, Decimal) else value for key, value in row.items()}


def get_state() -> dict[str, Any]:
    with get_conn() as conn:
        settings_row = conn.execute("SELECT school_name FROM settings WHERE id = 1").fetchone()
        event = conn.execute(
            """
            SELECT id, name, lap_distance_miles, is_active, created_at, started_at, ended_at
            FROM events
            WHERE is_active = true
            LIMIT 1;
            """
        ).fetchone()
        if not event:
            return {"school_name": settings_row["school_name"], "event": None, "laps": 0, "miles": 0}
        laps = conn.execute(
            "SELECT COALESCE(SUM(delta), 0)::int AS total FROM lap_entries WHERE event_id = %s",
            (event["id"],),
        ).fetchone()["total"]
        lap_distance = Decimal(event["lap_distance_miles"])
        return {
            "school_name": settings_row["school_name"],
            "event": row_to_json(event),
            "laps": laps,
            "miles": float(Decimal(laps) * lap_distance),
        }


async def publish_state() -> None:
    state = get_state()
    stale_clients: list[asyncio.Queue[dict[str, Any]]] = []
    for client in live_clients:
        try:
            client.put_nowait(state)
        except asyncio.QueueFull:
            stale_clients.append(client)
    for client in stale_clients:
        live_clients.discard(client)


@app.on_event("startup")
async def startup() -> None:
    open_pool()
    init_db()


@app.get("/api/state")
def api_state() -> dict[str, Any]:
    return get_state()


@app.post("/api/admin/login")
def admin_login(payload: LoginRequest, response: Response) -> dict[str, str]:
    with get_conn() as conn:
        digest = conn.execute("SELECT admin_pin_hash FROM settings WHERE id = 1").fetchone()["admin_pin_hash"]
    if not verify_secret(payload.code, "admin", digest):
        raise HTTPException(status_code=401, detail="Invalid admin PIN")
    response.set_cookie("admin_token", sign_token("admin"), httponly=True, samesite="lax")
    return {"status": "ok"}


@app.post("/api/official/login")
def official_login(payload: LoginRequest, response: Response) -> dict[str, str]:
    with get_conn() as conn:
        event = conn.execute("SELECT official_code_hash FROM events WHERE is_active = true").fetchone()
    if not event or not verify_secret(payload.code, "official", event["official_code_hash"]):
        raise HTTPException(status_code=401, detail="Invalid official code")
    response.set_cookie("official_token", sign_token("official"), httponly=True, samesite="lax")
    return {"status": "ok"}


@app.post("/api/admin/logout")
def admin_logout(response: Response) -> dict[str, str]:
    response.delete_cookie("admin_token")
    return {"status": "ok"}


@app.post("/api/official/logout")
def official_logout(response: Response) -> dict[str, str]:
    response.delete_cookie("official_token")
    return {"status": "ok"}


@app.get("/api/events", dependencies=[Depends(admin_required)])
def list_events() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT e.id, e.name, e.lap_distance_miles, e.is_active, e.created_at, e.started_at, e.ended_at,
                   COALESCE(SUM(l.delta), 0)::int AS laps
            FROM events e
            LEFT JOIN lap_entries l ON l.event_id = e.id
            GROUP BY e.id
            ORDER BY e.created_at DESC;
            """
        ).fetchall()
    return [row_to_json(row) for row in rows]


@app.post("/api/events", dependencies=[Depends(admin_required)])
async def create_event(payload: EventRequest) -> dict[str, Any]:
    with get_conn() as conn:
        row = conn.execute(
            """
            INSERT INTO events (name, lap_distance_miles, official_code_hash)
            VALUES (%s, %s, %s)
            RETURNING id, name, lap_distance_miles, is_active, created_at, started_at, ended_at;
            """,
            (payload.name, payload.lap_distance_miles, hash_secret(payload.official_code, "official")),
        ).fetchone()
        conn.commit()
    return row_to_json(row)


@app.patch("/api/events/{event_id}", dependencies=[Depends(admin_required)])
async def update_event(event_id: int, payload: EventPatchRequest) -> dict[str, Any]:
    with get_conn() as conn:
        if payload.official_code:
            row = conn.execute(
                """
                UPDATE events
                SET name = %s, lap_distance_miles = %s, official_code_hash = %s
                WHERE id = %s
                RETURNING id, name, lap_distance_miles, is_active, created_at, started_at, ended_at;
                """,
                (payload.name, payload.lap_distance_miles, hash_secret(payload.official_code, "official"), event_id),
            ).fetchone()
        else:
            row = conn.execute(
                """
                UPDATE events
                SET name = %s, lap_distance_miles = %s
                WHERE id = %s
                RETURNING id, name, lap_distance_miles, is_active, created_at, started_at, ended_at;
                """,
                (payload.name, payload.lap_distance_miles, event_id),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Event not found")
        conn.commit()
    await publish_state()
    return row_to_json(row)


@app.post("/api/events/{event_id}/activate", dependencies=[Depends(admin_required)])
async def activate_event(event_id: int) -> dict[str, str]:
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM events WHERE id = %s", (event_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Event not found")
        conn.execute("UPDATE events SET is_active = false WHERE is_active = true")
        conn.execute("UPDATE events SET is_active = true, started_at = COALESCE(started_at, now()) WHERE id = %s", (event_id,))
        conn.commit()
    await publish_state()
    return {"status": "ok"}


@app.post("/api/admin/settings", dependencies=[Depends(admin_required)])
async def update_settings(payload: SettingsRequest) -> dict[str, str]:
    with get_conn() as conn:
        conn.execute("UPDATE settings SET school_name = %s WHERE id = 1", (payload.school_name,))
        conn.commit()
    await publish_state()
    return {"status": "ok"}


@app.post("/api/laps", dependencies=[Depends(official_required)])
async def add_lap(payload: LapEntryRequest) -> dict[str, Any]:
    return await add_laps(LapBatchRequest(entries=[payload]))


@app.post("/api/laps/batch", dependencies=[Depends(official_required)])
async def add_laps(payload: LapBatchRequest) -> dict[str, Any]:
    if not payload.entries:
        return {"accepted": 0, "state": get_state()}
    with get_conn() as conn:
        event = conn.execute("SELECT id FROM events WHERE is_active = true").fetchone()
        if not event:
            raise HTTPException(status_code=409, detail="No active event")
        accepted = 0
        for entry in payload.entries:
            result = conn.execute(
                """
                INSERT INTO lap_entries (event_id, client_entry_id, delta, entry_type, client_created_at)
                VALUES (%s, %s, 1, 'official_tap', %s)
                ON CONFLICT (event_id, client_entry_id) DO NOTHING
                RETURNING id;
                """,
                (event["id"], entry.client_entry_id, entry.client_created_at),
            ).fetchone()
            if result:
                accepted += 1
        conn.commit()
    state = get_state()
    await publish_state()
    return {"accepted": accepted, "state": state}


@app.post("/api/admin/correction", dependencies=[Depends(admin_required)])
async def correction(payload: CorrectionRequest) -> dict[str, Any]:
    if payload.delta == 0:
        return get_state()
    with get_conn() as conn:
        event = conn.execute("SELECT id FROM events WHERE is_active = true").fetchone()
        if not event:
            raise HTTPException(status_code=409, detail="No active event")
        conn.execute(
            """
            INSERT INTO lap_entries (event_id, client_entry_id, delta, entry_type)
            VALUES (%s, %s, %s, 'admin_correction');
            """,
            (event["id"], f"admin-{uuid4()}", payload.delta),
        )
        conn.commit()
    await publish_state()
    return get_state()


@app.get("/api/admin/export/{event_id}.csv", dependencies=[Depends(admin_required)])
def export_event(event_id: int) -> StreamingResponse:
    with get_conn() as conn:
        event = conn.execute("SELECT name FROM events WHERE id = %s", (event_id,)).fetchone()
        if not event:
            raise HTTPException(status_code=404, detail="Event not found")
        rows = conn.execute(
            """
            SELECT id, client_entry_id, delta, entry_type, client_created_at, received_at
            FROM lap_entries
            WHERE event_id = %s
            ORDER BY received_at, id;
            """,
            (event_id,),
        ).fetchall()
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=["id", "client_entry_id", "delta", "entry_type", "client_created_at", "received_at"])
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="moveathon-event-{event_id}.csv"'},
    )


@app.get("/api/live")
async def live() -> StreamingResponse:
    async def stream():
        client: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=8)
        live_clients.add(client)
        yield f"data: {json.dumps(get_state(), default=str)}\n\n"
        try:
            while True:
                try:
                    state = await asyncio.wait_for(client.get(), timeout=20)
                    yield f"data: {json.dumps(state, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            live_clients.discard(client)

    return StreamingResponse(stream(), media_type="text/event-stream")


static_dir = Path(__file__).resolve().parents[2] / "static"
if static_dir.exists():
    app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")


@app.get("/{path:path}")
def spa(path: str) -> FileResponse:
    index = static_dir / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="Frontend has not been built")
