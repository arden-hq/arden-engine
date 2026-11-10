"""Host variables a profile's benchmark-owned MCP servers read."""


def mcp_environment(config, get):
    """Map each host variable name the profile's mcpServers read to its value; raise if one is unset."""
    values = {}
    for server in config.get("mcpServers", []):
        for source in server["environment"].values():
            value = get(source)
            if not value:
                raise ValueError(f"Missing {source} for MCP server {server['name']}")
            values[source] = value
    return values
