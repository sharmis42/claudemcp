import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios from "axios";
import * as dotenv from "dotenv";
import { FigmaClient } from "./figma-client.js";

dotenv.config();

const token = process.env.FIGMA_ACCESS_TOKEN;
if (!token) {
  console.error("Error: FIGMA_ACCESS_TOKEN is not set. Copy .env.example to .env and add your token.");
  process.exit(1);
}

const figma = new FigmaClient(token);

function createServer(): McpServer {
  const server = new McpServer({ name: "figma-mcp", version: "1.0.0" });

  // ─── TOOL: get_file ────────────────────────────────────────────────────────
  server.registerTool(
    "get_file",
    {
      description: "Get a Figma file's name, pages, and top-level frames. Use this first to orient yourself in a file.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key — found in the URL: figma.com/file/{fileKey}/..."),
      },
    },
    async ({ fileKey }) => {
      const data = await figma.getFile(fileKey);
      const summary = {
        name: data.name,
        lastModified: data.lastModified,
        version: data.version,
        pages: data.document.children?.map((page: Record<string, unknown>) => ({
          id: page.id,
          name: page.name,
          children: (page.children as Record<string, unknown>[])?.slice(0, 30).map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
          })),
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ─── TOOL: get_node ──────────────────────────────────────────────────────
  server.registerTool(
    "get_node",
    {
      description: "Get detailed properties of a specific node: dimensions, colors, fonts, layout, children, etc.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
        nodeId: z.string().describe("Node ID (e.g. '1:23' or '1-23' from the URL)"),
      },
    },
    async ({ fileKey, nodeId }) => {
      const data = await figma.getNode(fileKey, nodeId);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── TOOL: search_nodes ──────────────────────────────────────────────────
  server.registerTool(
    "search_nodes",
    {
      description: "Search for nodes by name and/or type across the entire file. Useful for finding components, frames, or text layers.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
        query: z.string().describe("Name to search for (partial match, case-insensitive)"),
        nodeType: z
          .string()
          .optional()
          .describe("Optional node type filter: FRAME, COMPONENT, TEXT, GROUP, RECTANGLE, VECTOR, etc."),
      },
    },
    async ({ fileKey, query, nodeType }) => {
      const data = await figma.getFile(fileKey);
      const results = figma.searchNodes(data.document, query, nodeType);
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? JSON.stringify(results, null, 2)
              : `No nodes found matching "${query}"${nodeType ? ` with type ${nodeType}` : ""}.`,
          },
        ],
      };
    }
  );

  // ─── TOOL: list_components ───────────────────────────────────────────────
  server.registerTool(
    "list_components",
    {
      description: "List all published components in a Figma file with their descriptions and node IDs.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
      },
    },
    async ({ fileKey }) => {
      const [components, sets] = await Promise.all([
        figma.getComponents(fileKey),
        figma.getComponentSets(fileKey),
      ]);
      const summary = {
        componentCount: components.meta?.components?.length ?? 0,
        componentSetCount: sets.meta?.component_sets?.length ?? 0,
        components: components.meta?.components?.slice(0, 50).map((c: Record<string, unknown>) => ({
          nodeId: c.node_id,
          name: c.name,
          description: c.description,
          key: c.key,
        })),
        componentSets: sets.meta?.component_sets?.slice(0, 20).map((s: Record<string, unknown>) => ({
          nodeId: s.node_id,
          name: s.name,
          description: s.description,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ─── TOOL: get_styles ────────────────────────────────────────────────────
  server.registerTool(
    "get_styles",
    {
      description: "Get all design styles (colors, text, effects, grids) defined in a Figma file — the design token system.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
      },
    },
    async ({ fileKey }) => {
      const data = await figma.getStyles(fileKey);
      const grouped: Record<string, unknown[]> = {};
      for (const style of data.meta?.styles ?? []) {
        const t = style.style_type ?? "OTHER";
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push({ key: style.key, name: style.name, description: style.description });
      }
      return { content: [{ type: "text", text: JSON.stringify(grouped, null, 2) }] };
    }
  );

  // ─── TOOL: get_variables ─────────────────────────────────────────────────
  server.registerTool(
    "get_variables",
    {
      description: "Get local design token variables (colors, spacing, typography values) from a Figma file.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
      },
    },
    async ({ fileKey }) => {
      const data = await figma.getVariables(fileKey);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── TOOL: export_node ───────────────────────────────────────────────────
  server.registerTool(
    "export_node",
    {
      description: "Export a frame or node as an image so Claude can visually inspect the design.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
        nodeId: z.string().describe("Node ID to export"),
        format: z.enum(["png", "svg", "jpg"]).default("png").describe("Image format (default: png)"),
        scale: z.number().min(0.5).max(4).default(1).describe("Export scale factor 0.5–4 (default: 1)"),
      },
    },
    async ({ fileKey, nodeId, format, scale }) => {
      const result = await figma.exportNode(fileKey, nodeId, format, scale);
      if (result.err) {
        return { content: [{ type: "text", text: `Export error: ${result.err}` }] };
      }
      const id = figma.normalizeNodeId(nodeId);
      const imageUrl = result.images[id];
      if (!imageUrl) {
        return { content: [{ type: "text", text: "No image URL returned for that node." }] };
      }
      const imageRes = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const base64 = Buffer.from(imageRes.data).toString("base64");
      const mimeType = format === "svg" ? "image/svg+xml" : `image/${format}`;
      return {
        content: [
          { type: "text", text: `Exported node ${nodeId} as ${format} (scale ${scale}x):` },
          { type: "image", data: base64, mimeType },
        ],
      };
    }
  );

  // ─── TOOL: get_comments ──────────────────────────────────────────────────
  server.registerTool(
    "get_comments",
    {
      description: "Read all comments on a Figma file, including who posted them and which node they're anchored to.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
      },
    },
    async ({ fileKey }) => {
      const data = await figma.getComments(fileKey);
      const comments = data.comments?.map((c: Record<string, unknown>) => {
        const meta = c.client_meta as Record<string, unknown> | undefined;
        return {
          id: c.id,
          message: c.message,
          author: (c.user as Record<string, unknown>)?.handle,
          nodeId: meta?.node_id,
          createdAt: c.created_at,
          resolvedAt: c.resolved_at,
        };
      });
      return {
        content: [
          {
            type: "text",
            text: comments?.length ? JSON.stringify(comments, null, 2) : "No comments on this file.",
          },
        ],
      };
    }
  );

  // ─── TOOL: post_comment ──────────────────────────────────────────────────
  server.registerTool(
    "post_comment",
    {
      description: "Post a comment on a Figma file. Optionally anchor it to a specific node for inline design feedback.",
      inputSchema: {
        fileKey: z.string().describe("Figma file key"),
        message: z.string().describe("Comment text to post"),
        nodeId: z
          .string()
          .optional()
          .describe("Node ID to anchor the comment to (leave blank for a file-level comment)"),
        offsetX: z.number().optional().default(0).describe("X offset within the node for comment placement"),
        offsetY: z.number().optional().default(0).describe("Y offset within the node for comment placement"),
      },
    },
    async ({ fileKey, message, nodeId, offsetX, offsetY }) => {
      const data = await figma.postComment(fileKey, message, nodeId, offsetX, offsetY);
      return {
        content: [
          {
            type: "text",
            text: `Comment posted (id: ${data.id})${nodeId ? ` on node ${nodeId}` : ""}.`,
          },
        ],
      };
    }
  );

  return server;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const app = createMcpExpressApp({ host: "0.0.0.0" });

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "figma-mcp" });
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) delete transports[sid];
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Figma MCP server running on port ${PORT}`);
});

process.on("SIGINT", async () => {
  for (const sid of Object.keys(transports)) {
    try { await transports[sid].close(); } catch {}
    delete transports[sid];
  }
  process.exit(0);
});
