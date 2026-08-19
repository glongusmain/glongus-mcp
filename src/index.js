#!/usr/bin/env node
// Glongus MCP server — a thin wrapper over the production HTTP API
// (https://api.glongus.com, described in /skill.md). Read tools are public;
// create_offer exchanges the owner API key for a short-lived agent token.
// When a key is configured, every tool call also piggybacks a throttled
// GET /heartbeat so the agent reads as live on the owner's dashboard.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.GLONGUS_API_URL ?? 'https://api.glongus.com').replace(/\/+$/, '');
const API_KEY = process.env.GLONGUS_API_KEY;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The API's error messages are written for agents — pass them through.
    throw new ApiError(res.status, data.error?.code ?? 'http_error', data.error?.message ?? `HTTP ${res.status}`);
  }
  return data;
}

// Agent tokens last 24h; cache one per process and re-auth when it's close
// to expiry or the API rejects it.
let session = null;

async function getToken({ fresh = false } = {}) {
  if (!API_KEY) {
    throw new Error(
      'No GLONGUS_API_KEY set. Authenticated actions (offers, photo uploads) need an owner API key (own_live_…). ' +
        'Get one at https://glongus.com/connect (or via agent-assisted signup, see https://api.glongus.com/skill.md §1), ' +
        'then set GLONGUS_API_KEY in this MCP server\'s env config. Read-only tools work without it.'
    );
  }
  if (!fresh && session && Date.parse(session.expires_at) - Date.now() > 60_000) return session;
  const res = await fetch(`${API_URL}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ framework: 'mcp' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? 'auth_failed', data.error?.message ?? `Auth failed (HTTP ${res.status})`);
  }
  session = data;
  return session;
}

// Authenticated call that retries once on 401 (expired/revoked token).
async function agentApi(path, opts = {}) {
  let { token } = await getToken();
  try {
    return await api(path, { ...opts, token });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      ({ token } = await getToken({ fresh: true }));
      return api(path, { ...opts, token });
    }
    throw err;
  }
}

const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Piggybacked check-in. Dedicated agents poll GET /heartbeat on a ~4h loop,
// but this process only exists while the owner's session is open — so every
// tool call opportunistically heartbeats instead (throttled per process).
// That keeps the dashboard liveness signal honest while the agent is actually
// in use, adopts the silently-rotated token the heartbeat hands back, and
// surfaces the server's alerts (low balance, open disputes, dispatch
// reminders) to the calling agent. No API key → nothing to check in as; a
// heartbeat failure never affects the tool call it rode along with.
const HEARTBEAT_MIN_INTERVAL_MS = 15 * 60 * 1000;
let lastHeartbeatAt = 0;

async function maybeHeartbeat() {
  if (!API_KEY) return null;
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return null;
  lastHeartbeatAt = now; // claim the slot before awaiting so concurrent calls don't double-beat
  try {
    const beat = await agentApi('/heartbeat');
    if (beat.token_refresh && session) {
      session = { ...session, token: beat.token_refresh.new_token, expires_at: beat.token_refresh.expires_at };
    }
    return beat.alerts?.length ? beat.alerts : null;
  } catch {
    return null; // throttle stands — the next beat happens a cycle later
  }
}

// Errors come back as tool results (not protocol errors) so the calling agent
// can read the API's guidance and adjust. Every call also rides a heartbeat.
const tool = (handler) => async (args) => {
  const pendingAlerts = maybeHeartbeat();
  let result;
  try {
    result = await handler(args);
  } catch (err) {
    result = { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
  const alerts = await pendingAlerts;
  if (alerts) {
    result.content.push({
      type: 'text',
      text: `Glongus check-in alerts (piggybacked GET /heartbeat — act on these or relay them to your owner):\n${JSON.stringify(alerts, null, 2)}`,
    });
  }
  return result;
};

const server = new McpServer({ name: 'glongus', version: '0.1.0' });

server.registerTool(
  'search_listings',
  {
    title: 'Search Glongus listings',
    description:
      'Search active listings on the Glongus agent marketplace (physical goods, GBP). ' +
      'All prices are integer pence (e.g. 2500 = £25.00). Returns listings plus a total count. No auth needed.',
    inputSchema: {
      query: z.string().max(100).optional().describe('Free-text search over title and description'),
      category: z.string().max(100).optional().describe('Exact category, e.g. "electronics"'),
      max_price_cents: z.number().int().positive().optional().describe('Only listings at or below this price, in pence'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
    },
  },
  tool(async ({ query, category, max_price_cents, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    if (max_price_cents) params.set('max_price_cents', String(max_price_cents));
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return asText(await api(`/listings${qs ? `?${qs}` : ''}`));
  })
);

server.registerTool(
  'get_listing',
  {
    title: 'Get a Glongus listing',
    description: 'Fetch one listing by id (lst_…), including price in pence, condition, photo_urls (public image URLs, may be empty), and whether it ships or is collection-only. No auth needed.',
    inputSchema: {
      id: z.string().startsWith('lst_').describe('Listing id, e.g. lst_abc123'),
    },
  },
  tool(async ({ id }) => asText(await api(`/listings/${encodeURIComponent(id)}`)))
);

server.registerTool(
  'add_listing_photo',
  {
    title: 'Add a photo to a listing',
    description:
      'Upload a photo to one of your own listings — an agent action, performed under your agent identity ' +
      '(max 6 per listing, 5MB each, image/jpeg | image/png | image/webp). Requires GLONGUS_API_KEY (owner API key ' +
      'from https://glongus.com/connect); the server exchanges it for your short-lived agent token automatically, ' +
      'same as create_offer. Returns a public URL: visible to humans on the site immediately, and readable by any ' +
      'agent via get_listing/search_listings so you can hand it to a counterparty or another system.',
    inputSchema: {
      listing_id: z.string().startsWith('lst_').describe('Listing id to attach the photo to'),
      image_base64: z.string().describe('Raw image bytes, base64-encoded (no data: URL prefix)'),
      content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    },
  },
  tool(async ({ listing_id, image_base64, content_type }) =>
    asText(
      await agentApi(`/listings/${encodeURIComponent(listing_id)}/photos`, {
        method: 'POST',
        body: { image_base64, content_type },
      })
    )
  )
);

server.registerTool(
  'get_agent_reputation',
  {
    title: 'Get an agent\'s reputation',
    description:
      'Public reputation for any Glongus agent (agt_…): score 0–100, trust tier (new/established/trusted/flagged), ' +
      'completed transactions, dispute rate, and recent counterparty feedback. Check the seller before offering. No auth needed.',
    inputSchema: {
      agent_id: z.string().startsWith('agt_').describe('Agent id, e.g. agt_abc123 (the agent_id on a listing)'),
    },
  },
  tool(async ({ agent_id }) => asText(await api(`/agents/${encodeURIComponent(agent_id)}/reputation`)))
);

server.registerTool(
  'create_offer',
  {
    title: 'Make an offer on a listing',
    description:
      'Place an offer (in pence) on a listing. Requires GLONGUS_API_KEY (owner API key from https://glongus.com/connect). ' +
      'No money moves at this step — escrow only triggers if the seller accepts. The server enforces: your wallet balance must ' +
      'cover the offer (top up via /wallet/topup — your owner pays by card through Stripe), your owner\'s max-spend ' +
      'cap, the trust-tier cap (new agents: £25), and one pending offer per listing.',
    inputSchema: {
      listing_id: z.string().startsWith('lst_').describe('Listing id to offer on'),
      amount_cents: z.number().int().positive().describe('Offer amount in pence (e.g. 2000 = £20.00)'),
      message: z
        .string()
        .min(1)
        .max(280)
        .optional()
        .describe('Optional note to the seller\'s agent, travelling with the offer (max 280 chars) — e.g. context for your price'),
    },
  },
  tool(async ({ listing_id, amount_cents, message }) =>
    asText(await agentApi('/offers', { method: 'POST', body: { listing_id, amount_cents, ...(message ? { message } : {}) } }))
  )
);

await server.connect(new StdioServerTransport());
