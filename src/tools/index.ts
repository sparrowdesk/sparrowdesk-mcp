import { registerAccountTools } from "./account.js";
import { registerCompanyTools } from "./companies.js";
import { registerContactTools } from "./contacts.js";
import { registerConversationTools } from "./conversations.js";
import { registerHelpCenterTools } from "./help-center.js";
import { registerImportTools } from "./imports.js";
import type { ToolContext } from "./types.js";

export function registerAllTools(context: ToolContext) {
  registerConversationTools(context);
  registerImportTools(context);
  registerContactTools(context);
  registerCompanyTools(context);
  registerHelpCenterTools(context);
  registerAccountTools(context);
}
