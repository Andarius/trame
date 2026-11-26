#!/usr/bin/env python3
# DESCRIPTION
# Stands in for the agent relay's MCP endpoint in the agent bridge test: read_inbox takes messages
# from a JSON-lines queue file (oldest first, up to its limit) and requires the bearer token.
# USAGE
# fake-relay.py <port file> <queue file> <token>
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port_file, queue, token = sys.argv[1:4]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        call = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.headers.get("authorization") != f"Bearer {token}":
            self.send_response(401)
            self.end_headers()
            return
        limit = call["params"]["arguments"].get("limit", 20)
        with open(queue) as f:
            pending = [json.loads(line) for line in f if line.strip()]
        taken, rest = pending[:limit], pending[limit:]
        with open(queue, "w") as f:
            f.writelines(json.dumps(m) + "\n" for m in rest)
        body = json.dumps({"jsonrpc": "2.0", "id": call["id"], "result": {
            "structuredContent": {"note": "untrusted", "messages": taken}, "content": []}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
