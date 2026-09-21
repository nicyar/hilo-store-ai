#!/usr/bin/env python3
"""
Siembra de TARIFAS DE ENVIO DE PRUEBA -- no son tarifas contratadas reales.

Contexto: el checkout (Etapa 1, ver CLAUDE.md) necesita un costo de envio
por provincia para calcular `shipping_cents` server-side. El negocio
todavia no proveyo una grilla real de costos de envio, asi que este script
siembra las 24 jurisdicciones de Argentina (23 provincias + CABA) agrupadas
en 4 zonas, con valores de referencia googleados de tarifas PUBLICAS de
Correo Argentino / Andreani (2026) -- no una cotizacion contratada por el
negocio. Cada fila queda marcada con `es_prueba = 1`
(ver db/migrations/0007_shipping_rates.sql).

TARIFA DE PRUEBA -- no es un costo de envio real acordado por el negocio.
Reemplazar corriendo este mismo script con --reales despues de editar
TARIFAS_REALES_ARS, o actualizando la tabla directamente (sin olvidar poner
`es_prueba = 0` en esa fila), cuando el usuario provea la grilla definitiva.

Idempotencia / seguridad:
  - Por default, solo INSERTa filas para provincias que todavia no existen
    en la tabla (upsert por `provincia`) o actualiza el precio de filas que
    ya estan marcadas `es_prueba = 1` -- nunca pisa una fila que ya tiene
    `es_prueba = 0` (tarifa real cargada a mano), mismo criterio que
    seed_precios_prueba.py.
  - --reales usa TARIFAS_REALES_ARS en vez de las de prueba, y marca
    `es_prueba = 0` en las filas que toca.

Uso:
    python db/scripts/run_migrations.py                # (una vez) aplicar 0007
    python db/scripts/seed_shipping_rates.py [--db RUTA]
    python db/scripts/seed_shipping_rates.py --reales   # cuando haya grilla real
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = PROJECT_ROOT / "db" / "lyondor.sqlite3"

# Jurisdicciones agrupadas en 4 zonas, con tarifa de PRUEBA en PESOS (ARS).
# Fuente: valores de referencia googleados de tarifas publicas Correo
# Argentino / Andreani 2026 -- NO son una cotizacion contratada por el
# negocio. Se convierten a centavos al escribir.
ZONAS_DE_PRUEBA: dict[str, dict] = {
    "Zona 1 (AMBA)": {
        "precio_ars": 6000,
        "provincias": [
            "Ciudad Autonoma de Buenos Aires",
            "Buenos Aires",
        ],
    },
    "Zona 2 (Centro)": {
        "precio_ars": 9000,
        "provincias": [
            "Cordoba",
            "Santa Fe",
            "Entre Rios",
            "La Pampa",
        ],
    },
    "Zona 3 (Cuyo/NOA/NEA)": {
        "precio_ars": 12000,
        "provincias": [
            "Mendoza",
            "San Juan",
            "San Luis",
            "Tucuman",
            "Salta",
            "Jujuy",
            "Catamarca",
            "La Rioja",
            "Santiago del Estero",
            "Corrientes",
            "Misiones",
            "Chaco",
            "Formosa",
        ],
    },
    "Zona 4 (Patagonia)": {
        "precio_ars": 16000,
        "provincias": [
            "Neuquen",
            "Rio Negro",
            "Chubut",
            "Santa Cruz",
            "Tierra del Fuego",
        ],
    },
}

# Grilla REAL -- vacia hasta que el usuario la provea. Mismo formato que
# ZONAS_DE_PRUEBA: {provincia: precio_ars}. Completar y correr con --reales
# cuando el negocio de la lista definitiva.
TARIFAS_REALES_ARS: dict[str, int] = {}


def _grilla_de_prueba() -> dict[str, tuple[int, str]]:
    """Aplana ZONAS_DE_PRUEBA a {provincia: (precio_ars, zona)}."""
    grilla: dict[str, tuple[int, str]] = {}
    for zona, data in ZONAS_DE_PRUEBA.items():
        for provincia in data["provincias"]:
            grilla[provincia] = (data["precio_ars"], zona)
    return grilla


def seed_shipping_rates(db_path: Path, usar_reales: bool = False) -> dict:
    stats = {"insertadas": [], "actualizadas": [], "omitidas_ya_reales": []}

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        with conn:  # una sola transaccion
            if usar_reales:
                if not TARIFAS_REALES_ARS:
                    print(
                        "ERROR: --reales pedido pero TARIFAS_REALES_ARS esta "
                        "vacio en este script -- completalo primero.",
                        file=sys.stderr,
                    )
                    return stats
                items = [(prov, precio, None) for prov, precio in TARIFAS_REALES_ARS.items()]
                es_prueba_valor = 0
            else:
                items = [(prov, precio, zona) for prov, (precio, zona) in _grilla_de_prueba().items()]
                es_prueba_valor = 1

            for provincia, precio_ars, zona in items:
                precio_cents = precio_ars * 100
                existing = conn.execute(
                    "SELECT id, es_prueba FROM shipping_rates WHERE country_code = 'AR' AND provincia = ?",
                    (provincia,),
                ).fetchone()

                if existing is None:
                    conn.execute(
                        """
                        INSERT INTO shipping_rates
                            (country_code, provincia, zona, price_cents, es_prueba, activo)
                        VALUES ('AR', ?, ?, ?, ?, 1)
                        """,
                        (provincia, zona, precio_cents, es_prueba_valor),
                    )
                    stats["insertadas"].append((provincia, precio_cents))
                    continue

                row_id, row_es_prueba = existing
                if row_es_prueba == 0 and not usar_reales:
                    # Ya tiene una tarifa real cargada -- el seed de prueba
                    # nunca la pisa.
                    stats["omitidas_ya_reales"].append((provincia, precio_cents))
                    continue

                conn.execute(
                    """
                    UPDATE shipping_rates
                       SET price_cents = ?, zona = ?, es_prueba = ?, updated_at = datetime('now')
                     WHERE id = ?
                    """,
                    (precio_cents, zona, es_prueba_valor, row_id),
                )
                stats["actualizadas"].append((provincia, precio_cents))

        return stats
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument(
        "--reales",
        action="store_true",
        help="Siembra TARIFAS_REALES_ARS (marca es_prueba=0) en vez de la grilla de prueba.",
    )
    args = parser.parse_args()

    if not args.db.is_file():
        print(
            f"ERROR: no existe la base {args.db}. "
            f"Corre primero: python db/scripts/run_migrations.py",
            file=sys.stderr,
        )
        return 1

    stats = seed_shipping_rates(args.db, args.reales)

    tipo = "REALES" if args.reales else "de PRUEBA"
    print(f"\n--- Resultado de la siembra de tarifas de envio ({tipo}) ---")
    if not args.reales:
        print("(TARIFA DE PRUEBA -- no es un costo de envio contratado por el negocio)\n")

    if stats["insertadas"]:
        print(f"Filas insertadas ({len(stats['insertadas'])}):")
        for provincia, cents in stats["insertadas"]:
            print(f"  - {provincia}: ${cents / 100:.2f} ARS")
    if stats["actualizadas"]:
        print(f"\nFilas actualizadas ({len(stats['actualizadas'])}):")
        for provincia, cents in stats["actualizadas"]:
            print(f"  - {provincia}: ${cents / 100:.2f} ARS")
    if stats["omitidas_ya_reales"]:
        print(f"\nOmitidas, ya tenian tarifa real cargada ({len(stats['omitidas_ya_reales'])}):")
        for provincia, cents in stats["omitidas_ya_reales"]:
            print(f"  - {provincia}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
