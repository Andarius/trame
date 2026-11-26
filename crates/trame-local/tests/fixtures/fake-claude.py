#!/usr/bin/env python3
# DESCRIPTION
# Stands in for `claude -p --input-format stream-json ...` in the agent supervisor tests.
# Prompts pick a behaviour: "write" asks for a tool, "garbage" prints a malformed line,
# "hang" waits for an interrupt, "crash" exits with an error; anything else is echoed.
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


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def ok(request_id, response=None):
    out({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response or {}}})


def reply(text):
    out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text[:4]}}})
    out({"type": "assistant", "session_id": session, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
    out({"type": "result", "subtype": "success", "is_error": False, "session_id": session, "total_cost_usd": 0.001})


for line in sys.stdin:
    msg = json.loads(line)
    if msg["type"] == "control_request":
        kind = msg["request"]["subtype"]
        ok(msg["request_id"], {"commands": []} if kind == "initialize" else None)
        if kind == "interrupt":
            out({"type": "result", "subtype": "error_during_execution", "is_error": True, "session_id": session})
        continue
    if msg["type"] == "control_response":
        reply("tool " + msg["response"]["response"].get("behavior", "?"))
        continue
    text = msg["message"]["content"][0]["text"]
    out({"type": "system", "subtype": "init", "session_id": session, "model": "fake-model", "permissionMode": "default"})
    if text == "write":
        out({"type": "control_request", "request_id": "perm-1", "request": {
            "subtype": "can_use_tool", "tool_name": "Write", "input": {"file_path": "x.txt"}, "tool_use_id": "tu-1"}})
    elif text == "hang":
        pass
    elif text == "crash":
        sys.stderr.write("boom: model unavailable\n")
        sys.exit(3)
    else:
        if text == "garbage":
            sys.stdout.write("this is not json\n")
        reply("echo: " + text)
