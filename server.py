#!/usr/bin/env python3
"""Bonafide: trust-first dating app backend.

Pure Python standard library (no pip installs). SQLite database.
Run:  python3 server.py      then open http://localhost:8000
"""
import datetime
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sqlite3
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DB_PATH = os.environ.get("BONAFIDE_DB", os.path.join(BASE, "bonafide.db"))
PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
# "demo": verification buttons auto-approve (for testing only).
# Replace verify_step() with a real provider (DigiLocker / KYC vendor) before launch.
VERIFY_MODE = os.environ.get("VERIFY_MODE", "demo")
SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "0") == "1"  # set to 1 behind HTTPS

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL, salt TEXT NOT NULL, gender TEXT NOT NULL, dob TEXT NOT NULL,
  city TEXT DEFAULT '', bio TEXT DEFAULT '', intent TEXT DEFAULT '', photo TEXT DEFAULT '',
  selfie_ok INTEGER DEFAULT 0, id_ok INTEGER DEFAULT 0, suspended INTEGER DEFAULT 0,
  created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS convos(
  woman_id INTEGER, man_id INTEGER, opened INTEGER, PRIMARY KEY(woman_id, man_id));
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, sender INTEGER, receiver INTEGER, body TEXT, ts INTEGER,
  flagged INTEGER DEFAULT 0, read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS reports(
  reporter INTEGER, reported INTEGER, reason TEXT, ts INTEGER, PRIMARY KEY(reporter, reported));
CREATE TABLE IF NOT EXISTS blocks(blocker INTEGER, blocked INTEGER, PRIMARY KEY(blocker, blocked));
CREATE TABLE IF NOT EXISTS safedates(
  id INTEGER PRIMARY KEY, user_id INTEGER, token TEXT UNIQUE, with_name TEXT, venue TEXT,
  when_text TEXT, contact_name TEXT, contact_phone TEXT, sharing INTEGER DEFAULT 1,
  lat REAL, lng REAL, loc_ts INTEGER, checkin_due INTEGER, status TEXT DEFAULT 'active',
  created INTEGER);
"""

# Messages that look like money / scam requests get flagged (recipient sees a warning).
MONEY = re.compile(
    r"(₹|\brs\.?\s*\d|\brupee|\brupaye|\bupi\b|\bgpay\b|\bgoogle pay\b|\bphonepe\b|\bpaytm\b|"
    r"\bpaise\b|\bpaisa\b|\bsend money\b|\bmoney transfer\b|\btransfer\b|\bloan\b|\bgift card\b|"
    r"\bbank account\b|\baccount number\b|\bifsc\b|\botp\b|\bqr code\b|\bcrypto\b|\bbitcoin\b|"
    r"\bwestern union\b|\bemergency money\b)",
    re.I,
)

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")
INTENTS = ["Marriage within 1 to 2 years", "Serious relationship", "Getting to know people first"]

_login_hits = {}  # ip -> [timestamps]


def now():
    return int(time.time())


def db_conn():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    c = db_conn()
    c.executescript(SCHEMA)
    c.execute("PRAGMA journal_mode=WAL")
    c.commit()
    c.close()


def hash_pw(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()


def age_of(dob):
    d = datetime.date.fromisoformat(dob)
    t = datetime.date.today()
    return t.year - d.year - ((t.month, t.day) < (d.month, d.day))


def is_verified(u):
    return bool(u["selfie_ok"] and u["id_ok"])


def trust_score(db, u):
    reports = db.execute("SELECT COUNT(*) c FROM reports WHERE reported=?", (u["id"],)).fetchone()["c"]
    flagged = db.execute(
        "SELECT COUNT(*) c FROM messages WHERE sender=? AND flagged=1", (u["id"],)
    ).fetchone()["c"]
    s = 40 + (50 if is_verified(u) else 0) + (5 if u["photo"] else 0) + (5 if u["bio"] else 0)
    s -= 15 * reports + 4 * flagged
    return max(0, min(100, s))


def public_user(db, u, with_photo=True):
    return {
        "id": u["id"],
        "name": u["name"],
        "age": age_of(u["dob"]),
        "city": u["city"],
        "bio": u["bio"],
        "intent": u["intent"],
        "photo": u["photo"] if with_photo else "",
        "verified": is_verified(u),
        "trust": trust_score(db, u),
    }


def discoverable(db, u):
    return (not u["suspended"]) and is_verified(u) and trust_score(db, u) >= 30


def blocked_either(db, a, b):
    return db.execute(
        "SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)",
        (a, b, b, a),
    ).fetchone() is not None


def convo_exists(db, a, b):
    return db.execute(
        "SELECT 1 FROM convos WHERE (woman_id=? AND man_id=?) OR (woman_id=? AND man_id=?)",
        (a, b, b, a),
    ).fetchone() is not None


def verify_step(user, step):
    """Hook for real verification. In demo mode every step passes.

    For production: call your KYC/DigiLocker provider here and only return True
    when the provider confirms (face match for 'selfie', ID check for 'id')."""
    if VERIFY_MODE == "demo":
        return True
    return False


def safedate_view(row):
    if not row:
        return None
    status = row["status"]
    if status == "active" and now() > row["checkin_due"]:
        status = "overdue"
    return {
        "id": row["id"],
        "token": row["token"],
        "link": "/safe/" + row["token"],
        "with_name": row["with_name"],
        "venue": row["venue"],
        "when_text": row["when_text"],
        "contact_name": row["contact_name"],
        "contact_phone": row["contact_phone"],
        "sharing": bool(row["sharing"]),
        "lat": row["lat"],
        "lng": row["lng"],
        "loc_ts": row["loc_ts"],
        "checkin_due": row["checkin_due"],
        "status": status,
    }


def active_safedate(db, uid):
    return db.execute(
        "SELECT * FROM safedates WHERE user_id=? AND status IN ('active','sos') "
        "ORDER BY id DESC LIMIT 1",
        (uid,),
    ).fetchone()


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


def need(cond, msg, code=400):
    if not cond:
        raise ApiError(code, msg)


def clean(s, maxlen):
    return re.sub(r"[\x00-\x08\x0b-\x1f]", "", (s or "").strip())[:maxlen]


class Handler(BaseHTTPRequestHandler):
    server_version = "Bonafide/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---------- helpers ----------
    def send_json(self, code, obj, extra_headers=None):
        # Commit BEFORE replying so the client's next request always sees this write.
        db = getattr(self, "_db", None)
        if db is not None:
            if code < 400:
                db.commit()
            else:
                db.rollback()
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
            "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
            "frame-ancestors 'none'",
        )

    def read_json(self):
        ctype = self.headers.get("Content-Type", "")
        need(ctype.startswith("application/json"), "JSON required", 415)
        n = int(self.headers.get("Content-Length") or 0)
        need(n <= 700_000, "Request too large", 413)
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            raise ApiError(400, "Bad JSON")
        need(isinstance(data, dict), "Bad JSON")
        return data

    def session_user(self, db):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        c = SimpleCookie()
        try:
            c.load(raw)
        except Exception:
            return None
        if "bf_session" not in c:
            return None
        th = hashlib.sha256(c["bf_session"].value.encode()).hexdigest()
        row = db.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.th=? AND s.created>?",
            (th, now() - 30 * 86400),
        ).fetchone()
        return row

    def make_session(self, db, uid):
        tok = secrets.token_urlsafe(32)
        db.execute(
            "INSERT INTO sessions(th,user_id,created) VALUES(?,?,?)",
            (hashlib.sha256(tok.encode()).hexdigest(), uid, now()),
        )
        flags = "HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000" + ("; Secure" if SECURE_COOKIE else "")
        return [("Set-Cookie", f"bf_session={tok}; {flags}")]

    # ---------- routing ----------
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def route(self, method):
        path = urlparse(self.path).path
        qs = parse_qs(urlparse(self.path).query)
        try:
            if method == "GET" and not path.startswith("/api/"):
                return self.serve_page(path)
            db = db_conn()
            self._db = db
            try:
                self.api(db, method, path, qs)
                db.commit()
            except ApiError as e:
                self.send_json(e.code, {"error": e.msg})
            finally:
                self._db = None
                db.close()
        except ApiError as e:
            self.send_json(e.code, {"error": e.msg})
        except Exception as e:  # pragma: no cover
            self.send_json(500, {"error": "Str(e)"})
            print("ERROR", repr(e))

    def serve_page(self, path):
        files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/style.css": ("style.css", "text/css; charset=utf-8"),
        }
        if path.startswith("/safe/"):
            return self.safe_page(path[len("/safe/"):])
        if path not in files:
            body = b"Not found"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        name, ctype = files[path]
        with open(os.path.join(STATIC, name), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def safe_page(self, token):
        db = db_conn()
        try:
            row = db.execute("SELECT s.*, u.name AS uname FROM safedates s JOIN users u ON u.id=s.user_id "
                             "WHERE s.token=?", (token,)).fetchone()
        finally:
            db.close()
        if not row:
            body = b"<p>This link is not valid.</p>"
            self.send_response(404)
        else:
            v = safedate_view(row)
            e = html.escape
            status_txt = {
                "active": "Date in progress. Check-in not due yet.",
                "overdue": "ALERT: check-in time has passed. Please call them now.",
                "sos": "SOS: they pressed the emergency button. Call them and call 112.",
                "safe": "They have checked in and are safe.",
                "ended": "This Safe Date has ended.",
            }.get(v["status"], v["status"])
            color = "#B3261E" if v["status"] in ("overdue", "sos") else "#0E5A52"
            loc = ""
            if v["sharing"] and v["lat"] is not None and v["status"] in ("active", "overdue", "sos"):
                age = max(0, now() - (v["loc_ts"] or now()))
                loc = (f'<p>Last location, {age // 60} min ago: '
                       f'<a href="https://www.openstreetmap.org/?mlat={v["lat"]}&amp;mlon={v["lng"]}#map=17/{v["lat"]}/{v["lng"]}" '
                       f'rel="noopener noreferrer">open map</a></p>')
            elif v["status"] in ("active", "overdue", "sos"):
                loc = "<p>Location is not being shared right now.</p>"
            due = time.strftime("%I:%M %p", time.gmtime(v["checkin_due"] + 19800))
            page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Bonafide Safe Date</title>
<style>body{{font-family:system-ui,sans-serif;background:#FAF6EF;color:#18302D;margin:0;padding:24px;max-width:480px}}
.card{{background:#fff;border:1px solid #E5DCCB;border-radius:16px;padding:18px;margin-top:14px}}
h1{{font-size:22px;margin:0 0 4px}} .st{{font-weight:700;color:{color}}} a{{color:#0E5A52}}</style></head>
<body><h1>Bonafide Safe Date</h1>
<p>{e(row["uname"])} added you ({e(v["contact_name"] or "trusted contact")}) as their trusted contact.</p>
<div class="card"><p class="st">{e(status_txt)}</p>
<p>Meeting: {e(v["with_name"] or "someone")} at {e(v["venue"] or "a venue")}<br>{e(v["when_text"] or "")}</p>
<p>Check-in due: {e(due)} IST</p>{loc}
<p style="font-size:13px">This page refreshes every 30 seconds. In an emergency call 112.</p></div></body></html>"""
            body = page.encode()
            self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    # ---------- API ----------
    def api(self, db, method, path, qs):
        ip = self.client_address[0]

        if method == "POST" and path == "/api/signup":
            d = self.read_json()
            name = clean(d.get("name"), 40)
            email = clean(d.get("email"), 120).lower()
            pw = d.get("password") or ""
            gender = d.get("gender")
            city = clean(d.get("city"), 60)
            need(len(name) >= 2, "Please enter your name")
            need(EMAIL_RE.match(email), "Enter a valid email")
            need(isinstance(pw, str) and 8 <= len(pw) <= 100, "Password must be at least 8 characters")
            need(gender in ("woman", "man"), "Choose woman or man")
            try:
                age = age_of(d.get("dob") or "")
            except ValueError:
                raise ApiError(400, "Enter your date of birth")
            need(age >= 18, "Bonafide is for people aged 18 and above")
            need(age <= 90, "Enter a valid date of birth")
            need(db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone() is None,
                 "This email is already registered", 409)
            salt = secrets.token_hex(16)
            cur = db.execute(
                "INSERT INTO users(name,email,pw_hash,salt,gender,dob,city,created) VALUES(?,?,?,?,?,?,?,?)",
                (name, email, hash_pw(pw, salt), salt, gender, d["dob"], city, now()),
            )
            hdr = self.make_session(db, cur.lastrowid)
            return self.send_json(200, {"ok": True}, hdr)

        if method == "POST" and path == "/api/login":
            hits = [t for t in _login_hits.get(ip, []) if t > now() - 60]
            need(len(hits) < 8, "Too many attempts. Wait a minute.", 429)
            _login_hits[ip] = hits + [now()]
            d = self.read_json()
            u = db.execute("SELECT * FROM users WHERE email=?", (clean(d.get("email"), 120).lower(),)).fetchone()
            ok = u is not None and hmac.compare_digest(
                hash_pw(str(d.get("password") or ""), u["salt"]), u["pw_hash"])
            need(ok, "Wrong email or password", 401)
            need(not u["suspended"], "This account is suspended after reports", 403)
            return self.send_json(200, {"ok": True}, self.make_session(db, u["id"]))

        if method == "GET" and path == "/api/health":
            return self.send_json(200, {"ok": True})

        me = self.session_user(db)
        need(me is not None, "Please log in", 401)
        need(not me["suspended"], "This account is suspended", 403)
        uid = me["id"]

        if method == "POST" and path == "/api/logout":
            c = SimpleCookie(self.headers.get("Cookie", ""))
            if "bf_session" in c:
                db.execute("DELETE FROM sessions WHERE th=?",
                           (hashlib.sha256(c["bf_session"].value.encode()).hexdigest(),))
            return self.send_json(200, {"ok": True}, [("Set-Cookie", "bf_session=; Max-Age=0; Path=/")])

        if method == "GET" and path == "/api/me":
            out = public_user(db, me)
            out.update({"gender": me["gender"], "email": me["email"], "selfie_ok": bool(me["selfie_ok"]),
                        "id_ok": bool(me["id_ok"]), "verify_mode": VERIFY_MODE, "intents": INTENTS})
            return self.send_json(200, out)

        if method == "PUT" and path == "/api/profile":
            d = self.read_json()
            bio = clean(d.get("bio"), 300)
            city = clean(d.get("city"), 60)
            intent = d.get("intent") if d.get("intent") in INTENTS else ""
            photo = d.get("photo")
            if photo is not None:
                need(photo == "" or (isinstance(photo, str) and photo.startswith("data:image/jpeg;base64,")
                                     and len(photo) < 450_000), "Photo must be a JPEG under 300 KB")
            else:
                photo = me["photo"]
            db.execute("UPDATE users SET bio=?, city=?, intent=?, photo=? WHERE id=?",
                       (bio, city, intent, photo, uid))
            return self.send_json(200, {"ok": True})

        if method == "POST" and path == "/api/verify":
            d = self.read_json()
            step = d.get("step")
            need(step in ("selfie", "id"), "Unknown step")
            need(verify_step(me, step), "Verification failed", 400)
            col = "selfie_ok" if step == "selfie" else "id_ok"
            db.execute(f"UPDATE users SET {col}=1 WHERE id=?", (uid,))
            return self.send_json(200, {"ok": True})

        if method == "GET" and path == "/api/discover":
            need(is_verified(me), "Complete verification to see people", 403)
            other = "man" if me["gender"] == "woman" else "woman"
            rows = db.execute("SELECT * FROM users WHERE gender=? AND id!=? ORDER BY RANDOM() LIMIT 60",
                              (other, uid)).fetchall()
            out = []
            for r in rows:
                if not discoverable(db, r) or blocked_either(db, uid, r["id"]) or convo_exists(db, uid, r["id"]):
                    continue
                out.append(public_user(db, r))
            return self.send_json(200, {"people": out[:30], "can_start": me["gender"] == "woman"})

        if method == "POST" and path == "/api/hello":
            need(me["gender"] == "woman", "On Bonafide, women send the first message", 403)
            need(is_verified(me), "Complete verification first", 403)
            d = self.read_json()
            to = db.execute("SELECT * FROM users WHERE id=? AND gender='man'", (d.get("to"),)).fetchone()
            need(to is not None and discoverable(db, to), "Profile not available", 404)
            need(not blocked_either(db, uid, to["id"]), "Not available", 403)
            need(not convo_exists(db, uid, to["id"]), "You already started this chat", 409)
            body = clean(d.get("body"), 1000)
            need(len(body) >= 1, "Write a first message")
            db.execute("INSERT INTO convos(woman_id,man_id,opened) VALUES(?,?,?)", (uid, to["id"], now()))
            db.execute("INSERT INTO messages(sender,receiver,body,ts,flagged) VALUES(?,?,?,?,?)",
                       (uid, to["id"], body, now(), 1 if MONEY.search(body) else 0))
            return self.send_json(200, {"ok": True, "with": to["id"]})

        if method == "GET" and path == "/api/conversations":
            rows = db.execute(
                "SELECT * FROM convos WHERE woman_id=? OR man_id=? ORDER BY opened DESC", (uid, uid)).fetchall()
            out = []
            for c in rows:
                oid = c["man_id"] if c["woman_id"] == uid else c["woman_id"]
                if blocked_either(db, uid, oid):
                    continue
                o = db.execute("SELECT * FROM users WHERE id=?", (oid,)).fetchone()
                if not o or o["suspended"]:
                    continue
                last = db.execute(
                    "SELECT * FROM messages WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?) "
                    "ORDER BY id DESC LIMIT 1", (uid, oid, oid, uid)).fetchone()
                unread = db.execute("SELECT COUNT(*) c FROM messages WHERE sender=? AND receiver=? AND read=0",
                                    (oid, uid)).fetchone()["c"]
                out.append({"user": public_user(db, o), "last": last["body"][:80] if last else "",
                            "ts": last["ts"] if last else c["opened"], "unread": unread})
            out.sort(key=lambda x: -x["ts"])
            return self.send_json(200, {"conversations": out})

        if method == "GET" and path == "/api/messages":
            oid = int((qs.get("with") or ["0"])[0] or 0)
            o = db.execute("SELECT * FROM users WHERE id=?", (oid,)).fetchone()
            need(o is not None and convo_exists(db, uid, oid) and not blocked_either(db, uid, oid),
                 "Chat not found", 404)
            db.execute("UPDATE messages SET read=1 WHERE sender=? AND receiver=?", (oid, uid))
            rows = db.execute(
                "SELECT * FROM messages WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?) "
                "ORDER BY id ASC LIMIT 500", (uid, oid, oid, uid)).fetchall()
            return self.send_json(200, {
                "user": public_user(db, o),
                "messages": [{"id": m["id"], "mine": m["sender"] == uid, "body": m["body"], "ts": m["ts"],
                              "flagged": bool(m["flagged"])} for m in rows]})

        if method == "POST" and path == "/api/messages":
            d = self.read_json()
            oid = d.get("to")
            o = db.execute("SELECT * FROM users WHERE id=?", (oid,)).fetchone()
            need(o is not None and convo_exists(db, uid, oid), "Chat not found", 404)
            need(not blocked_either(db, uid, oid), "You cannot message this person", 403)
            need(not o["suspended"], "This person is not available", 403)
            body = clean(d.get("body"), 1000)
            need(body, "Write a message")
            recent = db.execute("SELECT COUNT(*) c FROM messages WHERE sender=? AND ts>?", (uid, now() - 60)).fetchone()["c"]
            need(recent < 30, "Slow down a little", 429)
            flagged = 1 if MONEY.search(body) else 0
            db.execute("INSERT INTO messages(sender,receiver,body,ts,flagged) VALUES(?,?,?,?,?)",
                       (uid, oid, body, now(), flagged))
            return self.send_json(200, {"ok": True, "flagged": bool(flagged)})

        if method == "POST" and path == "/api/report":
            d = self.read_json()
            tid = d.get("user")
            t = db.execute("SELECT * FROM users WHERE id=?", (tid,)).fetchone()
            need(t is not None and tid != uid, "Unknown user", 404)
            reason = clean(d.get("reason"), 300) or "No reason given"
            db.execute("INSERT OR REPLACE INTO reports(reporter,reported,reason,ts) VALUES(?,?,?,?)",
                       (uid, tid, reason, now()))
            db.execute("INSERT OR IGNORE INTO blocks(blocker,blocked) VALUES(?,?)", (uid, tid))
            n = db.execute("SELECT COUNT(*) c FROM reports WHERE reported=?", (tid,)).fetchone()["c"]
            if n >= 3:
                db.execute("UPDATE users SET suspended=1 WHERE id=?", (tid,))
            return self.send_json(200, {"ok": True})

        if method == "POST" and path == "/api/block":
            d = self.read_json()
            need(d.get("user") != uid, "Invalid")
            db.execute("INSERT OR IGNORE INTO blocks(blocker,blocked) VALUES(?,?)", (uid, d.get("user")))
            return self.send_json(200, {"ok": True})

        # ----- Safe Date -----
        if method == "GET" and path == "/api/safedate":
            return self.send_json(200, {"safedate": safedate_view(active_safedate(db, uid))})

        if method == "POST" and path == "/api/safedate":
            d = self.read_json()
            mins = d.get("checkin_minutes")
            need(isinstance(mins, int) and 15 <= mins <= 720, "Check-in must be 15 to 720 minutes away")
            venue = clean(d.get("venue"), 120)
            need(venue, "Enter the venue")
            db.execute("UPDATE safedates SET status='ended', sharing=0 WHERE user_id=? AND status IN ('active','sos')", (uid,))
            db.execute(
                "INSERT INTO safedates(user_id,token,with_name,venue,when_text,contact_name,contact_phone,"
                "checkin_due,created) VALUES(?,?,?,?,?,?,?,?,?)",
                (uid, secrets.token_urlsafe(16), clean(d.get("with_name"), 60), venue,
                 clean(d.get("when_text"), 80), clean(d.get("contact_name"), 60),
                 clean(d.get("contact_phone"), 20), now() + mins * 60, now()))
            return self.send_json(200, {"safedate": safedate_view(active_safedate(db, uid))})

        sd = active_safedate(db, uid)
        if path.startswith("/api/safedate/") and method == "POST":
            need(sd is not None, "No active Safe Date", 404)
            action = path.rsplit("/", 1)[1]
            if action == "location":
                d = self.read_json()
                lat, lng = d.get("lat"), d.get("lng")
                need(isinstance(lat, (int, float)) and isinstance(lng, (int, float))
                     and -90 <= lat <= 90 and -180 <= lng <= 180, "Bad location")
                need(sd["sharing"], "Sharing is off")
                db.execute("UPDATE safedates SET lat=?, lng=?, loc_ts=? WHERE id=?", (lat, lng, now(), sd["id"]))
            elif action == "sharing":
                d = self.read_json()
                db.execute("UPDATE safedates SET sharing=? WHERE id=?", (1 if d.get("on") else 0, sd["id"]))
            elif action == "checkin":
                db.execute("UPDATE safedates SET status='safe', sharing=0 WHERE id=?", (sd["id"],))
            elif action == "sos":
                db.execute("UPDATE safedates SET status='sos', sharing=1 WHERE id=?", (sd["id"],))
            elif action == "end":
                db.execute("UPDATE safedates SET status='ended', sharing=0 WHERE id=?", (sd["id"],))
            else:
                raise ApiError(404, "Unknown action")
            row = db.execute("SELECT * FROM safedates WHERE id=?", (sd["id"],)).fetchone()
            return self.send_json(200, {"safedate": safedate_view(row)})

        raise ApiError(404, "Not found")


def main():
    init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Bonafide running on http://{HOST}:{PORT}  (verification mode: {VERIFY_MODE})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
