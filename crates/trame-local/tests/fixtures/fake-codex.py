#!/usr/bin/env python3
# DESCRIPTION
# Stands in for `codex app-server` (JSON-RPC on stdio) in the agent supervisor tests. Prompts pick a
# behaviour: "run" asks to approve a command, "edit" a file change, "ask" asks a question, "hang"
# waits for turn/interrupt; anything else is echoed. Every method received is logged.
# USAGE
# FAKE_LOG=calls.log fake-codex.py app-server
import json
import os
import sys
import uuid

LOG = os.environ["FAKE_LOG"]
thread = None
turn = None
turns = 0
waiting = {}  # our request id -> what to do with the answer


def log(entry):
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def note(method, params):
    out({"method": method, "params": params, "emittedAtMs": 0})


def item(kind, **fields):
    return {"type": kind, "id": str(uuid.uuid4()), **fields}


def finish(status="completed"):
    global turn
    note("turn/completed", {"threadId": thread, "turn": {"id": turn, "status": status, "items": []}})
    turn = None


def say(text):
    note("item/agentMessage/delta", {"threadId": thread, "turnId": turn, "itemId": "m", "delta": text[:4]})
    note("item/completed", {"threadId": thread, "turnId": turn, "item": item("agentMessage", text=text)})
    finish()


def ask(method, params, then):
    rid = f"srv-{len(waiting)}-{turns}"
    waiting[rid] = then
    out({"id": rid, "method": method, "params": {"threadId": thread, "turnId": turn, **params}})


def ran(result):
    if result.get("decision") == "accept":
        note("item/completed", {"threadId": thread, "turnId": turn, "item": item(
            "commandExecution", command="npm test", aggregatedOutput="PASS 14 tests", exitCode=0, status="completed")})
        return say("ran tests")
    say("declined " + str(result.get("decision")))


CHANGE = item("fileChange", status="inProgress", changes=[
    {"path": "src/a.ts", "kind": {"type": "update"}, "diff": "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n"}])


def edited(result):
    if result.get("decision") == "accept":
        done = {**CHANGE, "status": "completed"}
        note("item/completed", {"threadId": thread, "turnId": turn, "item": done})
        return say("edited")
    say("declined " + str(result.get("decision")))


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method:
        log({"method": method, "params": msg.get("params")})
    if method is None:
        then = waiting.pop(msg["id"], None)
        if then:
            then(msg.get("result") or {})
        continue
    rid = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        out({"id": rid, "result": {"userAgent": "fake", "codexHome": "/tmp", "platformFamily": "unix", "platformOs": "linux"}})
    elif method in ("thread/start", "thread/resume"):
        thread = params.get("threadId") or str(uuid.uuid4())
        out({"id": rid, "result": {"thread": {"id": thread}, "model": "gpt-fake", "reasoningEffort": "low", "cwd": params.get("cwd")}})
        note("thread/started", {"thread": {"id": thread}})
    elif method == "model/list":
        out({"id": rid, "result": {"data": [
            {"model": "gpt-fake", "displayName": "GPT Fake", "description": "default", "hidden": False,
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}]},
            {"model": "gpt-hidden", "displayName": "Hidden", "description": "", "hidden": True, "supportedReasoningEfforts": []}]}})
    elif method == "turn/start":
        turns += 1
        turn = f"turn-{turns}"
        out({"id": rid, "result": {"turn": {"id": turn, "status": "inProgress", "items": []}}})
        note("turn/started", {"threadId": thread, "turn": {"id": turn}})
        text = params["input"][0]["text"]
        if text == "run":
            ask("item/commandExecution/requestApproval", {"itemId": "c1", "command": "npm test", "cwd": "/w", "kind": "command"}, ran)
        elif text == "edit":
            note("item/started", {"threadId": thread, "turnId": turn, "item": CHANGE})
            ask("item/fileChange/requestApproval", {"itemId": CHANGE["id"]}, edited)
        elif text == "ask":
            questions = [{"id": "q1", "header": "DB", "question": "Which db?", "isOther": True, "isSecret": False,
                          "options": [{"label": "pg", "description": "Postgres"}]}]
            ask("item/tool/requestUserInput", {"itemId": "u1", "questions": questions, "isBlocking": True},
                lambda r: say("answered " + json.dumps(r.get("answers"), sort_keys=True)))
        elif text == "hang":
            pass
        else:
            say("echo: " + text)
    elif method == "turn/interrupt":
        out({"id": rid, "result": {}})
        finish("interrupted")
    elif rid is not None:
        out({"id": rid, "error": {"code": -32601, "message": "not in the fake"}})
