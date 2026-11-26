#!/usr/bin/env python3
# DESCRIPTION
# Serves an authenticated MCP inbox and records successful sends in the adjacent sent log.
# USAGE
# fake-relay.py <port file> <queue file> <token>
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

port_file, queue_path, token = sys.argv[1:4]
queue = Path(queue_path)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        call = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.headers.get("authorization") != f"Bearer {token}":
            self.send_response(401)
            self.end_headers()
            return
        params = call["params"]
        if params["name"] == "send_message":
            result = self.send_message(params["arguments"])
        else:
            result = self.read_inbox(params["arguments"].get("limit", 20))
        body = json.dumps({"jsonrpc": "2.0", "id": call["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_inbox(self, limit):
        with queue.open() as f:
            pending = [json.loads(line) for line in f if line.strip()]
        taken, rest = pending[:limit], pending[limit:]
        with queue.open("w") as f:
            f.writelines(json.dumps(m) + "\n" for m in rest)
        return {"structuredContent": {"note": "untrusted", "messages": taken}, "content": []}

    def send_message(self, args):
        if args["to"] == "carol":
            return {
                "isError": True,
                "content": [{"type": "text", "text": "carol refused the message: 403 private error body"}],
            }
        with queue.with_suffix(".sent.jsonl").open("a") as f:
            f.write(json.dumps(args) + "\n")
        return {
            "structuredContent": {"id": "9ac1307d-d127-4331-b2d9-20d6cdbdd803", "status": "delivered"},
            "content": [],
        }


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
