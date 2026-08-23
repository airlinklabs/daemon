#!/usr/bin/env python3
"""
Airlinkd Daemon Comprehensive Fuzzer
=====================================

Fuzzes HTTP endpoints, WebSocket auth, path traversal, SSRF vectors,
injection payloads, boundary values, and protocol edge cases.

Usage:
    pip install requests websocket-client
    python fuzzer.py --host localhost --port 3002 --key <daemon-key>
    python fuzzer.py --host localhost --port 3002 --key <key> --suite path_traversal
    python fuzzer.py --help
"""

from __future__ import annotations

import argparse
import hashlib
import hmac as hmac_mod
import json
import math
import os
import random
import secrets
import socket
import struct
import sys
import threading
import time
import traceback
import zlib
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from urllib.parse import urljoin

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_TIMEOUT = 10
HMAC_WINDOW_SECS = 30


# ── Result tracking ──────────────────────────────────────────────────────────

class Verdict(str, Enum):
    PASS = "pass"
    INTERESTING = "interesting"
    BUG = "bug"
    ERROR = "error"


@dataclass
class Finding:
    suite: str
    case: str
    method: str
    url: str
    status_code: int
    verdict: Verdict
    detail: str
    request_body: str = ""
    request_headers: dict = field(default_factory=dict)


# ── Fuzzer core ──────────────────────────────────────────────────────────────

class Fuzzer:
    def __init__(self, host: str, port: int, key: str, base_url: str | None = None):
        self.host = host
        self.port = port
        self.key = key
        self.base = base_url or f"http://{host}:{port}"
        self.findings: list[Finding] = []
        self.counts: dict[Verdict, int] = defaultdict(int)
        self.session = self._make_session()
        self.container_id = os.environ.get("FUZZ_CONTAINER_ID", "test-container")
        self._lock = threading.Lock()

    def _make_session(self) -> requests.Session:
        s = requests.Session()
        retries = Retry(total=2, backoff_factor=0.3, status_forcelist=[502, 503, 504])
        s.mount("http://", HTTPAdapter(max_retries=retries))
        s.mount("https://", HTTPAdapter(max_retries=retries))
        return s

    # ── HMAC signing ─────────────────────────────────────────────────────────

    def sign_hmac(self, method: str, path: str, body: bytes = b"") -> dict[str, str]:
        ts = str(int(time.time()))
        nonce = secrets.token_hex(16)
        body_repr = ""
        if body:
            body_repr = f"digest:{hashlib.sha256(body).hexdigest()}"
        payload = f"{ts}:{nonce}:{method.upper()}:{path}:{body_repr}"
        sig = hmac_mod.new(self.key.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return {"X-HMAC-Timestamp": ts, "X-HMAC-Nonce": nonce, "X-HMAC-Signature": sig}

    def sign_hmac_with(self, method: str, path: str, body: bytes, ts: str, nonce: str) -> dict[str, str]:
        body_repr = ""
        if body:
            body_repr = f"digest:{hashlib.sha256(body).hexdigest()}"
        payload = f"{ts}:{nonce}:{method.upper()}:{path}:{body_repr}"
        sig = hmac_mod.new(self.key.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return {"X-HMAC-Timestamp": ts, "X-HMAC-Nonce": nonce, "X-HMAC-Signature": sig}

    # ── HTTP helpers ──────────────────────────────────────────────────────────

    def _send(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: dict | None = None,
        timeout: int = DEFAULT_TIMEOUT,
        raw_body: bytes | None = None,
    ) -> requests.Response | None:
        url = urljoin(self.base, path)
        hdrs: dict[str, str] = {"User-Agent": "airlinkd-fuzzer/1.0"}
        if headers:
            hdrs.update(headers)
        try:
            if raw_body is not None:
                return self.session.request(method, url, data=raw_body, headers=hdrs, timeout=timeout)
            if body is not None:
                return self.session.request(method, url, json=body, headers=hdrs, timeout=timeout)
            return self.session.request(method, url, headers=hdrs, timeout=timeout)
        except requests.exceptions.ConnectionError:
            return None
        except Exception:
            return None

    def _signed_send(
        self,
        method: str,
        path: str,
        body: Any = None,
        extra_headers: dict | None = None,
    ) -> requests.Response | None:
        raw = json.dumps(body).encode() if body is not None else b""
        h = self.sign_hmac(method, path, raw)
        if extra_headers:
            h.update(extra_headers)
        return self._send(method, path, body=body, headers=h)

    # ── Recording ─────────────────────────────────────────────────────────────

    def record(self, finding: Finding):
        with self._lock:
            self.findings.append(finding)
            self.counts[finding.verdict] += 1
            m = {
                Verdict.BUG: "\033[91m[BUG]\033[0m",
                Verdict.INTERESTING: "\033[93m[???]\033[0m",
                Verdict.ERROR: "\033[90m[ERR]\033[0m",
                Verdict.PASS: "\033[92m[OK]\033[0m",
            }[finding.verdict]
            print(f"  {m} {finding.method:7s} {finding.url:<60s} {finding.status_code:3d}  {finding.detail}")

    def ok(self, suite: str, case: str, method: str, url: str, code: int, detail: str):
        self.record(Finding(suite, case, method, url, code, Verdict.PASS, detail))

    def bug(self, suite: str, case: str, method: str, url: str, code: int, detail: str):
        self.record(Finding(suite, case, method, url, code, Verdict.BUG, detail))

    def interesting(self, suite: str, case: str, method: str, url: str, code: int, detail: str):
        self.record(Finding(suite, case, method, url, code, Verdict.INTERESTING, detail))

    def error(self, suite: str, case: str, method: str, url: str, code: int, detail: str):
        self.record(Finding(suite, case, method, url, code, Verdict.ERROR, detail))

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: method_enforcement
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_methods(self):
        """Verify that endpoints reject wrong HTTP methods."""
        print("\n\033[96m=== Suite: method_enforcement ===\033[0m")
        suite = "method_enforcement"

        post_eps = [
            "/container/start", "/container/stop", "/container/restart",
            "/container/command", "/container/install", "/container/installer",
            "/container/reinstall", "/container/backup", "/container/restore",
            "/container/backup/upload", "/container/backup/download-token",
            "/container/logs/archives/download-token",
            "/fs/copy", "/fs/pull", "/fs/zip", "/fs/unzip", "/fs/rename",
            "/fs/upload", "/fs/create-empty-file", "/fs/mkdir", "/fs/append-file",
            "/fs/file/content", "/sftp/credentials", "/radar/scan", "/radar/zip",
        ]
        get_eps = [
            "/container/status", "/container/stats", "/container/logs/history",
            "/container/logs/archives", "/container/logs/archives/read",
            "/container/logs/archives/download", "/container/backup/download",
            "/fs/list", "/fs/size", "/fs/info", "/fs/file/content",
            "/fs/download", "/fs/download-token",
            "/sftp/status", "/sftp/activity", "/minecraft/players",
            "/stats", "/host", "/capabilities",
        ]
        del_eps = ["/container/kill", "/container", "/container/backup", "/fs/rm", "/sftp/credentials"]

        for ep in post_eps:
            for bad in ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]:
                resp = self._send(bad, ep)
                if resp is None:
                    self.error(suite, f"{bad}_{ep}", bad, ep, 0, "no response")
                    continue
                if resp.status_code == 500:
                    self.bug(suite, f"{bad}_{ep}", bad, ep, 500, "500 on wrong method")
                elif resp.status_code < 400:
                    self.bug(suite, f"{bad}_{ep}", bad, ep, resp.status_code, f"accepted {bad} on POST endpoint")
                else:
                    self.ok(suite, f"{bad}_{ep}", bad, ep, resp.status_code, "rejected")

        for ep in get_eps:
            for bad in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]:
                resp = self._send(bad, ep)
                if resp is None:
                    self.error(suite, f"{bad}_{ep}", bad, ep, 0, "no response")
                    continue
                if resp.status_code == 500:
                    self.bug(suite, f"{bad}_{ep}", bad, ep, 500, "500 on wrong method")
                elif resp.status_code < 400:
                    self.bug(suite, f"{bad}_{ep}", bad, ep, resp.status_code, f"accepted {bad} on GET endpoint")
                else:
                    self.ok(suite, f"{bad}_{ep}", bad, ep, resp.status_code, "rejected")

        for ep in del_eps:
            for bad in ["GET", "POST", "PUT", "PATCH", "OPTIONS"]:
                resp = self._send(bad, ep)
                if resp is None:
                    self.error(suite, f"{bad}_{ep}", bad, ep, 0, "no response")
                    continue
                if resp.status_code == 500:
                    self.bug(suite, f"{bad}_{ep}", bad, ep, 500, "500 on wrong method")
                elif resp.status_code < 400:
                    self.bug(suite, f"{bad}_{ep}", bad, ep, resp.status_code, f"accepted {bad} on DELETE endpoint")
                else:
                    self.ok(suite, f"{bad}_{ep}", bad, ep, resp.status_code, "rejected")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: auth_enforcement
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_auth(self):
        """Test auth bypass, invalid signatures, replay, expiry."""
        print("\n\033[96m=== Suite: auth_enforcement ===\033[0m")
        suite = "auth"
        ep = "/container/status"
        body = json.dumps({"id": self.container_id}).encode()

        # 1) No auth headers at all
        resp = self._send("GET", ep)
        if resp is None:
            self.error(suite, "no_auth", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "no_auth", "GET", ep, resp.status_code, "accepted without auth")
        else:
            self.ok(suite, "no_auth", "GET", ep, resp.status_code, "rejected")

        # 2) Wrong key
        wrong_key = "x" * 32
        ts = str(int(time.time()))
        nonce = secrets.token_hex(16)
        payload = f"{ts}:{nonce}:GET:/container/status:"
        sig = hmac_mod.new(wrong_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
        resp = self._send("GET", ep, headers={
            "X-HMAC-Timestamp": ts, "X-HMAC-Nonce": nonce, "X-HMAC-Signature": sig,
        })
        if resp is None:
            self.error(suite, "wrong_key", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "wrong_key", "GET", ep, resp.status_code, "accepted wrong key")
        else:
            self.ok(suite, "wrong_key", "GET", ep, resp.status_code, "rejected")

        # 3) Expired timestamp (>30s old)
        old_ts = str(int(time.time()) - 120)
        nonce2 = secrets.token_hex(16)
        payload2 = f"{old_ts}:{nonce2}:GET:/container/status:"
        sig2 = hmac_mod.new(self.key.encode(), payload2.encode(), hashlib.sha256).hexdigest()
        resp = self._send("GET", ep, headers={
            "X-HMAC-Timestamp": old_ts, "X-HMAC-Nonce": nonce2, "X-HMAC-Signature": sig2,
        })
        if resp is None:
            self.error(suite, "expired_ts", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "expired_ts", "GET", ep, resp.status_code, "accepted expired timestamp")
        else:
            self.ok(suite, "expired_ts", "GET", ep, resp.status_code, "rejected")

        # 4) Future timestamp (>60s ahead)
        future_ts = str(int(time.time()) + 120)
        nonce3 = secrets.token_hex(16)
        payload3 = f"{future_ts}:{nonce3}:GET:/container/status:"
        sig3 = hmac_mod.new(self.key.encode(), payload3.encode(), hashlib.sha256).hexdigest()
        resp = self._send("GET", ep, headers={
            "X-HMAC-Timestamp": future_ts, "X-HMAC-Nonce": nonce3, "X-HMAC-Signature": sig3,
        })
        if resp is None:
            self.error(suite, "future_ts", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "future_ts", "GET", ep, resp.status_code, "accepted future timestamp")
        else:
            self.ok(suite, "future_ts", "GET", ep, resp.status_code, "rejected")

        # 5) Replay attack: send same nonce twice
        h1 = self.sign_hmac("GET", "/container/status")
        resp1 = self._send("GET", ep, headers=h1)
        resp2 = self._send("GET", ep, headers=h1)  # same nonce
        if resp1 is None or resp2 is None:
            self.error(suite, "replay", "GET", ep, 0, "no response")
        elif resp2.status_code < 400:
            self.bug(suite, "replay", "GET", ep, resp2.status_code, "accepted replayed nonce")
        else:
            self.ok(suite, "replay", "GET", ep, resp2.status_code, "nonce replay blocked")

        # 6) Missing HMAC header fields
        for hdr in ["X-HMAC-Timestamp", "X-HMAC-Nonce", "X-HMAC-Signature"]:
            h = self.sign_hmac("GET", "/container/status")
            h.pop(hdr, None)
            resp = self._send("GET", ep, headers=h)
            if resp is None:
                self.error(suite, f"missing_{hdr}", "GET", ep, 0, "no response")
            elif resp.status_code < 400:
                self.bug(suite, f"missing_{hdr}", "GET", ep, resp.status_code, f"accepted without {hdr}")
            else:
                self.ok(suite, f"missing_{hdr}", "GET", ep, resp.status_code, "rejected")

        # 7) Empty/malformed signature
        resp = self._send("GET", ep, headers={
            "X-HMAC-Timestamp": str(int(time.time())),
            "X-HMAC-Nonce": secrets.token_hex(16),
            "X-HMAC-Signature": "not-a-hex-signature!!!",
        })
        if resp is None:
            self.error(suite, "bad_sig_format", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "bad_sig_format", "GET", ep, resp.status_code, "accepted bad sig format")
        else:
            self.ok(suite, "bad_sig_format", "GET", ep, resp.status_code, "rejected")

        # 8) Tampered body: sign one body, send another
        h4 = self.sign_hmac("POST", "/container/command", b'{"id":"x","command":"ls"}')
        resp = self._send("POST", "/container/command",
                          body={"id": self.container_id, "command": "ls"}, headers=h4)
        if resp is None:
            self.error(suite, "body_tamper", "POST", "/container/command", 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "body_tamper", "POST", "/container/command", resp.status_code, "accepted tampered body")
        else:
            self.ok(suite, "body_tamper", "POST", "/container/command", resp.status_code, "rejected")

        # 9) Method mismatch: sign GET, send POST
        h5 = self.sign_hmac("GET", "/container/command")
        resp = self._send("POST", "/container/command",
                          body={"id": self.container_id, "command": "ls"}, headers=h5)
        if resp is None:
            self.error(suite, "method_mismatch", "POST", "/container/command", 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "method_mismatch", "POST", "/container/command", resp.status_code, "accepted method mismatch")
        else:
            self.ok(suite, "method_mismatch", "POST", "/container/command", resp.status_code, "rejected")

        # 10) Path mismatch: sign /host, send /container/status
        h6 = self.sign_hmac("GET", "/host")
        resp = self._send("GET", "/container/status", headers=h6)
        if resp is None:
            self.error(suite, "path_mismatch", "GET", "/container/status", 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "path_mismatch", "GET", "/container/status", resp.status_code, "accepted path mismatch")
        else:
            self.ok(suite, "path_mismatch", "GET", "/container/status", resp.status_code, "rejected")

        # 11) Extremely long nonce (>128 bytes should be rejected)
        h7 = self.sign_hmac_with("GET", "/container/status", b"", str(int(time.time())), "A" * 256)
        resp = self._send("GET", "/container/status", headers=h7)
        if resp is None:
            self.error(suite, "long_nonce", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "long_nonce", "GET", ep, resp.status_code, "accepted oversized nonce")
        else:
            self.ok(suite, "long_nonce", "GET", ep, resp.status_code, "rejected")

        # 12) Non-numeric timestamp
        resp = self._send("GET", ep, headers={
            "X-HMAC-Timestamp": "not-a-number",
            "X-HMAC-Nonce": secrets.token_hex(16),
            "X-HMAC-Signature": "aa",
        })
        if resp is None:
            self.error(suite, "bad_timestamp", "GET", ep, 0, "no response")
        elif resp.status_code < 400:
            self.bug(suite, "bad_timestamp", "GET", ep, resp.status_code, "accepted non-numeric timestamp")
        else:
            self.ok(suite, "bad_timestamp", "GET", ep, resp.status_code, "rejected")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: path_traversal
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_path_traversal(self):
        """Test path traversal and jail escape on container IDs, file paths."""
        print("\n\033[96m=== Suite: path_traversal ===\033[0m")
        suite = "path_traversal"
        safe = "test123"

        # Container ID injection payloads
        container_ids = [
            ("normal", safe),
            ("dots", ".."),
            ("dots_slash", "../../../etc/passwd"),
            ("dots_backslash", "..\\..\\..\\etc\\passwd"),
            ("url_encoded_dots", "%2e%2e%2f"),
            ("double_encoded", "%252e%252e%252f"),
            ("null_byte", "test\x00container"),
            ("empty", ""),
            ("long_id", "a" * 1000),
            ("special_chars", "test;rm -rf /"),
            ("backtick", "test`id`"),
            ("dollar", "$(id)"),
            ("pipe", "test|cat /etc/passwd"),
            ("amp", "test&whoami"),
            ("glob", "test*"),
            ("brace", "test{1..100}"),
            ("unicode", "t\u00e9st"),
            ("hyphens", "-" * 64),
            ("underscores", "_" * 64),
            ("dot_only", "."),
            ("dot_dot_only", ".."),
            ("slash_start", "/etc/passwd"),
            ("slash_embedded", "a/b/c"),
            ("hex_escaped", "\\x2e\\x2e"),
            ("utf8_overlong", "\xc0\xae\xc0\xae"),
        ]

        # FS endpoints that take container-like IDs or paths
        fs_with_id = [
            ("GET", "/container/status/{id}"),
            ("GET", "/container/logs/{id}"),
        ]
        fs_with_path = [
            ("GET", "/fs/list?path={v}"),
            ("GET", "/fs/file/content?path={v}"),
            ("GET", "/fs/size?path={v}"),
            ("GET", "/fs/info?path={v}"),
            ("GET", "/fs/download?path={v}"),
            ("DELETE", "/fs/rm?path={v}"),
        ]

        for label, cid in container_ids:
            for method, tmpl in fs_with_id:
                url = tmpl.replace("{id}", cid)
                resp = self._signed_send(method, url)
                if resp is None:
                    self.error(suite, f"id_{label}", method, url, 0, "no response")
                elif resp.status_code == 500:
                    self.bug(suite, f"id_{label}", method, url, 500, f"500 on container id={label}")
                else:
                    self.ok(suite, f"id_{label}", method, url, resp.status_code, f"id={label}")

        # Path traversal in filesystem paths
        path_payloads = [
            ("normal", "data/test.txt"),
            ("dots", "../../../etc/passwd"),
            ("dots_unix", "....//....//etc/passwd"),
            ("dots_backslash", "..\\..\\..\\etc\\passwd"),
            ("abs_path", "/etc/passwd"),
            ("tilde", "~/etc/passwd"),
            ("null_byte", "data/test\x00.txt"),
            ("env_var", "$HOME/.ssh/id_rsa"),
            ("brace_expand", "${HOME}/.ssh/id_rsa"),
            ("cmd_sub", "$(cat /etc/passwd)"),
            ("pipe", "data/test|cat /etc/passwd"),
            ("backtick", "data/`cat /etc/passwd`"),
            ("glob", "data/*"),
            ("unicode_slash", "data/\u2215..\u2215..\u2215etc/passwd"),
            ("url_encoded_slash", "data%2F..%2F..%2Fetc%2Fpasswd"),
            ("double_encoded", "data%252F..%252F..%252Fetc%252Fpasswd"),
            ("dot_single", "."),
            ("dot_dot", ".."),
            ("empty", ""),
            ("whitespace", "  "),
            ("backslash", "data\\..\\..\\etc\\passwd"),
            ("long_path", "a/" * 500),
        ]

        for label, p in path_payloads:
            for method, tmpl in fs_with_path:
                url = tmpl.replace("{v}", p)
                resp = self._signed_send(method, url)
                if resp is None:
                    self.error(suite, f"path_{label}", method, url, 0, "no response")
                elif resp.status_code == 500:
                    self.bug(suite, f"path_{label}", method, url, 500, f"500 on path={label}")
                elif "etc/passwd" in str(resp.text).lower() or "root:" in str(resp.text).lower():
                    self.bug(suite, f"path_{label}", method, url, resp.status_code, "FILE LEAK: /etc/passwd content in response")
                else:
                    self.ok(suite, f"path_{label}", method, url, resp.status_code, f"path={label}")

        # Null byte in path via raw query string
        resp = self._signed_send("GET", "/fs/list?path=data/test%00.jpg")
        if resp is None:
            self.error(suite, "nullbyte_query", "GET", "/fs/list", 0, "no response")
        elif resp.status_code == 500:
            self.bug(suite, "nullbyte_query", "GET", "/fs/list", 500, "500 on null byte in query")
        else:
            self.ok(suite, "nullbyte_query", "GET", "/fs/list", resp.status_code, "null byte handled")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: injection
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_injection(self):
        """Test OS command injection, SQL injection, SSTI, and log injection in command field."""
        print("\n\033[96m=== Suite: injection ===\033[0m")
        suite = "injection"

        # /container/command endpoint - most likely to be injection-vulnerable
        payloads = [
            # OS command injection
            ("shell_simple", "ls"),
            ("shell_pipe", "ls | cat /etc/passwd"),
            ("shell_semi", "ls; cat /etc/passwd"),
            ("shell_amp", "ls && cat /etc/passwd"),
            ("shell_or", "ls || cat /etc/passwd"),
            ("shell_backtick", "`cat /etc/passwd`"),
            ("shell_dollar", "$(cat /etc/passwd)"),
            ("shell_dollar_paren", "$(cat /etc/passwd)"),
            ("shell_newline", "ls\ncat /etc/passwd"),
            ("shell_crlf", "ls\r\ncat /etc/passwd"),
            ("shell_null", "ls\x00cat /etc/passwd"),
            ("shell_single_quote", "ls'; cat /etc/passwd #"),
            ("shell_double_quote", 'ls"; cat /etc/passwd #'),
            # SSTI
            ("ssti_jinja", "{{7*7}}"),
            ("ssti_jinja2", "{{config.__class__.__init__.__globals__['os'].popen('id').read()}}"),
            ("ssti_django", "{% load %}"),
            # SQL injection (in command string)
            ("sql_single", "' OR 1=1 --"),
            ("sql_union", "' UNION SELECT * FROM users --"),
            # Path injection
            ("path_rce", "/etc/passwd"),
            ("path_read", "../../../../etc/passwd"),
            # Log injection
            ("log_newline", "ls\n[FORGED] admin logged in"),
            ("log_tab", "ls\t[FORGED] admin action"),
            ("log_ansi", "\x1b[31mFAKE ERROR\x1b[0m"),
            # Unicode tricks
            ("unicode_homoglyph", "l\u0441\\`cat /etc/passwd\\`"),
            ("rtl_override", "\u202ecat /etc/passwd"),
            # Extremely long command
            ("long_cmd", "A" * 10000),
            # Empty / whitespace
            ("empty", ""),
            ("spaces", "   "),
            ("newline_only", "\n"),
            # Format string
            ("fmt_string", "%s%s%s%s%s%s"),
            # Control characters
            ("ctrl_bell", "\x07"),
            ("ctrl_formfeed", "\x0c"),
            ("ctrl_esc", "\x1b"),
        ]

        for label, cmd in payloads:
            body = {"id": self.container_id, "command": cmd}
            resp = self._signed_send("POST", "/container/command", body=body)
            if resp is None:
                self.error(suite, label, "POST", "/container/command", 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, "POST", "/container/command", 500, f"500 on injection: {label}")
            else:
                # Check response for evidence of command execution
                text = resp.text.lower() if resp else ""
                leaks = ["root:", "bin/bash", "uid=", "/bin/sh"]
                if any(leak in text for leak in leaks):
                    self.bug(suite, label, "POST", "/container/command", resp.status_code,
                             f"evidence of RCE: {label}")
                else:
                    self.ok(suite, label, "POST", "/container/command", resp.status_code, f"injection={label}")

        # Injection in container start (env vars, config files)
        inject_start_cases = [
            ("env_inject", {
                "id": self.container_id,
                "env": {"EVIL": "; cat /etc/passwd"},
                "startCommand": "echo $EVIL",
            }),
            ("env_newline", {
                "id": self.container_id,
                "env": {"EVIL": "val\ninjected_line"},
            }),
            ("config_file_traversal", {
                "id": self.container_id,
                "configFiles": [{"path": "../../etc/cron.d/evil", "content": "* * * * * root reverse"}],
            }),
            ("env_overflow", {
                "id": self.container_id,
                "env": {f"KEY{i}": "v" * 10000 for i in range(100)},
            }),
        ]

        for label, body in inject_start_cases:
            resp = self._signed_send("POST", "/container/start", body=body)
            if resp is None:
                self.error(suite, label, "POST", "/container/start", 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, "POST", "/container/start", 500, f"500 on: {label}")
            else:
                    self.ok(suite, label, "POST", "/container/start", resp.status_code, f"injection={label}")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: body_fuzzing
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_body(self):
        """Test malformed, oversized, and type-confused request bodies."""
        print("\n\033[96m=== Suite: body_fuzzing ===\033[0m")
        suite = "body"

        post_endpoints_with_body = [
            "/container/start", "/container/command", "/container/install",
            "/fs/copy", "/fs/mkdir", "/fs/file/content", "/fs/rename",
            "/fs/append-file", "/fs/create-empty-file",
            "/container/backup", "/container/restore",
            "/sftp/credentials",
        ]

        body_payloads = [
            # Type confusion
            ("string", "hello"),
            ("number", 12345),
            ("bool_true", True),
            ("bool_false", False),
            ("null", None),
            ("array", [1, 2, 3]),
            ("nested_array", [[], []]),

            # Structural corruption
            ("empty_json", {}),
            ("trailing_comma", None),  # sent as raw
            ("unclosed_brace", None),
            ("deeply_nested", {"a": {"b": {"c": {"d": {"e": {"f": {"g": 1}}}}}}}),
            ("wide_object", {f"key{i}": f"val{i}" for i in range(1000)}),

            # Unicode
            ("unicode_key", {"\u00e9\u00e8\u00ea": "val"}),
            ("emoji_val", {"key": "\U0001f600" * 100}),
            ("bidi_override", {"\u202ekey": "val"}),

            # Numeric extremes
            ("zero", 0),
            ("neg_one", -1),
            ("int_max", 2**31 - 1),
            ("int_overflow", 2**63),
            ("float_nan", float("nan")),
            ("float_inf", float("inf")),
            ("neg_inf", float("-inf")),
            ("neg_zero", -0.0),
            ("very_small_float", 1e-300),
            ("very_large_float", 1e300),
            ("string_number", "999999999999999999999999999999"),
        ]

        # Truncated / corrupt JSON
        raw_payloads = [
            ("unclosed_obj", b'{"key": "val"'),
            ("unclosed_arr", b'{"key": [1, 2'),
            ("truncated_val", b'{"key": "val'),
            ("double_quote", b'""'),
            ("single_quote", b"{'key': 'val'}"),
            ("empty_body", b""),
            ("binary_garbage", b"\x00\x01\x02\x03\xff\xfe\xfd"),
            ("utf8_bom", b"\xef\xbb\xbf{}"),
            ("double_json", b'{}{}'),
            ("json_array", b'[1,2,3]'),
            ("huge_value", b'{"x": "' + b"A" * (1024 * 1024) + b'"}'),
            ("null_bytes", b'{"k": "\x00\x00\x00"}'),
            ("backslash_ends", b'{"k": "\\'),
        ]

        for ep in post_endpoints_with_body:
            for label, body in body_payloads:
                if label == "trailing_comma":
                    continue
                resp = self._signed_send("POST", ep, body=body)
                if resp is None:
                    self.error(suite, f"{label}_{ep}", "POST", ep, 0, "no response")
                elif resp.status_code == 500:
                    self.bug(suite, f"{label}_{ep}", "POST", ep, 500, f"500 on {label}")
                else:
                    self.ok(suite, f"{label}_{ep}", "POST", ep, resp.status_code, f"body={label}")

            for label, raw in raw_payloads:
                h = self.sign_hmac("POST", ep, raw)
                resp = self._send("POST", ep, raw_body=raw, headers=h)
                if resp is None:
                    self.error(suite, f"raw_{label}_{ep}", "POST", ep, 0, "no response")
                elif resp.status_code == 500:
                    self.bug(suite, f"raw_{label}_{ep}", "POST", ep, 500, f"500 on raw={label}")
                else:
                    self.ok(suite, f"raw_{label}_{ep}", "POST", ep, resp.status_code, f"raw={label}")

        # Trailing comma (raw JSON)
        for ep in post_endpoints_with_body:
            raw = b'{"id": "test", "key": "val",}'
            h = self.sign_hmac("POST", ep, raw)
            resp = self._send("POST", ep, raw_body=raw, headers=h)
            if resp is None:
                self.error(suite, f"trailing_comma_{ep}", "POST", ep, 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, f"trailing_comma_{ep}", "POST", ep, 500, "500 on trailing comma")
            else:
                self.ok(suite, f"trailing_comma_{ep}", "POST", ep, resp.status_code, "trailing comma handled")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: content_type
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_content_type(self):
        """Test wrong/missing Content-Type headers."""
        print("\n\033[96m=== Suite: content_type ===\033[0m")
        suite = "content_type"
        ep = "/container/command"
        body = {"id": self.container_id, "command": "ls"}
        raw = json.dumps(body).encode()

        content_types = [
            ("missing", {}),
            ("text_plain", {"Content-Type": "text/plain"}),
            ("xml", {"Content-Type": "application/xml"}),
            ("form_urlencoded", {"Content-Type": "application/x-www-form-urlencoded"}),
            ("multipart", {"Content-Type": "multipart/form-data"}),
            ("yaml", {"Content-Type": "application/x-yaml"}),
            ("html", {"Content-Type": "text/html"}),
            ("octet_stream", {"Content-Type": "application/octet-stream"}),
            ("json_charset", {"Content-Type": "application/json; charset=utf-8"}),
            ("json_uppercase", {"Content-Type": "APPLICATION/JSON"}),
            ("garbage", {"Content-Type": ";;;weird;;;"}),
        ]

        for label, ct in content_types:
            h = self.sign_hmac("POST", ep, raw)
            h.update(ct)
            resp = self._send("POST", ep, raw_body=raw, headers=h)
            if resp is None:
                self.error(suite, label, "POST", ep, 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, "POST", ep, 500, f"500 on Content-Type: {label}")
            else:
                self.ok(suite, label, "POST", ep, resp.status_code, f"Content-Type={label}")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: ssrf
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_ssrf(self):
        """Test SSRF protection on /fs/pull and /container/install."""
        print("\n\033[96m=== Suite: ssrf ===\033[0m")
        suite = "ssrf"

        ssrf_urls = [
            # Loopback
            ("localhost", "http://127.0.0.1:3002/stats"),
            ("localhost_alt", "http://localhost:3002/stats"),
            ("ipv6_loopback", "http://[::1]:3002/stats"),
            ("zero_addr", "http://0.0.0.0/stats"),
            ("decimal_ip", "http://2130706433/stats"),
            ("hex_ip", "http://0x7f000001/stats"),
            ("octal_ip", "http://0177.0.0.1/stats"),
            ("ip_variants", "http://127.1/stats"),
            ("ip_double", "http://127.0.0.1.1/stats"),

            # Private ranges
            ("class_a", "http://10.0.0.1:8080/secret"),
            ("class_b", "http://172.16.0.1:8080/secret"),
            ("class_c", "http://192.168.1.1:8080/secret"),
            ("class_b_max", "http://172.31.255.255/secret"),
            ("link_local", "http://169.254.169.254/latest/meta-data/"),
            ("cgnat", "http://100.64.0.1/secret"),

            # Cloud metadata
            ("aws_meta", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
            ("gcp_meta", "http://metadata.google.internal/computeMetadata/v1/"),
            ("azure_meta", "http://169.254.169.254/metadata/instance?api-version=2021-02-01"),

            # Protocol confusion
            ("file_proto", "file:///etc/passwd"),
            ("ftp_proto", "ftp://127.0.0.1/"),
            ("gopher_proto", "gopher://127.0.0.1:25/"),
            ("dict_proto", "dict://127.0.0.1:6379/info"),
            ("data_proto", "data:text/html,<h1>test</h1>"),
            ("javascript_proto", "javascript:alert(1)"),

            # DNS rebinding (will likely resolve but should be caught by IP check)
            ("dns_localhost", "http://localtest.me/stats"),

            # Redirect tricks (external)
            ("redirect_to_localhost", "http://httpbin.org/redirect-to?url=http://127.0.0.1:3002/stats"),
        ]

        for label, url in ssrf_urls:
            body = {"id": self.container_id, "url": url}
            resp = self._signed_send("POST", "/fs/pull", body=body)
            if resp is None:
                self.error(suite, label, "POST", "/fs/pull", 0, "no response (possible crash)")
            elif resp.status_code == 500:
                self.bug(suite, label, "POST", "/fs/pull", 500, f"500 on SSRF attempt: {label}")
            elif resp.status_code < 400:
                self.bug(suite, label, "POST", "/fs/pull", resp.status_code, f"SSRF ALLOWED: {label}")
            else:
                self.ok(suite, label, "POST", "/fs/pull", resp.status_code, f"blocked: {label}")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: boundary_values
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_boundary(self):
        """Test boundary values: huge payloads, empty fields, max lengths, rate limits."""
        print("\n\033[96m=== Suite: boundary_values ===\033[0m")
        suite = "boundary"

        # 1) Oversized JSON body (should hit body size limit)
        huge_body = {"data": "x" * (10 * 1024 * 1024)}  # 10 MiB
        raw_huge = json.dumps(huge_body).encode()
        h = self.sign_hmac("POST", "/container/command", raw_huge)
        resp = self._send("POST", "/container/command", raw_body=raw_huge, headers=h)
        if resp is None:
            self.error(suite, "huge_body", "POST", "/container/command", 0, "no response (possible OOM)")
        elif resp.status_code == 500:
            self.bug(suite, "huge_body", "POST", "/container/command", 500, "500 on oversized body")
        else:
            self.ok(suite, "huge_body", "POST", "/container/command", resp.status_code, "handled")

        # 2) Extremely long Content-Length header
        h2 = self.sign_hmac("GET", "/stats")
        h2["Content-Length"] = "99999999999"
        resp = self._send("GET", "/stats", headers=h2)
        if resp is None:
            self.error(suite, "long_content_length", "GET", "/stats", 0, "no response")
        elif resp.status_code == 500:
            self.bug(suite, "long_content_length", "GET", "/stats", 500, "500 on huge Content-Length")
        else:
            self.ok(suite, "long_content_length", "GET", "/stats", resp.status_code, "handled")

        # 3) Very large number of query params
        qs = "&".join(f"param{i}=value{i}" for i in range(1000))
        resp = self._signed_send("GET", f"/fs/list?{qs}")
        if resp is None:
            self.error(suite, "many_query_params", "GET", "/fs/list", 0, "no response")
        elif resp.status_code == 500:
            self.bug(suite, "many_query_params", "GET", "/fs/list", 500, "500 on 1000 query params")
        else:
            self.ok(suite, "many_query_params", "GET", "/fs/list", resp.status_code, "handled")

        # 4) Missing required fields
        missing_field_cases = [
            ("start_no_id", "POST", "/container/start", {}),
            ("start_empty_id", "POST", "/container/start", {"id": ""}),
            ("command_no_id", "POST", "/container/command", {"command": "ls"}),
            ("command_no_cmd", "POST", "/container/command", {"id": self.container_id}),
            ("command_both_missing", "POST", "/container/command", {}),
            ("fs_list_no_path", "GET", "/fs/list", None),
            ("fs_read_no_path", "GET", "/fs/file/content", None),
            ("copy_no_source", "POST", "/fs/copy", {}),
            ("mkdir_no_path", "POST", "/fs/mkdir", {}),
        ]

        for label, method, ep, body in missing_field_cases:
            resp = self._signed_send(method, ep, body=body)
            if resp is None:
                self.error(suite, label, method, ep, 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, method, ep, 500, f"500 on missing field: {label}")
            else:
                self.ok(suite, label, method, ep, resp.status_code, f"missing={label}")

        # 5) Container ID length boundaries
        id_cases = [
            ("empty_id", ""),
            ("1_char", "a"),
            ("63_chars", "a" * 63),
            ("64_chars", "a" * 64),
            ("65_chars", "a" * 65),
            ("256_chars", "a" * 256),
            ("1000_chars", "a" * 1000),
        ]

        for label, cid in id_cases:
            body = {"id": cid}
            resp = self._signed_send("POST", "/container/start", body=body)
            if resp is None:
                self.error(suite, label, "POST", "/container/start", 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, "POST", "/container/start", 500, f"500 on id len={len(cid)}")
            else:
                self.ok(suite, label, "POST", "/container/start", resp.status_code, f"id_len={len(cid)}")

        # 6) Negative numbers for port-like fields
        body = {"id": self.container_id, "sftpPort": -1}
        resp = self._signed_send("POST", "/container/start", body=body)
        if resp is None:
            self.error(suite, "neg_port", "POST", "/container/start", 0, "no response")
        elif resp.status_code == 500:
            self.bug(suite, "neg_port", "POST", "/container/start", 500, "500 on negative port")
        else:
            self.ok(suite, "neg_port", "POST", "/container/start", resp.status_code, "negative port handled")

        # 7) Concurrent rapid-fire requests (basic rate limit test)
        print("  \033[90m[...] rate limit test (50 rapid requests)\033[0m", end="", flush=True)
        codes = []
        for _ in range(50):
            resp = self._signed_send("GET", "/stats")
            if resp:
                codes.append(resp.status_code)
        rate_limited = any(c == 429 for c in codes)
        if rate_limited:
            print(f" -> \033[92m429 seen (rate limit active)\033[0m")
        elif codes and all(c == 200 for c in codes):
            print(f" -> \033[93mno 429 after 50 rapid requests\033[0m")
            self.interesting(suite, "rate_limit", "GET", "/stats", 200, "no rate limiting after 50 rapid requests")
        else:
            print(f" -> codes: {set(codes)}")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: header_injection
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_headers(self):
        """Test oversized, malformed, and injection-bearing headers."""
        print("\n\033[96m=== Suite: header_injection ===\033[0m")
        suite = "headers"

        # Oversized headers
        big_val = "A" * 8192
        cases = [
            ("huge_user_agent", {"User-Agent": big_val}),
            ("huge_accept", {"Accept": big_val}),
            ("huge_referer", {"Referer": big_val}),
            ("custom_huge", {"X-Custom-Header": big_val}),
        ]

        for label, hdrs in cases:
            h = self.sign_hmac("GET", "/stats")
            h.update(hdrs)
            resp = self._send("GET", "/stats", headers=h)
            if resp is None:
                self.error(suite, label, "GET", "/stats", 0, "no response (possible crash)")
            elif resp.status_code == 500:
                self.bug(suite, label, "GET", "/stats", 500, f"500 on: {label}")
            else:
                self.ok(suite, label, "GET", "/stats", resp.status_code, f"header={label}")

        # Header injection via CRLF
        cfrl_cases = [
            ("crlf_in_ua", "User-Agent", "normal\r\nX-Injected: true"),
            ("lf_in_ua", "User-Agent", "normal\nX-Injected: true"),
            ("cr_in_ua", "User-Agent", "normal\rX-Injected: true"),
        ]
        for label, name, val in cfrl_cases:
            resp = self._signed_send("GET", "/stats", extra_headers={name: val})
            if resp is None:
                self.error(suite, label, "GET", "/stats", 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, "GET", "/stats", 500, f"500 on CRLF in header")
            else:
                self.ok(suite, label, "GET", "/stats", resp.status_code, f"CRLF header={label}")

        # X-Forwarded-For spoofing
        spoof_ips = [
            ("xff_loopback", "127.0.0.1"),
            ("xff_aws", "169.254.169.254"),
            ("xff_chain", "1.1.1.1, 127.0.0.1"),
            ("xff_fake_trusted", "192.168.1.1, 127.0.0.1"),
        ]
        for label, ip in spoof_ips:
            resp = self._signed_send("GET", "/host", extra_headers={"X-Forwarded-For": ip})
            if resp is None:
                self.error(suite, label, "GET", "/host", 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, label, "GET", "/host", 500, f"500 on XFF spoof")
            else:
                self.ok(suite, label, "GET", "/host", resp.status_code, f"XFF={ip}")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: websocket_auth
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_websocket(self):
        """Test WebSocket auth sequences, malformed frames, and edge cases."""
        print("\n\033[96m=== Suite: websocket_auth ===\033[0m")
        suite = "ws"
        endpoint = "/ws/containerstatus/" + self.container_id

        try:
            import websocket
        except ImportError:
            print("  \033[90m[...] websocket-client not installed, skipping\033[0m")
            return

        ws_url = f"ws://{self.host}:{self.port}{endpoint}"

        # 1) Connect and send no auth (should timeout or close)
        try:
            ws = websocket.create_connection(ws_url, timeout=3)
            time.sleep(0.5)
            # If still open, try sending data without auth
            ws.send(json.dumps({"event": "cmd", "command": "ls"}))
            try:
                resp = ws.recv()
                if resp:
                    data = json.loads(resp) if isinstance(resp, str) else None
                    if data and "error" in data:
                        self.ok(suite, "no_auth_cmd", "WS", endpoint, 0, "rejected: " + data["error"])
                    else:
                        self.bug(suite, "no_auth_cmd", "WS", endpoint, 0, "accepted cmd without auth")
                else:
                    self.bug(suite, "no_auth_cmd", "WS", endpoint, 0, "accepted cmd without auth")
            except websocket.WebSocketTimeoutException:
                self.ok(suite, "no_auth_cmd", "WS", endpoint, 0, "timed out (no auth allowed)")
            except Exception:
                self.ok(suite, "no_auth_cmd", "WS", endpoint, 0, "connection closed")
            ws.close()
        except Exception as e:
            self.ok(suite, "no_auth_cmd", "WS", endpoint, 0, f"connect rejected: {e}")

        # 2) Auth with wrong key
        try:
            ws = websocket.create_connection(ws_url, timeout=3)
            wrong_hmac = hmac_mod.new(b"wrong_key_wrong_key_1234567890",
                                       b"0:nonce:GET:" + endpoint.encode(), hashlib.sha256).hexdigest()
            ts = str(int(time.time()))
            payload = f"{ts}:wrongnonce:GET:{endpoint}:"
            sig = hmac_mod.new(b"wrong_key_wrong_key_1234567890", payload.encode(), hashlib.sha256).hexdigest()
            ws.send(json.dumps({
                "event": "auth",
                "args": [sig],
            }))
            try:
                resp = ws.recv()
                data = json.loads(resp) if isinstance(resp, str) else None
                if data and "error" in data:
                    self.ok(suite, "wrong_key_auth", "WS", endpoint, 0, "rejected: " + data["error"])
                else:
                    self.bug(suite, "wrong_key_auth", "WS", endpoint, 0, "accepted wrong key")
            except Exception:
                self.ok(suite, "wrong_key_auth", "WS", endpoint, 0, "connection closed after wrong key")
            ws.close()
        except Exception as e:
            self.ok(suite, "wrong_key_auth", "WS", endpoint, 0, f"connect rejected: {e}")

        # 3) Auth with valid key, then send commands
        try:
            ws = websocket.create_connection(ws_url, timeout=5)
            ts = str(int(time.time()))
            nonce = secrets.token_hex(16)
            path = f"/ws/containerstatus/{self.container_id}"
            payload = f"{ts}:{nonce}:GET:{path}:"
            sig = hmac_mod.new(self.key.encode(), payload.encode(), hashlib.sha256).hexdigest()
            ws.send(json.dumps({"event": "auth", "args": [sig]}))
            time.sleep(0.3)
            ws.settimeout(2)

            # After auth, send valid cmd on status route (should fail: CMD only valid on container route)
            ws.send(json.dumps({"event": "cmd", "command": "ls"}))
            try:
                resp = ws.recv()
                data = json.loads(resp) if isinstance(resp, str) else None
                if data and "error" in data:
                    self.ok(suite, "cmd_on_status", "WS", endpoint, 0, "correctly rejected: " + data.get("error", ""))
                else:
                    self.bug(suite, "cmd_on_status", "WS", endpoint, 0, "accepted CMD on status route")
            except Exception:
                self.ok(suite, "cmd_on_status", "WS", endpoint, 0, "connection closed after invalid CMD")
            ws.close()
        except Exception as e:
            self.error(suite, "valid_auth_cmd_status", "WS", endpoint, 0, f"error: {e}")

        # 4) Malformed JSON over WS
        try:
            ws = websocket.create_connection(ws_url, timeout=3)
            ws.send("{invalid json!!!")
            try:
                resp = ws.recv()
                data = json.loads(resp) if isinstance(resp, str) else None
                if data and "error" in data:
                    self.ok(suite, "malformed_json", "WS", endpoint, 0, "rejected: " + data.get("error", ""))
                else:
                    self.bug(suite, "malformed_json", "WS", endpoint, 0, "accepted malformed JSON")
            except Exception:
                self.ok(suite, "malformed_json", "WS", endpoint, 0, "connection closed")
            ws.close()
        except Exception as e:
            self.ok(suite, "malformed_json", "WS", endpoint, 0, f"connect rejected: {e}")

        # 5) Empty event field
        try:
            ws = websocket.create_connection(ws_url, timeout=3)
            ws.send(json.dumps({"event": ""}))
            try:
                resp = ws.recv()
                data = json.loads(resp) if isinstance(resp, str) else None
                if data and "error" in data:
                    self.ok(suite, "empty_event", "WS", endpoint, 0, "rejected: " + data.get("error", ""))
                else:
                    self.bug(suite, "empty_event", "WS", endpoint, 0, "accepted empty event")
            except Exception:
                self.ok(suite, "empty_event", "WS", endpoint, 0, "connection closed")
            ws.close()
        except Exception as e:
            self.ok(suite, "empty_event", "WS", endpoint, 0, f"connect rejected: {e}")

        # 6) Huge WS message (1 MiB)
        try:
            ws = websocket.create_connection(ws_url, timeout=3)
            huge_msg = json.dumps({"event": "auth", "args": ["A" * (1024 * 1024)]})
            ws.send(huge_msg)
            try:
                resp = ws.recv()
                data = json.loads(resp) if isinstance(resp, str) else None
                if data and "error" in data:
                    self.ok(suite, "huge_ws_msg", "WS", endpoint, 0, "rejected: " + data.get("error", ""))
                else:
                    self.bug(suite, "huge_ws_msg", "WS", endpoint, 0, "accepted 1MiB auth arg")
            except Exception:
                self.ok(suite, "huge_ws_msg", "WS", endpoint, 0, "connection closed")
            ws.close()
        except Exception as e:
            self.ok(suite, "huge_ws_msg", "WS", endpoint, 0, f"connect rejected: {e}")

        # 7) Binary frame
        try:
            ws = websocket.create_connection(ws_url, timeout=3)
            ws.send_binary(b"\x00\x01\x02\x03\x04\x05")
            try:
                resp = ws.recv()
                data = json.loads(resp) if isinstance(resp, str) else None
                if data and "error" in data:
                    self.ok(suite, "binary_frame", "WS", endpoint, 0, "rejected binary frame")
                else:
                    self.bug(suite, "binary_frame", "WS", endpoint, 0, "accepted binary frame")
            except Exception:
                self.ok(suite, "binary_frame", "WS", endpoint, 0, "connection closed on binary frame")
            ws.close()
        except Exception as e:
            self.ok(suite, "binary_frame", "WS", endpoint, 0, f"connect rejected: {e}")

        # 8) Rapid reconnect storm
        try:
            closed = 0
            for _ in range(30):
                try:
                    ws = websocket.create_connection(ws_url, timeout=1)
                    ws.close()
                    closed += 1
                except Exception:
                    break
            if closed > 25:
                self.interesting(suite, "reconnect_storm", "WS", endpoint, 0,
                                f"accepted {closed}/30 rapid reconnects")
            else:
                self.ok(suite, "reconnect_storm", "WS", endpoint, 0,
                        f"rate limited after {closed} reconnects")
        except Exception as e:
            self.error(suite, "reconnect_storm", "WS", endpoint, 0, f"error: {e}")

    # ═══════════════════════════════════════════════════════════════════════════
    # SUITE: error_handling
    # ═══════════════════════════════════════════════════════════════════════════

    def fuzz_error_handling(self):
        """Test unknown routes, invalid query params, error response format."""
        print("\n\033[96m=== Suite: error_handling ===\033[0m")
        suite = "error_handling"

        # Unknown routes
        unknown_routes = [
            ("GET", "/nonexistent"),
            ("GET", "/container/nonexistent"),
            ("GET", "/admin"),
            ("GET", "/api/v1/stats"),
            ("GET", "/../../../etc/passwd"),
            ("GET", "/%00"),
        ]
        for method, route in unknown_routes:
            resp = self._signed_send(method, route)
            if resp is None:
                self.error(suite, f"unknown_{route}", method, route, 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, f"unknown_{route}", method, route, 500, "500 on unknown route")
            elif resp.status_code == 404:
                self.ok(suite, f"unknown_{route}", method, route, 404, "404 on unknown route")
            else:
                self.ok(suite, f"unknown_{route}", method, route, resp.status_code, "handled unknown route")

        # Error response format check
        resp = self._signed_send("POST", "/container/command", body={"id": "nonexistent_container"})
        if resp:
            try:
                data = resp.json()
                if "error" in data and "code" in data:
                    self.ok(suite, "error_format", "POST", "/container/command", resp.status_code,
                            "error envelope has error+code")
                else:
                    self.interesting(suite, "error_format", "POST", "/container/command", resp.status_code,
                                     f"error envelope missing fields: {list(data.keys())}")
            except Exception:
                self.interesting(suite, "error_format", "POST", "/container/command", resp.status_code,
                                 "response is not JSON")

        # Double slash paths
        double_slash_routes = [
            ("GET", "//stats"),
            ("GET", "///stats"),
            ("GET", "/container//status"),
            ("GET", "/container/status//nonexistent"),
        ]
        for method, route in double_slash_routes:
            resp = self._signed_send(method, route)
            if resp is None:
                self.error(suite, f"dslash_{route}", method, route, 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, f"dslash_{route}", method, route, 500, f"500 on double-slash path")
            else:
                self.ok(suite, f"dslash_{route}", method, route, resp.status_code, f"double-slash handled")

        # Unicode paths
        unicode_routes = [
            ("GET", "/stats\u0000"),
            ("GET", "/stats\u200b"),
            ("GET", "/\u00e9\u00e8\u00ea/stats"),
        ]
        for method, route in unicode_routes:
            resp = self._signed_send(method, route)
            if resp is None:
                self.error(suite, f"unicode_{route}", method, route, 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, f"unicode_{route}", method, route, 500, "500 on unicode path")
            else:
                self.ok(suite, f"unicode_{route}", method, route, resp.status_code, "unicode path handled")

        # Method override headers
        override_headers = [
            ("X-HTTP-Method-Override", "DELETE"),
            ("X-HTTP-Method", "DELETE"),
            ("X-Method-Override", "DELETE"),
        ]
        for name, val in override_headers:
            resp = self._signed_send("GET", "/stats", extra_headers={name: val})
            if resp is None:
                self.error(suite, f"override_{name}", "GET", "/stats", 0, "no response")
            elif resp.status_code == 500:
                self.bug(suite, f"override_{name}", "GET", "/stats", 500, f"500 on method override")
            elif resp.status_code < 400:
                self.bug(suite, f"override_{name}", "GET", "/stats", resp.status_code,
                         f"method override accepted: {name}={val}")
            else:
                self.ok(suite, f"override_{name}", "GET", "/stats", resp.status_code, "override rejected")


# ── Runner ───────────────────────────────────────────────────────────────────

ALL_SUITES = [
    "methods", "auth", "path_traversal", "injection", "body",
    "content_type", "ssrf", "boundary", "headers", "websocket", "error_handling",
]


def run_all(f: Fuzzer):
    f.fuzz_methods()
    f.fuzz_auth()
    f.fuzz_path_traversal()
    f.fuzz_injection()
    f.fuzz_body()
    f.fuzz_content_type()
    f.fuzz_ssrf()
    f.fuzz_boundary()
    f.fuzz_headers()
    f.fuzz_websocket()
    f.fuzz_error_handling()


def summary(f: Fuzzer):
    total = len(f.findings)
    bugs = [x for x in f.findings if x.verdict == Verdict.BUG]
    interesting = [x for x in f.findings if x.verdict == Verdict.INTERESTING]

    print(f"\n{'=' * 80}")
    print(f"FUZZ RESULTS: {total} cases tested")
    print(f"{'=' * 80}")
    print(f"  \033[92mPASS:       {f.counts[Verdict.PASS]:4d}\033[0m")
    print(f"  \033[91mBUG:        {f.counts[Verdict.BUG]:4d}\033[0m")
    print(f"  \033[93mINTERESTING:{f.counts[Verdict.INTERESTING]:4d}\033[0m")
    print(f"  \033[90mERROR:      {f.counts[Verdict.ERROR]:4d}\033[0m")

    if bugs:
        print(f"\n\033[91m{'=' * 80}")
        print(f"BUGS FOUND ({len(bugs)})")
        print(f"{'=' * 80}\033[0m")
        for b in bugs:
            print(f"  \033[91m[BUG]\033[0m {b.method:7s} {b.url}  {b.detail}")

    if interesting:
        print(f"\n\033[93m{'=' * 80}")
        print(f"INTERESTING FINDINGS ({len(interesting)})")
        print(f"{'=' * 80}\033[0m")
        for i in interesting:
            print(f"  \033[93m[???]\033[0m {i.method:7s} {i.url}  {i.detail}")

    # Write report
    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fuzz_report.json")
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "target": f.base,
        "total": total,
        "counts": {k.value: v for k, v in f.counts.items()},
        "bugs": [
            {"suite": b.suite, "case": b.case, "method": b.method, "url": b.url,
             "status": b.status_code, "detail": b.detail}
            for b in bugs
        ],
        "interesting": [
            {"suite": i.suite, "case": i.case, "method": i.method, "url": i.url,
             "status": i.status_code, "detail": i.detail}
            for i in interesting
        ],
    }
    with open(report_path, "w") as fp:
        json.dump(report, fp, indent=2)
    print(f"\nReport written to {report_path}")


def main():
    parser = argparse.ArgumentParser(description="Airlinkd Daemon Fuzzer")
    parser.add_argument("--host", default="localhost", help="Daemon host (default: localhost)")
    parser.add_argument("--port", type=int, default=3002, help="Daemon port (default: 3002)")
    parser.add_argument("--key", required=True, help="Daemon HMAC key")
    parser.add_argument("--suite", choices=ALL_SUITES + ["all"], default="all",
                        help="Fuzz suite to run (default: all)")
    parser.add_argument("--container-id", default="test-container",
                        help="Container ID for tests (default: test-container)")
    args = parser.parse_args()

    f = Fuzzer(args.host, args.port, args.key)
    f.container_id = args.container_id

    print(f"\033[96mAirlinkd Fuzzer\033[0m  target={f.base}  container={f.container_id}")

    try:
        if args.suite == "all":
            run_all(f)
        else:
            suite_fn = {
                "methods": f.fuzz_methods,
                "auth": f.fuzz_auth,
                "path_traversal": f.fuzz_path_traversal,
                "injection": f.fuzz_injection,
                "body": f.fuzz_body,
                "content_type": f.fuzz_content_type,
                "ssrf": f.fuzz_ssrf,
                "boundary": f.fuzz_boundary,
                "headers": f.fuzz_headers,
                "websocket": f.fuzz_websocket,
                "error_handling": f.fuzz_error_handling,
            }[args.suite]
            suite_fn()
    except KeyboardInterrupt:
        print("\n\033[93mAborted by user\033[0m")

    summary(f)


if __name__ == "__main__":
    main()
