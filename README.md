# Takaro AI module writer

This repo contains configs to help you leverage AI tools like Claude to write Takaro modules.

Make sure Docker is installed and running first!
[Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
[Mac](https://docs.docker.com/desktop/setup/install/mac-install/)
[Linux](https://docs.docker.com/engine/install/)

```
# Copy the .env.example to .env and fill in your API keys
cp .env.example .env
# Start the MCP server
docker compose up -d
# Start claude
claude

> Write me a module that says 'hello' to every player when they join
```