"""The host variables a trial forwards: only those its profile names."""


def profile_environment(config, get):
    """Map each host variable the profile names to its value; raise if one is unset.

    The provider's key (`apiKeyEnv`, absent for a local Chat Completions server
    such as llama.cpp, which has no key), a Codex account id (`accountIdEnv`),
    and the variables its benchmark-owned MCP servers read. Every path a trial
    takes (a bare `single`, a `run` container, Harbor) forwards this set and
    nothing else.
    """
    named = [
        (config[field], field)
        for field in ("apiKeyEnv", "accountIdEnv")
        if config.get(field)
    ] + [
        (source, f"MCP server {server['name']}")
        for server in config.get("mcpServers", [])
        for source in server["environment"].values()
    ]
    values = {}
    for source, reader in named:
        value = get(source)
        if not value:
            raise ValueError(f"Missing {source} for {reader}")
        values[source] = value
    return values
