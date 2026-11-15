import crypto from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallContext } from "../observability.js";

// Failed calls are already logged as tool_result lines. What only the agent knows is
// the rest: a capability it looked for and could not find, a description that
// misled it, an argument it had to guess, a result that contradicted what it expected.
const KINDS = [
  "missing_capability",
  "unclear_docs",
  "had_to_guess",
  "unexpected_result",
  "tool_error",
  "other",
] as const;

// Truncated rather than rejected: a length error would make the agent drop the report.
const FIELD_MAX = 1000;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const field = (v?: string) =>
  v === undefined ? undefined : v.replace(EMAIL, "<email>").replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);

export const FEEDBACK_INSTRUCTIONS =
  "If a SparrowDesk tool could not do what the user asked, a tool description misled you, " +
  "you had to guess an argument, or a result contradicted what you expected, call " +
  "report_feedback once per distinct problem, then carry on with the user's request. " +
  "It goes to the SparrowDesk team and is how these tools get fixed.";

export function registerFeedbackTool(server: McpServer, ctx: CallContext) {
  server.registerTool(
    "report_feedback",
    {
      title: "Send feedback to SparrowDesk",
      description:
        "Tell the SparrowDesk team where these tools fell short, so they can be fixed. " +
        "Call it once per distinct problem, when:\n" +
        "- the user asked for something no tool can do (missing_capability);\n" +
        "- a tool's description or parameters were wrong or unclear (unclear_docs);\n" +
        "- you had to guess an argument, id format or filter value (had_to_guess);\n" +
        "- a call succeeded but the result looked wrong, e.g. empty when data exists (unexpected_result);\n" +
        "- a tool failed in a way its description did not prepare you for (tool_error).\n\n" +
        "Describe the problem with tool names, parameter names and ids. NEVER include customer " +
        "content (names, email addresses, phone numbers, message or ticket text) or any secret " +
        "or token. This does not do anything for the user; keep working on their request.",
      annotations: { title: "Send feedback to SparrowDesk", readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        kind: z.enum(KINDS).describe("Which kind of problem."),
        summary: z.string().min(10).describe("What went wrong or was missing, in one or two sentences."),
        tool: z.string().optional().describe("The tool involved, e.g. list_conversations."),
        tried: z.string().optional().describe("What you tried: tool calls and key arguments, ids only."),
        would_have_helped: z.string().optional().describe("The tool, parameter or description change that would have helped, if you know it."),
      },
    },
    async (args) => {
      const reference = crypto.randomUUID();
      console.log(JSON.stringify({
        event: "mcp_feedback",
        ref: reference,
        ...ctx,
        kind: args.kind,
        tool: field(args.tool),
        summary: field(args.summary),
        tried: field(args.tried),
        would_have_helped: field(args.would_have_helped),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ recorded: true, reference }) }],
      };
    }
  );
}
