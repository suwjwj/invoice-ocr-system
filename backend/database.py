"""
数据库模型 - SQLite 存储票据识别结果与审计日志
"""
import sqlite3
import uuid
import json
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "invoice_ocr.db"


def get_conn():
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_db():
    """Context manager：自动关闭连接，异常时回滚"""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    conn = get_conn()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        image_path TEXT NOT NULL,
        invoice_type TEXT,
        classify_confidence REAL,
        status TEXT DEFAULT 'pending',
        risk_level TEXT DEFAULT 'normal',
        risk_flags TEXT,
        ocr_raw_json TEXT,
        processing_time_ms REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_name TEXT,
        final_value TEXT,
        confidence REAL,
        evidence_bbox TEXT,
        key_bbox TEXT,
        decision_reason TEXT,
        rule_details TEXT,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_id INTEGER NOT NULL,
        source TEXT,
        value TEXT,
        ocr_confidence REAL,
        format_score REAL,
        cross_field_score REAL,
        final_score REAL,
        is_selected INTEGER DEFAULT 0,
        bbox TEXT,
        FOREIGN KEY (field_id) REFERENCES fields(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'system',
        target_field TEXT,
        old_value TEXT,
        new_value TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    -- 性能索引
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at);
    CREATE INDEX IF NOT EXISTS idx_fields_invoice_id ON fields(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_field_id ON candidates(field_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_invoice_id ON audit_logs(invoice_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fields_unique ON fields(invoice_id, field_key);
    """)
    conn.commit()
    conn.close()


def create_invoice(image_path, ocr_raw=None):
    with get_db() as conn:
        invoice_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO invoices (id, image_path, ocr_raw_json) VALUES (?, ?, ?)",
            (invoice_id, image_path, json.dumps(ocr_raw) if ocr_raw else None)
        )
    return invoice_id


ALLOWED_INVOICE_COLUMNS = {"status", "risk_level", "risk_flags", "invoice_type",
                           "processing_time_ms", "ocr_raw_json", "classify_confidence"}


def update_invoice(invoice_id, **kwargs):
    invalid = set(kwargs.keys()) - ALLOWED_INVOICE_COLUMNS
    if invalid:
        raise ValueError(f"Invalid columns: {invalid}")
    with get_db() as conn:
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values())
        vals.append(invoice_id)
        conn.execute(
            f"UPDATE invoices SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            vals
        )


def save_field(invoice_id, field_key, field_name, final_value, confidence,
               evidence_bbox=None, key_bbox=None, decision_reason=None,
               rule_details=None, candidates_list=None):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT OR REPLACE INTO fields (invoice_id, field_key, field_name, final_value,
               confidence, evidence_bbox, key_bbox, decision_reason, rule_details)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (invoice_id, field_key, field_name, final_value, confidence,
             json.dumps(evidence_bbox) if evidence_bbox else None,
             json.dumps(key_bbox) if key_bbox else None,
             decision_reason,
             json.dumps(rule_details) if rule_details else None)
        )
        field_id = cur.lastrowid
        if candidates_list:
            for c in candidates_list:
                cur.execute(
                    """INSERT INTO candidates (field_id, source, value, ocr_confidence,
                       format_score, cross_field_score, final_score, is_selected, bbox)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (field_id, c.get("source"), c.get("value"),
                     c.get("ocr_confidence"), c.get("format_score"),
                     c.get("cross_field_score"), c.get("final_score"),
                     1 if c.get("is_selected") else 0,
                     json.dumps(c.get("bbox")) if c.get("bbox") else None)
                )
    return field_id


def add_audit_log(invoice_id, action, description, actor="system",
                  target_field=None, old_value=None, new_value=None):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO audit_logs (invoice_id, action, actor, target_field,
               old_value, new_value, description) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (invoice_id, action, actor, target_field, old_value, new_value, description)
        )


def get_invoice(invoice_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return dict(row) if row else None


def get_fields(invoice_id):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM fields WHERE invoice_id = ?", (invoice_id,)).fetchall()
    return [dict(r) for r in rows]


def get_candidates(field_id):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM candidates WHERE field_id = ?", (field_id,)).fetchall()
    return [dict(r) for r in rows]


def get_audit_logs(invoice_id):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_logs WHERE invoice_id = ? ORDER BY created_at",
            (invoice_id,)
        ).fetchall()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    init_db()
    print(f"Database initialized at {DB_PATH}")
