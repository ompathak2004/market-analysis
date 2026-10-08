import { AppError } from "@ma/core";

export class LlmBudgetExceeded extends AppError {
  constructor(used: number, budget: number) {
    super("llm daily token budget exhausted", "llm_budget_exceeded", 429, { used, budget });
  }
}

export class LlmInvalidOutput extends AppError {
  constructor(name: string, reason: string) {
    super(`llm output invalid for ${name}: ${reason.slice(0, 400)}`, "llm_invalid_output", 502, {
      name,
    });
  }
}

export class LlmPromptTooLarge extends AppError {
  constructor(name: string, estimatedTokens: number, limit: number) {
    super(`llm prompt for ${name} too large`, "llm_prompt_too_large", 400, {
      name,
      estimatedTokens,
      limit,
    });
  }
}
