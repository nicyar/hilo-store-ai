#!/usr/bin/env python3
"""
Siembra de PRECIOS DE PRUEBA -- no son precios reales del negocio.

Contexto: el carrito de compras (Valentina, vanilla JS sobre index.html) está
bloqueado porque los 7 productos reales de `products` tienen
`precio_centavos` NULL -- el negocio todavía no cargó la lista de precios
real. Este script rellena esa columna con valores de prueba mínimamente
creíbles (variados, entre $2500 y $6000 ARS por artículo) para que el
frontend pueda renderizar precios y probar el flujo de compra de punta a
punta, y marca cada fila que toca con `precio_es_prueba = 1`
(ver migración db/migrations/0004_precio_prueba_flag.sql).

PRECIO DE PRUEBA -- no es un precio real del negocio, ver
precio_es_prueba = 1 en la tabla `products`. Reemplazar corriendo este mismo
script con datos reales (actualizando PRECIOS_DE_PRUEBA_ARS más abajo, o
pasando --precios con un JSON {articulo: precio_ars}), o actualizando la
tabla directamente, cuando el usuario provea la lista de precios definitiva.
Al reemplazar un precio real "a mano" (UPDATE directo a la tabla), acordarse
de poner también `precio_es_prueba = 0` en esa fila para que este script dej
de tocarla.

Idempotencia / seguridad:
  - Solo actualiza filas donde `precio_centavos IS NULL` y
    `precio_es_prueba = 0` (el estado inicial, sin precio cargado). Si una
    fila ya tiene un precio (de prueba ya sembrado, o real cargado a mano),
    el script NO la toca -- correrlo de nuevo no duplica filas ni pisa un
    precio real ya cargado.
  - Para forzar un re-seed de filas que ya tienen precio de prueba (p.ej.
    para ajustar los valores de prueba antes de tener los reales), usar
    --reseed-solo-prueba, que solo afecta filas con precio_es_prueba = 1
    (nunca las que tienen precio_es_prueba = 0, es decir precios reales).

Uso:
    python db/scripts/run_migrations.py              # (una vez) aplicar 0004
    python db/scripts/seed_precios_prueba.py [--db RUTA]
    python db/scripts/seed_precios_prueba.py --reseed-solo-prueba
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = PROJECT_ROOT / "db" / "lyondor.sqlite3"

# Precios de prueba en PESOS (ARS), por `articulo` (código de negocio del
# proveedor, columna `products.articulo`). Variados a propósito -- no es el
# mismo número para los 7 productos -- para que no se confunda con un precio
# único inventado al mirar la tabla. Se convierten a centavos al escribir.
#
# ESTOS NO SON PRECIOS REALES. Reemplazar por la lista real del negocio
# cuando esté disponible.
PRECIOS_DE_PRUEBA_ARS: dict[str, int] = {
    "12": 2890,   # MULTIFILAMENTO
    "81": 3450,   # DRALON
    "316": 4200,  # BUCANERA
    "700": 5100,  # SUPPORT
    "720": 5800,  # SUPPORT 3/4
    "811": 3650,  # DRALON
    "978": 2750,  # MULTIFILAMENTO
}


def seed_precios_prueba(
    db_path: Path,
    precios_ars: dict[str, int],
    reseed_solo_prueba: bool = False,
) -> dict:
    stats = {
        "actualizados": [],
        "sin_precio_de_prueba_definido": [],
        "omitidos_ya_tenian_precio": [],
    }

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        with conn:  # una sola transacción
            rows = conn.execute(
                "SELECT id, articulo, nombre, precio_centavos, precio_es_prueba "
                "FROM products ORDER BY id"
            ).fetchall()

            for product_id, articulo, nombre, precio_centavos, precio_es_prueba in rows:
                if reseed_solo_prueba:
                    elegible = precio_es_prueba == 1
                else:
                    elegible = precio_centavos is None and precio_es_prueba == 0

                if not elegible:
                    stats["omitidos_ya_tenian_precio"].append(
                        (articulo, nombre, precio_centavos, precio_es_prueba)
                    )
                    continue

                if articulo not in precios_ars:
                    stats["sin_precio_de_prueba_definido"].append((articulo, nombre))
                    continue

                nuevo_precio_centavos = precios_ars[articulo] * 100
                conn.execute(
                    """
                    UPDATE products
                       SET precio_centavos = ?,
                           precio_es_prueba = 1,
                           updated_at = datetime('now')
                     WHERE id = ?
                    """,
                    (nuevo_precio_centavos, product_id),
                )
                stats["actualizados"].append((articulo, nombre, nuevo_precio_centavos))

        return stats
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument(
        "--reseed-solo-prueba",
        action="store_true",
        help=(
            "Vuelve a sembrar precios de prueba en filas que YA tienen "
            "precio_es_prueba=1 (por ejemplo para ajustar los valores de "
            "prueba). Nunca toca filas con precio_es_prueba=0."
        ),
    )
    args = parser.parse_args()

    if not args.db.is_file():
        print(
            f"ERROR: no existe la base {args.db}. "
            f"Corré primero: python db/scripts/run_migrations.py",
            file=sys.stderr,
        )
        return 1

    stats = seed_precios_prueba(args.db, PRECIOS_DE_PRUEBA_ARS, args.reseed_solo_prueba)

    print("\n--- Resultado de la siembra de precios de PRUEBA ---")
    print("(PRECIO DE PRUEBA -- no es un precio real del negocio)\n")
    if stats["actualizados"]:
        print(f"Filas actualizadas ({len(stats['actualizados'])}):")
        for articulo, nombre, centavos in stats["actualizados"]:
            print(f"  - art. {articulo} ({nombre}): ${centavos / 100:.2f} ARS [prueba]")
    else:
        print("Filas actualizadas: 0")

    if stats["omitidos_ya_tenian_precio"]:
        print(f"\nOmitidas, ya tenían precio ({len(stats['omitidos_ya_tenian_precio'])}):")
        for articulo, nombre, centavos, es_prueba in stats["omitidos_ya_tenian_precio"]:
            tipo = "prueba" if es_prueba else "real"
            print(f"  - art. {articulo} ({nombre}): ${centavos / 100:.2f} ARS [{tipo}]")

    if stats["sin_precio_de_prueba_definido"]:
        print(
            f"\nADVERTENCIA: {len(stats['sin_precio_de_prueba_definido'])} producto(s) "
            f"sin precio_centavos y sin precio de prueba definido en "
            f"PRECIOS_DE_PRUEBA_ARS (agregarlos ahí para poder sembrarlos):"
        )
        for articulo, nombre in stats["sin_precio_de_prueba_definido"]:
            print(f"  - art. {articulo} ({nombre})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
