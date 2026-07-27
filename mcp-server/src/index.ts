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
    const url = `${API_URL}/api/marketplace?${params.toString()}`;

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return toolError(
        "API_UNREACHABLE",
        `Could not reach the scraper API at ${API_URL}: ${reason}. Is it running?`
      );
    }

    let body: SearchOk | ApiError;
    try {
      body = (await response.json()) as SearchOk | ApiError;
    } catch {
      return toolError(
        "BAD_API_RESPONSE",
        `Scraper API returned a non-JSON response (HTTP ${response.status}).`
      );
    }

    if (!response.ok || "error" in body) {
      const apiError = "error" in body ? body.error : { code: `HTTP_${response.status}`, message: "" };
      return toolError(apiError.code, apiError.message || `Scraper API returned HTTP ${response.status}.`);
    }

    const structuredContent = { count: body.count, items: body.items };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  }
);

function toolError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`fb-marketplace MCP server running on stdio (API: ${API_URL})`);
