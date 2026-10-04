#!/usr/bin/env python3
"""Boot built hosted apps and exercise auth → queue → Effect → PG → API.
Only run against an explicitly allowed disposable loopback database.
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
url = urllib.parse.urlsplit(os.environ.get("DATABASE_URL", ""))
if os.environ.get("HOSTED_SMOKE_ALLOWED") != "1" or url.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit("refusing: require HOSTED_SMOKE_ALLOWED=1 and a disposable loopback database")
port = int(os.environ.get("HOSTED_SMOKE_PORT", "3017"))
base = f"http://127.0.0.1:{port}"
processes = []

def request(client, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json", "Origin": base})
    try:
        with client.open(req, timeout=5) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, None

def session():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

try:
    env = dict(os.environ, PORT=str(port), APP_BASE_URL=base, NINE_ROUTER_ENABLED="false", WORKER_POLL_MS="50")
    for app, entry in [("api", "server"), ("worker", "runner")]:
        processes.append(subprocess.Popen(["node", "--import", "tsx", f"dist/{entry}.js"], cwd=root / "apps" / app,
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
    client = session()
    deadline = time.monotonic() + 90
    while True:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError("built hosted process exited during startup")
        try:
            status, _ = request(client, "/api/auth/me")
            if status == 401:
                break
        except (urllib.error.URLError, TimeoutError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("API startup timed out")
        time.sleep(0.1)
    marker = uuid.uuid4().hex
    status, _ = request(client, "/api/auth/signup", {"email": f"runtime-{marker}@fixture.test", "password": "disposable-fixture-password", "accountName": "Runtime fixture"})
    assert status in (200, 201), "signup failed"
    # Signup does not implicitly authenticate. Authenticate through the real cookie path.
    status, _ = request(client, "/api/auth/signin", {"email": f"runtime-{marker}@fixture.test", "password": "disposable-fixture-password"})
    assert status == 200, "signin failed"
    status, business = request(client, "/api/businesses", {"name": "Runtime smoke fixture"})
    assert status in (200, 201), "business creation failed"
    business_id = business["business"]["id"]
    status, question = request(client, f"/api/businesses/{business_id}/questions", {"prompt": "__wrong__", "origin": "OPERATOR_CONSTRUCTED"})
    assert status in (200, 201), "question creation failed"
    status, check = request(client, f"/api/businesses/{business_id}/check-runs", {"questionId": question["question"]["id"], "provider": "mock"})
    assert status in (200, 201, 202), "enqueue failed"
    run_id = check["checkRun"]["id"]
    deadline = time.monotonic() + 90
    while True:
        status, data = request(client, f"/api/businesses/{business_id}/check-runs")
        assert status == 200, "check read failed"
        run = next((r for r in data["checkRuns"] if r["id"] == run_id), None)
        if run and run["status"] in ("SUCCEEDED", "FAILED"):
            break
        if time.monotonic() > deadline:
            raise RuntimeError("Effect check completion timed out")
        time.sleep(0.1)
    assert run["status"] == "SUCCEEDED" and run["attemptCount"] == 1, "check did not succeed in one attempt"
    status, observation = request(client, f"/api/observations/{run['observationId']}")
    assert status == 200, "observation read failed"
    assert observation["observation"]["answer_text"] == "Northstar costs $29/month.", "wrong persisted answer"
    assert observation["observation"]["synthetic"] is True, "synthetic classification lost"
    assert observation["citations"] == [], "mock citations were fabricated"
    status, data = request(client, f"/api/businesses/{business_id}/overview")
    assert status == 200, "overview read failed"
    other = session()
    status, _ = request(other, "/api/auth/signup", {"email": f"other-{marker}@fixture.test", "password": "disposable-fixture-password"})
    assert status in (200, 201), "second account fixture failed"
    status, _ = request(other, "/api/auth/signin", {"email": f"other-{marker}@fixture.test", "password": "disposable-fixture-password"})
    assert status == 200, "second account signin failed"
    status, _ = request(other, f"/api/businesses/{business_id}/check-runs")
    assert status in (403, 404), "cross-account read was not denied"
    print("hosted runtime smoke passed: built startup, cookie auth, Effect queue execution, API reads, tenant denial")
except Exception as err:
    # No URLs, request bodies, cookies, credentials, or provider data in failure output.
    if isinstance(err, (AssertionError, RuntimeError)):
        print(f"hosted runtime smoke failed: {err}")
    else:
        print(f"hosted runtime smoke failed: {type(err).__name__}")
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
