#!/usr/bin/env python3
"""
ETL de CARGA (no de extracción) para el catálogo de Lyondor.

Lee data/catalogo_lyondor.json (generado por el scraper de Door) y hace
upsert de cada producto en la tabla `products`, usando `slug_o_id_origen`
(junto con `proveedor`) como clave de idempotencia: volver a correr este
script después de un nuevo scrape actualiza los productos existentes en vez
de duplicarlos, y reemplaza el set de imágenes asociado respetando el orden
en el que vienen en el JSON.

No inventa precio/stock ni variantes: esos campos quedan NULL / la tabla
product_variants queda vacía hasta que haya datos reales.

Uso:
    python db/scripts/run_migrations.py        # (una vez) crear el esquema
    python db/scripts/load_catalogo_lyondor.py [--json RUTA] [--db RUTA]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_JSON_PATH = PROJECT_ROOT / "data" / "catalogo_lyondor.json"
DEFAULT_DB_PATH = PROJECT_ROOT / "db" / "lyondor.sqlite3"
PROVEEDOR = "lyondor"


def upsert_product(conn: sqlite3.Connection, producto: dict) -> tuple[int, bool]:
    """Inserta o actualiza un producto. Devuelve (product_id, fue_insertado)."""
    slug = producto["slug_o_id_origen"]
    articulo = producto["articulo"]
    nombre = producto["nombre"]
    descripcion = producto.get("descripcion")
    url_origen = producto.get("url_origen")

    existing = conn.execute(
        "SELECT id FROM products WHERE proveedor = ? AND slug_o_id_origen = ?",
        (PROVEEDOR, slug),
    ).fetchone()

    if existing is None:
        cur = conn.execute(
            """
            INSERT INTO products
                (proveedor, slug_o_id_origen, articulo, nombre, descripcion, url_origen)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (PROVEEDOR, slug, articulo, nombre, descripcion, url_origen),
        )
        return cur.lastrowid, True

    product_id = existing[0]
    conn.execute(
        """
        UPDATE products
           SET articulo = ?,
               nombre = ?,
               descripcion = ?,
               url_origen = ?,
               updated_at = datetime('now')
         WHERE id = ?
        """,
        (articulo, nombre, descripcion, url_origen, product_id),
    )
    return product_id, False


def replace_images(conn: sqlite3.Connection, product_id: int, imagenes: list[str]) -> int:
    """Reemplaza el set de imágenes del producto, preservando el orden del JSON."""
    conn.execute("DELETE FROM product_images WHERE product_id = ?", (product_id,))
    for position, path in enumerate(imagenes):
        conn.execute(
            "INSERT INTO product_images (product_id, path, position) VALUES (?, ?, ?)",
            (product_id, path, position),
        )
    return len(imagenes)


def check_image_files_exist(imagenes: list[str]) -> list[str]:
    """Devuelve la lista de paths que el JSON referencia pero no existen en disco."""
    missing = []
    for rel_path in imagenes:
        if not (PROJECT_ROOT / rel_path).is_file():
            missing.append(rel_path)
    return missing


def load_catalogo(json_path: Path, db_path: Path) -> dict:
    data = json.loads(json_path.read_text(encoding="utf-8"))
    productos = data.get("productos", [])
    fallidos = data.get("fallidos", [])

    stats = {
        "productos_en_json": len(productos),
        "fallidos_en_json": len(fallidos),
        "insertados": 0,
        "actualizados": 0,
        "imagenes_cargadas": 0,
        "imagenes_faltantes_en_disco": [],
    }

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        with conn:  # una sola transacción para toda la carga
            for producto in productos:
                imagenes = producto.get("imagenes", [])

                missing = check_image_files_exist(imagenes)
                if missing:
                    stats["imagenes_faltantes_en_disco"].extend(
                        f"{producto['slug_o_id_origen']}: {m}" for m in missing
                    )

                product_id, was_inserted = upsert_product(conn, producto)
                n_imagenes = replace_images(conn, product_id, imagenes)

                stats["insertados" if was_inserted else "actualizados"] += 1
                stats["imagenes_cargadas"] += n_imagenes

        if fallidos:
            print(f"Aviso: {len(fallidos)} producto(s) fallidos en el scrape, no se cargan:")
            for f in fallidos:
                print(f"  - {f.get('slug_o_id_origen')}: {f.get('motivo')}")

        return stats
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON_PATH)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    args = parser.parse_args()

    if not args.json.is_file():
        print(f"ERROR: no existe el archivo {args.json}", file=sys.stderr)
        return 1

    if not args.db.is_file():
        print(
            f"ERROR: no existe la base {args.db}. "
            f"Corré primero: python db/scripts/run_migrations.py",
            file=sys.stderr,
        )
        return 1

    stats = load_catalogo(args.json, args.db)

    print("\n--- Resultado de la carga ---")
    print(f"Productos en el JSON:      {stats['productos_en_json']}")
    print(f"Fallidos en el JSON:       {stats['fallidos_en_json']}")
    print(f"Insertados (nuevos):       {stats['insertados']}")
    print(f"Actualizados (ya existían):{stats['actualizados']}")
    print(f"Filas de imagen cargadas:  {stats['imagenes_cargadas']}")
    if stats["imagenes_faltantes_en_disco"]:
        print(f"ADVERTENCIA: {len(stats['imagenes_faltantes_en_disco'])} imagen(es) "
              f"referenciadas en el JSON no se encontraron en disco:")
        for m in stats["imagenes_faltantes_en_disco"]:
            print(f"  - {m}")
    else:
        print("Todas las imágenes referenciadas existen en disco: OK")

    return 0


if __name__ == "__main__":
    sys.exit(main())
