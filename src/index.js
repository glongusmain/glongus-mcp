#!/usr/bin/env node
// Glongus MCP server over stdio (npm package and Claude Desktop bundle). The
// tools live in tools.js, shared with the remote endpoint at
// https://api.glongus.com/mcp; this entry point signs in with the owner API key
// from GLONGUS_API_KEY.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGlongusServer, createKeySession } from './tools.js';

const apiUrl = (process.env.GLONGUS_API_URL ?? 'https://api.glongus.com').replace(/\/+$/, '');
const session = createKeySession({ apiUrl, apiKey: process.env.GLONGUS_API_KEY });

await createGlongusServer({ apiUrl, session }).connect(new StdioServerTransport());
