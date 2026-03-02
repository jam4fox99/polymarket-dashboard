#!/usr/bin/env python3
"""Polymarket Scanner — CGI API for persistent market storage via SQLite."""

import json
import os
import sqlite3
import sys
import urllib.parse

DB_PATH = "markets.db"

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""
        CREATE TABLE IF NOT EXISTS markets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market_id TEXT UNIQUE,
            question TEXT,
            market_address TEXT,
            slug TEXT,
            description TEXT,
            assets_ids TEXT,
            outcomes TEXT,
            event_timestamp TEXT,
            raw_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    db.commit()
    return db

def respond(status_code, body, content_type="application/json"):
    print(f"Status: {status_code}")
    print(f"Content-Type: {content_type}")
    print("Access-Control-Allow-Origin: *")
    print("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS")
    print("Access-Control-Allow-Headers: Content-Type")
    print()
    if isinstance(body, dict) or isinstance(body, list):
        print(json.dumps(body))
    else:
        print(body)

method = os.environ.get("REQUEST_METHOD", "GET")
query_string = os.environ.get("QUERY_STRING", "")
params = urllib.parse.parse_qs(query_string)

if method == "OPTIONS":
    respond(200, {"ok": True})
    sys.exit(0)

try:
    db = get_db()

    if method == "POST":
        content_length = int(os.environ.get("CONTENT_LENGTH", 0))
        body = sys.stdin.read(content_length) if content_length > 0 else sys.stdin.read()
        data = json.loads(body)

        market_id = data.get("id", data.get("market_id", ""))
        question = data.get("question", "")
        market_address = data.get("market", data.get("market_address", ""))
        slug = data.get("slug", "")
        description = data.get("description", "")
        assets_ids = json.dumps(data.get("assets_ids", []))
        outcomes = json.dumps(data.get("outcomes", []))
        event_timestamp = data.get("timestamp", data.get("event_timestamp", ""))
        raw_data = json.dumps(data)

        try:
            db.execute("""
                INSERT OR IGNORE INTO markets
                    (market_id, question, market_address, slug, description, assets_ids, outcomes, event_timestamp, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [market_id, question, market_address, slug, description, assets_ids, outcomes, event_timestamp, raw_data])
            db.commit()
        except sqlite3.IntegrityError:
            pass

        row = db.execute("SELECT * FROM markets WHERE market_id = ?", [market_id]).fetchone()
        if row:
            result = dict(row)
            respond(201, result)
        else:
            respond(201, {"ok": True, "market_id": market_id})

    elif method == "GET":
        limit = int(params.get("limit", [500])[0])
        since = params.get("since", [None])[0]

        if since:
            rows = db.execute(
                "SELECT * FROM markets WHERE created_at > ? ORDER BY id DESC LIMIT ?",
                [since, limit]
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM markets ORDER BY id DESC LIMIT ?",
                [limit]
            ).fetchall()

        results = []
        for row in rows:
            item = dict(row)
            # Parse JSON fields back
            try:
                item["assets_ids"] = json.loads(item.get("assets_ids", "[]"))
            except:
                item["assets_ids"] = []
            try:
                item["outcomes"] = json.loads(item.get("outcomes", "[]"))
            except:
                item["outcomes"] = []
            results.append(item)

        respond(200, results)

    elif method == "DELETE":
        item_id = params.get("id", [None])[0]
        if item_id:
            db.execute("DELETE FROM markets WHERE id = ?", [item_id])
            db.commit()
            respond(200, {"deleted": True, "id": item_id})
        else:
            respond(400, {"error": "Missing id parameter"})

    else:
        respond(405, {"error": "Method not allowed"})

except Exception as e:
    respond(422, {"error": str(e)})
