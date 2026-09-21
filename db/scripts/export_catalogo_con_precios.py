#!/usr/bin/env python3
"""
Export de solo-lectura: `products` + `product_images` -> data/catalogo_con_precios.json

Contexto: la home (index.html) va a dejar de tener las 7 product cards
escritas a mano y va a renderizarse en el cliente vía JS, leyendo este JSON
(fetch('data/catalogo_con_precios.json')). Ese JS lo construye Valentina;
este script es la otra mitad del círculo: la pieza que hay que RE-CORRER
cada vez que cambien los precios en `products.precio_centavos` -- ya sea
corriendo de nuevo db/scripts/seed_precios_prueba.py con nuevos valores de
prueba, o cuando el usuario cargue precios reales (a mano en la tabla, o con
un script futuro) -- para que el sitio los refleje sin que nadie tenga que
tocar index.html.

No escribe nada en la base: es un export de solo lectura. `products` y
`product_images` no se modifican.

Formato de salida (pensado para que el JS lo consuma directo, sin
transformar nada):
    {
      "productos": [
        {
          "id": "daily_12",                 // slug_o_id_origen -- es el
                                             // data-product-id que ya usa
                                             // el carrito, no se toca
          "nombre": "Media Multifilamento — Art. 12",
          "articulo": "12",
          "categoria": null,                // no existe esta columna hoy
          "descripcion": "Fina, Talle único",
          "precio": 2890,                   // en PESOS, no centavos;
                                             // null si precio_centavos IS NULL
          "precio_es_prueba": true,
          "imagenes": ["uploads/...jpg", ...],
          "imagen_principal": "uploads/...jpg"  // primera de la lista, o
                                                 // null si no hay imágenes
        },
        ...
      ],
      "generado_en": "2026-09-14T10:30:00Z"  // timestamp UTC del export
    }

`nombre`: la columna `products.nombre` hoy tiene el texto crudo del scraper
(ej. "art. 12 - MULTIFILAMENTO"), pero las cards actuales de index.html ya
muestran un nombre prolijo ("Media Multifilamento — Art. 12"). Para no
perder ese prolijo al pasar a JSON, este script trae ese nombre desde un
mapeo NOMBRES_PROLIJOS_POR_SLUG (inferido de las 7 cards que están hoy en
index.html) y sólo cae de vuelta a `products.nombre` si el slug no está en
el mapeo (p.ej. un producto nuevo que todavía no tiene nombre prolijo
definido a mano). `descripcion` y el resto de los campos NO se reformatean:
salen tal cual están en la tabla.

`categoria`: no hay ninguna columna en `products` de la que sacar esto hoy
(las cards actuales tienen una etiqueta de categoría, pero es texto fijo
escrito a mano en el HTML, no viene de la base) -- se deja `null` a
propósito, no se inventa.

Uso:
    python db/scripts/export_catalogo_con_precios.py [--db RUTA] [--out RUTA]

Re-correr después de:
    python db/scripts/seed_precios_prueba.py [...]
    (o cualquier UPDATE manual a products.precio_centavos / precio_es_prueba)
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = PROJECT_ROOT / "db" / "lyondor.sqlite3"
DEFAULT_OUT_PATH = PROJECT_ROOT / "data" / "catalogo_con_precios.json"

# Nombres prolijos ya usados hoy en las 7 product cards de index.html,
# indexados por `slug_o_id_origen` (== data-product-id del carrito). Es un
# mapeo manual, no una columna de la base: `products.nombre` guarda el
# texto crudo del scraper ("art. 12 - MULTIFILAMENTO"). Un producto nuevo
# que no esté acá cae de vuelta a `products.nombre` (ver `resolver_nombre`).
NOMBRES_PROLIJOS_POR_SLUG: dict[str, str] = {
    "daily_12": "Media Multifilamento — Art. 12",
    "daily_81": "Media Dralon — Art. 81",
    "daily_316": "Media Bucanera — Art. 316",
    "daily_700": "Panty Support — Art. 700",
    "daily_720": "Panty Support 3/4 — Art. 720",
    "daily_978": "Media Multifilamento c/ Liga — Art. 978",
    "daily_811": "Media Dralon — Art. 811",
}


def resolver_nombre(slug: str, nombre_db: str) -> str:
    return NOMBRES_PROLIJOS_POR_SLUG.get(slug, nombre_db)


def centavos_a_pesos(precio_centavos: int | None) -> int | float | None:
    if precio_centavos is None:
        return None
    pesos = precio_centavos / 100
    # Los precios (de prueba o reales) vienen en múltiplos de $1 ARS -- si
    # el resultado es entero, lo dejamos como int para un JSON más limpio
    # (2890, no 2890.0). Si algún día hay centavos reales, se preserva el
    # decimal.
    return int(pesos) if pesos == int(pesos) else round(pesos, 2)


def build_catalogo(db_path: Path) -> dict:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        productos_rows = conn.execute(
            """
            SELECT id, slug_o_id_origen, articulo, nombre, descripcion,
                   precio_centavos, precio_es_prueba
              FROM products
             WHERE activo = 1
             ORDER BY id
            """
        ).fetchall()

        productos = []
        for row in productos_rows:
            imagenes_rows = conn.execute(
                "SELECT path FROM product_images "
                "WHERE product_id = ? ORDER BY position",
                (row["id"],),
            ).fetchall()
            imagenes = [r["path"] for r in imagenes_rows]

            productos.append(
                {
                    "id": row["slug_o_id_origen"],
                    "nombre": resolver_nombre(row["slug_o_id_origen"], row["nombre"]),
                    "articulo": row["articulo"],
                    "categoria": None,
                    "descripcion": row["descripcion"],
                    "precio": centavos_a_pesos(row["precio_centavos"]),
                    "precio_es_prueba": bool(row["precio_es_prueba"]),
                    "imagenes": imagenes,
                    "imagen_principal": imagenes[0] if imagenes else None,
                }
            )

        return {
            "productos": productos,
            "generado_en": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_PATH)
    args = parser.parse_args()

    if not args.db.is_file():
        print(
            f"ERROR: no existe la base {args.db}. "
            f"Corré primero: python db/scripts/run_migrations.py",
            file=sys.stderr,
        )
        return 1

    catalogo = build_catalogo(args.db)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(catalogo, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    n_prueba = sum(1 for p in catalogo["productos"] if p["precio_es_prueba"])
    n_sin_precio = sum(1 for p in catalogo["productos"] if p["precio"] is None)

    print(f"\n--- Export de catálogo con precios ---")
    print(f"Archivo escrito: {args.out}")
    print(f"Productos exportados: {len(catalogo['productos'])}")
    print(f"  - con precio de prueba: {n_prueba}")
    print(f"  - sin precio (NULL):    {n_sin_precio}")
    print(f"Generado en: {catalogo['generado_en']}")
    print("\nDetalle:")
    for p in catalogo["productos"]:
        precio_str = f"${p['precio']}" if p["precio"] is not None else "sin precio"
        flag = " [prueba]" if p["precio_es_prueba"] else ""
        print(f"  - {p['id']:12s} {p['nombre']:45s} {precio_str}{flag} "
              f"({len(p['imagenes'])} img)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
