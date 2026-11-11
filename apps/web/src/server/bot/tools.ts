import type { AgentTool, Conversation } from "@ma/agent";
import type { AppContext } from "../context";
import { dossierTool } from "./dossier";
import { intelTools } from "./intel";
import { portfolioTools } from "./portfolio";
import { researchTools } from "./research";

export function botTools(app: AppContext, conversation: Conversation): AgentTool[] {
  const tools = [
    ...portfolioTools(app),
    dossierTool(app),
    ...intelTools(app),
    ...researchTools(app, conversation),
  ];
  return conversation.turns.length ? tools : tools.filter((t) => t.name !== "conversation_recall");
}
