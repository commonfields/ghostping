#!/usr/bin/env python3
"""Exercise the agency record through built API/worker processes, mock only.

Requires an explicitly disposable loopback database. Fixture human decisions
are TEST-only; no real client identity, approval, provider call or publication.
"""
import http.cookiejar
import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

root = Path(__file__).resolve().parent.parent
database = urllib.parse.urlsplit(os.environ.get("DATABASE_URL", ""))
if os.environ.get("HOSTED_SMOKE_ALLOWED") != "1" or database.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit("refusing: require HOSTED_SMOKE_ALLOWED=1 and a disposable loopback database")
port = int(os.environ.get("HOSTED_SMOKE_PORT", "3018"))
base = f"http://127.0.0.1:{port}"
processes = []


def session():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(client, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json", "Origin": base})
    try:
        with client.open(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def ok(client, path, payload=None):
    status, body = request(client, path, payload)
    assert status == 200, "agency workflow request failed"
    return body


def completed(client, path, run_id):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        record = ok(client, path)["record"]
        run = next(r for r in record["runs"] if r["id"] == run_id)
        if run["status"] not in ("QUEUED", "RUNNING"):
            assert run["status"] == "SUCCEEDED", "fixture check did not succeed"
            return run
        time.sleep(0.1)
    raise RuntimeError("agency check completion timed out")


try:
    env = dict(os.environ, PORT=str(port), APP_BASE_URL=base, RECORD_PROVIDER="mock", RECORD_ALLOW_FIXTURE="1", NINE_ROUTER_ENABLED="false", WORKER_POLL_MS="50")
    env.pop("GEMINI_API_KEY", None)
    for app, entry in [("api", "server"), ("worker", "runner")]:
        processes.append(subprocess.Popen(["node", "--import", "tsx", f"dist/{entry}.js"], cwd=root / "apps" / app,
                                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
    operator, public = session(), session()
    deadline = time.monotonic() + 90
    while True:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError("built agency process exited during startup")
        try:
            if request(public, "/api/auth/me")[0] == 401:
                break
        except (urllib.error.URLError, TimeoutError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("agency API startup timed out")
        time.sleep(0.1)
    marker = uuid.uuid4().hex
    ok(operator, "/api/auth/signup", {"email": f"agency-{marker}@fixture.test", "password": "disposable-fixture-password", "accountName": "TEST runtime agency"})
    for index in range(1, 4):
        client = ok(operator, "/api/record/clients", {"name": f"TEST runtime client {index}", "websiteUrl": "https://client.fixture.test/", "engagement": "FIXTURE"})["client"]
        path = f'/api/record/clients/{client["businessId"]}'
        for slot in range(1, 4):
            body = {"subject": client["name"], "predicate": f"TEST fact {slot}", "valueText": "TEST approved value", "valueType": "TEXT", "sourceUrl": "https://client.fixture.test/facts", "question": f"TEST question {slot}?"}
            req = urllib.request.Request(base + f"{path}/slots/{slot}", data=json.dumps(body).encode(), method="PUT", headers={"Content-Type": "application/json", "Origin": base})
            with operator.open(req, timeout=10) as response:
                item = json.load(response)["item"]
            ok(operator, f'{path}/items/{item["id"]}/approve', {})
        initial = completed(operator, path, ok(operator, path + "/runs", {})["run"]["id"])
        share = ok(operator, path + "/share", {})["share"]["publicId"]
        public_path = f"/api/public/records/{share}"
        assert all(f["latest"] is None for f in ok(public, public_path)["record"]["facts"]), "unreviewed evidence leaked"
        for check, decision in zip(initial["checks"], ("MATCHES", "CONTRADICTS", "UNKNOWN")):
            assert check["observation"]["synthetic"], "fixture classification lost"
            ok(operator, path + "/judgments", {"observationId": check["observation"]["id"], "decision": decision, "note": "TEST internal review"})
        first_page = ok(public, public_path)["record"]
        assert first_page["fixture"] and len(first_page["facts"]) == 3
        assert all(f["latest"]["answer"] for f in first_page["facts"]), "raw answer missing"
        assert "TEST internal review" not in json.dumps(first_page), "private review note leaked"
        ok(operator, path + "/actions", {"slot": None, "note": "TEST agency updated the source", "links": []})
        follow_up = completed(operator, path, ok(operator, path + "/runs", {"kind": "FOLLOW_UP"})["run"]["id"])
        for check in follow_up["checks"]:
            ok(operator, path + "/judgments", {"observationId": check["observation"]["id"], "decision": "MATCHES"})
        page = ok(public, public_path)["record"]
        assert all(f["comparison"]["outcome"] == "INDETERMINATE" for f in page["facts"]), "synthetic fixture claimed a correction"
        assert "does not prove" in page["disclosure"], "causality disclosure missing"
        assert ok(operator, path + "/share", {})["share"]["publicId"] == share, "share URL changed"
        assert request(public, path)[0] == 401, "public reader reached operator data"
        ok(operator, path + "/share/revoke", {})
        assert request(public, public_path)[0] == 404, "revoked record remained accessible"
    print("agency runtime smoke passed: built API/worker, authenticated agency, 3 clients, 9 approved facts, initial and follow-up checks, TEST reviews, raw evidence, honest indeterminate outcomes, stable shares and revocation")
except Exception as error:
    print(f"agency runtime smoke failed: {error if isinstance(error, (AssertionError, RuntimeError)) else type(error).__name__}")
    raise SystemExit(1)
finally:
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
