export type CompletionStatus = "succeeded" | "timedOut" | "failed";

export type CompletionPlan =
  | {
      readonly kind: "agent";
      readonly instruction: string;
    }
  | {
      readonly kind: "notify";
      readonly level: "info" | "warning";
      readonly summary: string;
    };

export const planCompletion = (
  status: CompletionStatus,
  wake: "agent" | "notify"
): CompletionPlan => {
  if (wake === "notify") {
    return {
      kind: "notify",
      level: status === "succeeded" ? "info" : "warning",
      summary: status === "succeeded" ? "condition met" : status,
    };
  }

  if (status === "succeeded") {
    return {
      kind: "agent",
      instruction:
        "The condition is true. Continue the pending work using this receipt.",
    };
  }
  if (status === "timedOut") {
    return {
      kind: "agent",
      instruction:
        "The watch timed out. Inspect the receipt and decide what to do next.",
    };
  }
  return {
    kind: "agent",
    instruction:
      "The watch failed. Inspect the receipt and decide what to do next.",
  };
};
