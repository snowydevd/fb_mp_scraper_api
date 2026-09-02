#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.MARKETPLACE_API_URL ?? "http://localhost:4000";
const REQUEST_TIMEOUT_MS = 120_000;

// Shape of the scraper API's responses
interface Listing {
  id: string | null;
  title: string | null;
  price: number | null;
  priceRaw: string | null;
  currency: string | null;
  oldPrice: number | null;
  oldPriceRaw: string | null;
  location: string | null;
  thumbnail: string | null;
  url: string;
}
interface SearchOk {
  count: number;
  items: Listing[];
}
interface ApiError {
  error: { code: string; message: string };
}

const listingSchema = z.object({
  id: z.string().nullable(),
  title: z.string().nullable(),
  price: z.number().nullable(),
  priceRaw: z.string().nullable(),
  currency: z.string().nullable(),
  oldPrice: z.number().nullable(),
  oldPriceRaw: z.string().nullable(),
  location: z.string().nullable(),
  thumbnail: z.string().nullable(),
  url: z.string(),
});

const server = new McpServer({
  name: "fb-marketplace",
  version: "1.0.0",
});

server.registerTool(
  "search_marketplace",
  {
    title: "Search Facebook Marketplace",
    description:
      "Search Facebook Marketplace listings by text query, with optional " +
      "location and price bounds. Returns listings with title, price, " +
      "thumbnail and canonical URL. Prices are integers in the currency " +
      "shown in priceRaw (0 means the item is free).",
    inputSchema: {
      query: z.string().min(1).describe("Search text, e.g. 'bicicleta rodado 29'"),
      location: z
        .string()
        .min(1)
        .optional()
        .describe("Marketplace location slug (default: montevideo)"),
      minPrice: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Only listings priced at or above this value"),
      maxPrice: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Only listings priced at or below this value"),
    },
    outputSchema: {
      count: z.number().int(),
      items: z.array(listingSchema),
    },
  },
  async ({ query, location, minPrice, maxPrice }) => {
    if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
      return toolError("BAD_REQUEST", "minPrice cannot be greater than maxPrice");
    }

    const params = new URLSearchParams({ query });
    if (location != null) params.set("location", location);
    if (minPrice != null) params.set("minPrice", String(minPrice));
    if (maxPrice != null) params.set("maxPrice", String(maxPrice));

    const body = await apiGet<SearchOk>("/api/marketplace", params);
    if (isToolError(body)) return body;
    return ok({ count: body.count, items: body.items });
  }
);

function toolError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

/**
 * One GET against the API, with the same error taxonomy for every tool. The
 * API's own `{error:{code,message}}` envelope is passed through unchanged so a
 * caller sees LOGIN_REQUIRED or NO_DATABASE rather than a bare HTTP number.
 */
async function apiGet<T>(path: string, params: URLSearchParams): Promise<T | ReturnType<typeof toolError>> {
  const qs = params.toString();
  const url = `${API_URL}${path}${qs ? `?${qs}` : ""}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return toolError("API_UNREACHABLE", `Could not reach the scraper API at ${API_URL}: ${reason}. Is it running?`);
  }

  let body: T | ApiError;
  try {
    body = (await response.json()) as T | ApiError;
  } catch {
    return toolError("BAD_API_RESPONSE", `Scraper API returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok || (body != null && typeof body === "object" && "error" in body)) {
    const apiError = body != null && typeof body === "object" && "error" in body
      ? (body as ApiError).error
      : { code: `HTTP_${response.status}`, message: "" };
    return toolError(apiError.code, apiError.message || `Scraper API returned HTTP ${response.status}.`);
  }
  return body as T;
}

const isToolError = (v: unknown): v is ReturnType<typeof toolError> =>
  typeof v === "object" && v !== null && "isError" in v;

const ok = <T extends object>(structuredContent: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
  structuredContent,
});

// ---------------------------------------------------------------------------
// The pipeline's actual output. search_marketplace above is the old keyword
// path (it returns whatever text matches - toys included); these two serve the
// scored ranking and the contact queue that the worker produces.
// ---------------------------------------------------------------------------

const opportunitySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  price: z.union([z.string(), z.number()]).nullable(),
  currency_resolved: z.string().nullable(),
  city: z.string().nullable(),
  url: z.string(),
  listed_at: z.string().nullable(),
  mileage_km: z.number().nullable(),
  vehicle_year: z.number().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  score: z.union([z.string(), z.number()]),
  version: z.string(),
  breakdown: z.unknown(),
  is_dealer: z.boolean().nullable(),
  contact_status: z.string().nullable(),
}).passthrough();

server.registerTool(
  "list_opportunities",
  {
    title: "List scored buying opportunities",
    description:
      "The ranked opportunities the worker has scored, best first. Reads the " +
      "database - it never scrapes Facebook, so it is free to call. Ranking is " +
      "driven mainly by mileage and declared debt; price does NOT score, since " +
      "the search already bounds it and a human judges it. Every row carries " +
      "the full `breakdown`, so a ranking can always be explained subscore by " +
      "subscore. Dealerships are excluded by default: they price at retail and " +
      "there is no margin to negotiate.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional().describe("Max rows (default 50)"),
      minScore: z.number().optional().describe("Only listings scoring at or above this (-1 to 1)"),
      includeDealers: z.boolean().optional().describe("Include listings identified as dealerships (default false; for auditing the filter)"),
    },
    outputSchema: { count: z.number().int(), items: z.array(opportunitySchema) },
  },
  async ({ limit, minScore, includeDealers }) => {
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (minScore != null) params.set("minScore", String(minScore));
    if (includeDealers) params.set("includeDealers", "1");
    const body = await apiGet<{ count: number; items: unknown[] }>("/api/opportunities", params);
    if (isToolError(body)) return body;
    return ok({ count: body.count, items: body.items as z.infer<typeof opportunitySchema>[] });
  }
);

const contactEntrySchema = z.object({
  id: z.number(),
  listing_id: z.string(),
  facts: z.unknown(),
  message_draft: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  url: z.string(),
}).passthrough();

server.registerTool(
  "list_contact_queue",
  {
    title: "List contact drafts awaiting review",
    description:
      "Message drafts for listings that cleared the threshold, each with the " +
      "facts needed to judge it: mileage (absolute and per year), declared " +
      "debt, days listed and price drops. There is deliberately NO suggested " +
      "amount - the price is a human decision. NOTHING here has been sent " +
      "either: automated Messenger outreach is the fastest way to lose the " +
      "account, so every entry waits for a person to approve and send it by " +
      "hand. Read-only by design; approving or discarding goes through " +
      "PATCH /api/contact-queue/:id.",
    inputSchema: {
      status: z.enum(["pending", "approved", "discarded", "sent", "all"]).optional()
        .describe("Which drafts to list (default: pending)"),
      limit: z.number().int().positive().max(200).optional().describe("Max rows (default 50)"),
    },
    outputSchema: { count: z.number().int(), items: z.array(contactEntrySchema) },
  },
  async ({ status, limit }) => {
    const params = new URLSearchParams();
    if (status != null) params.set("status", status);
    if (limit != null) params.set("limit", String(limit));
    const body = await apiGet<{ count: number; items: unknown[] }>("/api/contact-queue", params);
    if (isToolError(body)) return body;
    return ok({ count: body.count, items: body.items as z.infer<typeof contactEntrySchema>[] });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`fb-marketplace MCP server running on stdio (API: ${API_URL})`);
