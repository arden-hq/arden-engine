#!/usr/bin/env python3
"""Stdio MCP server exposing one AutomationBench task's `api` toolset over its world state."""

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from common import load_task


def write_atomic(path, text):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--state-out", required=True)
    args = parser.parse_args()
    env, state = load_task(args.upstream, args.domain, args.task_id)
    target = Path(args.state_out).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    calls = target.with_suffix(".calls.jsonl")
    count = 0

    def save():
        write_atomic(target, json.dumps(state["world"].model_dump(mode="json")))

    def log(name, arguments, ok):
        entry = {"n": count, "t": time.time(), "tool": name, "args": arguments, "ok": ok}
        with calls.open("a") as handle:
            handle.write(json.dumps(entry) + "\n")

    save()
    server = Server("automationbench")

    @server.list_tools()
    async def list_tools():
        return [
            types.Tool(name=tool.name, description=tool.description, inputSchema=tool.parameters)
            for tool in env.tool_defs
        ]

    # Input is passed to the upstream tool unvalidated, as the upstream environment does.
    @server.call_tool(validate_input=False)
    async def call_tool(name, arguments):
        nonlocal count
        count += 1
        arguments = arguments or {}
        try:
            injected = env.update_tool_args(name, dict(arguments), [], state)
            message = await env.call_tool(name, injected, str(count))
            content, ok = message.content, True
        except Exception as error:
            content, ok = env.error_formatter(error), False
        save()
        log(name, arguments, ok)
        if not isinstance(content, str):
            content = json.dumps(content)
        return [types.TextContent(type="text", text=content)]

    async def serve():
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    os.chdir(target.parent)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
