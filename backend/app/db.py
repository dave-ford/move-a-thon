from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings
from .security import hash_secret


pool = ConnectionPool(settings.database_url, min_size=1, max_size=8, kwargs={"row_factory": dict_row}, open=False)


def open_pool() -> None:
    pool.open(wait=True)


@contextmanager
def get_conn():
    with pool.connection() as conn:
        yield conn


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id integer PRIMARY KEY DEFAULT 1,
                school_name text NOT NULL DEFAULT 'Move-a-thon',
                admin_pin_hash text NOT NULL,
                special_lap_duration_seconds integer NOT NULL DEFAULT 180,
                special_lap_name text,
                special_lap_image_path text,
                special_lap_started_at timestamptz,
                special_lap_ends_at timestamptz,
                CHECK (id = 1)
            );

            CREATE TABLE IF NOT EXISTS events (
                id bigserial PRIMARY KEY,
                name text NOT NULL,
                lap_distance_miles numeric(12, 6) NOT NULL DEFAULT 0.25,
                official_code_hash text NOT NULL,
                is_active boolean NOT NULL DEFAULT false,
                created_at timestamptz NOT NULL DEFAULT now(),
                started_at timestamptz,
                ended_at timestamptz
            );

            CREATE UNIQUE INDEX IF NOT EXISTS one_active_event
            ON events (is_active)
            WHERE is_active;

            CREATE TABLE IF NOT EXISTS lap_entries (
                id bigserial PRIMARY KEY,
                event_id bigint NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
                client_entry_id text NOT NULL,
                delta integer NOT NULL,
                entry_type text NOT NULL CHECK (entry_type IN ('official_tap', 'admin_correction')),
                client_created_at timestamptz,
                received_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (event_id, client_entry_id)
            );
            """
        )
        conn.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS special_lap_duration_seconds integer NOT NULL DEFAULT 180;")
        conn.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS special_lap_name text;")
        conn.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS special_lap_image_path text;")
        conn.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS special_lap_started_at timestamptz;")
        conn.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS special_lap_ends_at timestamptz;")
        admin_hash = hash_secret(settings.admin_pin, "admin")
        conn.execute(
            """
            INSERT INTO settings (id, admin_pin_hash)
            VALUES (1, %s)
            ON CONFLICT (id) DO NOTHING;
            """,
            (admin_hash,),
        )
        existing = conn.execute("SELECT id FROM events LIMIT 1").fetchone()
        if not existing:
            conn.execute(
                """
                INSERT INTO events (name, lap_distance_miles, official_code_hash, is_active, started_at)
                VALUES (%s, %s, %s, true, now());
                """,
                ("Test Event", 0.25, hash_secret("run", "official")),
            )
        conn.commit()
