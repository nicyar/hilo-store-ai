#!/usr/bin/env python3
"""
Runner de migraciones para la base SQLite del proyecto.

Aplica, en orden alfabético/numérico, cada archivo .sql de db/migrations
que todavía no esté registrado en la tabla schema_migrations. Es idempotente:
correrlo de nuevo sobre una base ya migrada no hace nada (no falla, no
duplica nada).

Uso:
    python db/scripts/run_migrations.py [--db RUTA_DB]

Por default usa db/lyondor.sqlite3 (relativo a la raíz del proyecto,
calculada a partir de la ubicación de este archivo, no del cwd).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = PROJECT_ROOT / "db" / "migrations"
DEFAULT_DB_PATH = PROJECT_ROOT / "db" / "lyondor.sqlite3"


def get_applied_versions(conn: sqlite3.Connection) -> set[str]:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {r[0] for r in rows}


def run_migrations(db_path: Path) -> list[str]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    applied_now: list[str] = []

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        already_applied = get_applied_versions(conn)

        migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        if not migration_files:
            print(f"No hay archivos de migración en {MIGRATIONS_DIR}")
            return applied_now

        for path in migration_files:
            version = path.stem
            if version in already_applied:
                print(f"[skip] {version} (ya aplicada)")
                continue

            sql = path.read_text(encoding="utf-8")
            print(f"[apply] {version} ...")
            with conn:  # transacción: todo o nada por archivo
                conn.executescript(sql)
                conn.execute(
                    "INSERT INTO schema_migrations (version) VALUES (?)",
                    (version,),
                )
            applied_now.append(version)
            print(f"[ok] {version}")

        return applied_now
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Ruta al archivo sqlite (default: {DEFAULT_DB_PATH})",
    )
    args = parser.parse_args()

    applied = run_migrations(args.db)
    print(f"\nBase: {args.db}")
    print(f"Migraciones aplicadas en esta corrida: {len(applied)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
