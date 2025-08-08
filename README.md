# Takaro AI module writer

This repo contains configs to help you leverage AI tools like Claude to write Takaro modules.

## Prerequisites

### Windows Users
Windows users need to set up WSL2 first:
1. [Install WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) with Ubuntu
2. [Install Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) and enable WSL2 integration in Docker Desktop settings
3. **Important**: Install Claude Code inside WSL (not Windows) - open Ubuntu terminal and follow [Claude Code installation](https://docs.anthropic.com/en/docs/claude-code/quickstart)

**Note**: When Docker Desktop uses WSL2 backend, containers are accessible from WSL at `localhost`. If you have connection issues, try using `host.docker.internal` instead of `localhost`.

### Mac/Linux Users
- [Mac](https://docs.docker.com/desktop/setup/install/mac-install/): Install Docker Desktop
- [Linux](https://docs.docker.com/engine/install/): Install Docker Engine

## Setup

```bash
# Clone this repository
git clone https://github.com/gettakaro/ai-module-writer.git
cd ai-module-writer

# Copy the .env.example to .env and fill in your API keys
cp .env.example .env

# Start the MCP server
docker compose up -d

# Add the MCP server to Claude (run this once)
# For most users:
claude mcp add --transport http takaro http://localhost:18000

# If you have connection issues on Windows/WSL2, try:
# claude mcp add --transport http takaro http://host.docker.internal:18000

# Start Claude
claude

# Verify the MCP server is connected (you should see 'takaro' in the list)
> /mcp

# Now you can start creating modules!
> Write me a module that says 'hello' to every player when they join
```

## How it Works

The Docker container runs the Takaro MCP server on port 18000. Claude Code connects to it via HTTP, allowing you to create and manage Takaro modules directly through Claude.

This repository includes:
- **CLAUDE.md**: Instructions for Claude on how to write Takaro modules
- **Custom commands**: Use `/test-module` in Claude to test and debug your modules
- **Docker setup**: Pre-configured MCP server for module development