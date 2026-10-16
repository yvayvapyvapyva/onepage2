#!/usr/bin/env python3
"""Одноразовая миграция YDB -> Cloudflare D1.

Читает таблицы roads/users из YDB (через тот же доступ, что backend/handler.py)
и генерирует seed.sql с INSERT для заливки через wrangler:

  pip install ydb
  YDB_ENDPOINT=... YDB_DATABASE=... python3 cloudflare_worker/migrate-ydb-to-d1.py --out seed.sql
  # разбить при необходимости: --batch 500
  wrangler d1 execute nav-db --file=seed.sql --config=cloudflare_worker/wrangler-api.toml

Пароли переносятся как есть (plain-text, совместимость). created_at из YDB Timestamp
переводится в микросекунды epoch, как в handler.py.
"""
import argparse
import json
import os
import sys

try:
    import ydb
    import ydb.iam
except ImportError:
    print("нужен pip install ydb", file=sys.stderr)
    sys.exit(1)


def sql_escape(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="seed.sql")
    ap.add_argument("--batch", type=int, default=500)
    args = ap.parse_args()

    endpoint = os.getenv("YDB_ENDPOINT")
    database = os.getenv("YDB_DATABASE")
    if not endpoint or not database:
        print("нужны YDB_ENDPOINT и YDB_DATABASE в окружении", file=sys.stderr)
        sys.exit(1)

    yc_token = os.getenv("YC_TOKEN")
    credentials = (
        ydb.AccessTokenCredentials(yc_token)
        if yc_token
        else ydb.iam.MetadataUrlCredentials()
    )
    driver_config = ydb.DriverConfig(endpoint, database, credentials=credentials)
    driver = ydb.Driver(driver_config)
    driver.wait(timeout=10)
    pool = ydb.SessionPool(driver)

    def fetch_all(table, cols):
        q = f"SELECT {', '.join(cols)} FROM {table};"
        prepared = None
        rows = []

        def run(session):
            nonlocal prepared
            if prepared is None:
                prepared = session.prepare(q)
            res = session.transaction().execute(prepared, commit_tx=True)
            rows.extend(res[0].rows)

        pool.retry_operation_sync(run)
        return rows

    roads = fetch_all("roads", ["id", "m", "json", "name", "description", "visible", "creator_name"])
    users = fetch_all("users", ["login", "password", "creator_name", "created_at"])

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("-- seed для D1, сгенерировано migrate-ydb-to-d1.py\n")
        f.write(f"-- roads: {len(roads)}, users: {len(users)}\n\n")
        for i in range(0, len(roads), args.batch):
            chunk = roads[i:i + args.batch]
            f.write("INSERT INTO roads (id, m, json, name, description, visible, creator_name) VALUES\n")
            vals = []
            for r in chunk:
                raw = r.json
                js = raw.decode("utf-8") if isinstance(raw, bytes) else (raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False))
                vals.append(
                    f"({sql_escape(r.id)}, {sql_escape(r.m)}, {sql_escape(js)}, "
                    f"{sql_escape(getattr(r, 'name', '') or '')}, "
                    f"{sql_escape(getattr(r, 'description', '') or '')}, "
                    f"{1 if getattr(r, 'visible', False) else 0}, "
                    f"{sql_escape(getattr(r, 'creator_name', '') or '')})"
                )
            f.write(",\n".join(vals) + ";\n")
        f.write("\n")
        for i in range(0, len(users), args.batch):
            chunk = users[i:i + args.batch]
            f.write("INSERT INTO users (login, password, creator_name, created_at) VALUES\n")
            vals = []
            for u in chunk:
                ts = u.created_at
                if hasattr(ts, "timestamp"):
                    ts = int(ts.timestamp() * 1_000_000)
                vals.append(
                    f"({sql_escape(u.login)}, {sql_escape(u.password)}, "
                    f"{sql_escape(getattr(u, 'creator_name', '') or '')}, {int(ts or 0)})"
                )
            f.write(",\n".join(vals) + ";\n")

    print(f"готово: {args.out} (roads={len(roads)}, users={len(users)})")


if __name__ == "__main__":
    main()
