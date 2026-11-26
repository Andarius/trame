#!/usr/bin/env python3
# DESCRIPTION
# Stands in for `claude -p --input-format stream-json ...` in the agent supervisor tests.
# Prompts pick a behaviour: "write", "ask" and "plan" block on a decision, "cancelme" asks then
# withdraws, "garbage" prints a malformed line, "hang" waits for an interrupt, "crash" exits with
# an error; anything else is echoed.
# USAGE
# FAKE_LOG=argv.log fake-claude.py <claude args>
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    leaked = sorted(k for k in os.environ if k.startswith(("CLAUDE", "ANTHROPIC_")))
    log.write(json.dumps({"args": args, "leaked": leaked}) + "\n")
flag = "--resume" if "--resume" in args else "--session-id"
session = args[args.index(flag) + 1]
pending = {}

QUESTION = {"questions": [{"question": "Which db?", "header": "DB", "multiSelect": False,
                           "options": [{"label": "pg", "description": "Postgres"}, {"label": "sqlite", "description": "file"}]}]}
ASKS = {
    "write": ("Write", {"file_path": "x.txt", "content": "hi"}),
    "ask": ("AskUserQuestion", QUESTION),
    "plan": ("ExitPlanMode", {"plan": "1. add a test\n2. fix it"}),
    "cancelme": ("Write", {"file_path": "y.txt", "content": "no"}),
}


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def ok(request_id, response=None):
    out({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response or {}}})


def reply(text):
    out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text[:4]}}})
    out({"type": "assistant", "session_id": session, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
    out({"type": "result", "subtype": "success", "is_error": False, "session_id": session, "total_cost_usd": 0.001})


def answered(tool, response):
    if response.get("behavior") != "allow":
        return reply(f"{tool} deny: {response.get('message', '')}")
    if tool == "AskUserQuestion":
        return reply("answered " + json.dumps(response["updatedInput"]["answers"], sort_keys=True))
    if tool == "ExitPlanMode":
        out({"type": "system", "subtype": "status", "permissionMode": "default"})
    reply(f"{tool} allow")


for line in sys.stdin:
    msg = json.loads(line)
    if msg["type"] == "control_request":
        kind = msg["request"]["subtype"]
        ok(msg["request_id"], {"commands": []} if kind == "initialize" else None)
        if kind == "interrupt":
            for request_id in list(pending):
                out({"type": "control_cancel_request", "request_id": request_id})
                pending.pop(request_id)
            out({"type": "result", "subtype": "error_during_execution", "is_error": True, "session_id": session})
        continue
    if msg["type"] == "control_response":
        response = msg["response"]
        tool = pending.pop(response["request_id"], "?")
        answered(tool, response.get("response", {}))
        continue
    text = msg["message"]["content"][0]["text"]
    out({"type": "system", "subtype": "init", "session_id": session, "model": "fake-model", "permissionMode": "default"})
    if text in ASKS:
        tool, tool_input = ASKS[text]
        request_id = f"perm-{len(pending)}-{text}"
        pending[request_id] = tool
        out({"type": "control_request", "request_id": request_id, "request": {
            "subtype": "can_use_tool", "tool_name": tool, "input": tool_input, "tool_use_id": "tu-" + text}})
        if text == "cancelme":
            out({"type": "control_cancel_request", "request_id": request_id})
            pending.pop(request_id)
            reply("withdrawn")
    elif text == "hang":
        pass
    elif text == "crash":
        sys.stderr.write("boom: model unavailable\n")
        sys.exit(3)
    else:
        if text == "garbage":
            sys.stdout.write("this is not json\n")
        reply("echo: " + text)
