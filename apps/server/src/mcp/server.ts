import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config";
import type { ApiClient } from "./client";
import { registerTools } from "./tools";

export const INSTRUCTIONS = `This server connects you to an organization's own apps: its knowledge base (Handbook), its logbook of decisions, updates and learnings (Logbook), its library of studies and reports (Library) and its records of contacts and partners (CRM). You see only what the person you work for may see.

Finding: start with get_context for a question or task (everything on a topic, ordered by the source order), or search for a quick lookup; read whole items with fetch. list_sources shows the connected apps. recent_changes shows what changed lately. find_people looks up colleagues.

Source order: when sources disagree, the higher one wins:
1. Purpose and rules (Handbook pages in rule spaces)
2. Logbook decisions in force (the newest wins)
3. Knowledge base pages (Handbook)
4. Logbook history (updates, learnings, replaced decisions)
5. Records (CRM)
6. Library notes (summaries of outside sources)
If a newer decision contradicts a knowledge base page, name both, follow the decision, and suggest updating the page. Purpose and rules stand above decisions. Never rely on a decision that is "superseded by" another.

Cite: link every claim to its item's url. Say when something is missing or a source did not answer; do not guess.

Changing: you draft, people publish. propose_handbook_change submits a change to the Handbook for review (the person must have linked their Handbook account in Connector). Do not put personal data into proposals.`;

/** A new MCP server with Connector's tools, acting through `api`. One per request (stateless). */
export function createMcpServer(api: ApiClient): McpServer {
  const server = new McpServer(
    { name: "connector", title: config().APP_NAME, version: "1.0.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerTools(server, api);
  return server;
}
