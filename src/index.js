#!/usr/bin/env node
// Glongus MCP server over stdio (npm package and Claude Desktop bundle). The
// tools live in tools.js, shared with the remote endpoint at
// https://api.glongus.com/mcp; this entry point signs in with the owner API key
// from GLONGUS_API_KEY.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGlongusServer, createKeySession, VERSION } from './tools.js';

const apiUrl = (process.env.GLONGUS_API_URL ?? 'https://api.glongus.com').replace(/\/+$/, '');
const session = createKeySession({ apiUrl, apiKey: process.env.GLONGUS_API_KEY });

const BUNDLE_URL = 'https://github.com/glongusmain/glongus-mcp/releases/latest/download/glongus.mcpb';
const REMOTE_URL = 'https://api.glongus.com/mcp';

// a > b for plain x.y.z versions.
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

// How this copy was installed decides how the owner updates it. The Claude
// Desktop bundle sets GLONGUS_INSTALL=mcpb in its manifest; npx runs from its
// _npx cache.
function updateSteps() {
  if (process.env.GLONGUS_INSTALL === 'mcpb') {
    return `In Claude Desktop, download ${BUNDLE_URL} and open it to install the update.`;
  }
  if (/[\\/]_npx[\\/]/.test(process.argv[1] ?? '')) {
    return 'Restart the app that runs it; if it still starts the old version, change the command to `npx -y glongus-mcp@latest`.';
  }
  return 'Update the glongus-mcp package (npm install glongus-mcp@latest) and restart the app that runs it.';
}

// One look at npm per start. Any failure just means no notice. Set
// GLONGUS_NO_UPDATE_CHECK=1 to turn it off.
async function checkForUpdate() {
  if (process.env.GLONGUS_NO_UPDATE_CHECK) return null;
  const res = await fetch('https://registry.npmjs.org/glongus-mcp/latest', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const { version: latest } = await res.json();
  if (typeof latest !== 'string' || !isNewer(latest, VERSION)) return null;
  const how = updateSteps();
  return {
    current: VERSION,
    latest,
    how,
    message:
      `Glongus update: version ${latest} of this MCP server is out (this is ${VERSION}). Mention it to your owner once, ` +
      `not every turn. ${how} Or skip installs: add ${REMOTE_URL} as a connector in Claude or ChatGPT, which is always up to date.`,
  };
}

await createGlongusServer({ apiUrl, session, updateCheck: checkForUpdate().catch(() => null) }).connect(
  new StdioServerTransport()
);
