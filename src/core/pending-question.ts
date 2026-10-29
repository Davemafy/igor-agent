import type { Task } from "./contracts";

/** A short reply to Igor's most recent question is an answer, not a new task.
 * No persisted shadow conversation state is needed: messages are already
 * transactionally committed with the task and available after a reload. */
export function pendingQuestionAnswer(
  context: Pick<Task, "messages">,
  answer: string,
): { question: string; answer: string } | null {
  const reply = answer.trim();

  if (
    !reply ||
    reply.length > 120 ||
    reply.includes("\n") ||
    /^(?:please\s+)?(?:write|draft|create|generate|make|research|find|show|build|plan|design|change|edit|replace|switch|forget|start|stop|cancel)\b/i.test(
      reply,
    ) ||
    /^(?:actually|instead|new topic|different question)\b/i.test(reply)
  ) {
    return null;
  }

  const last = context.messages.at(-1);

  if (
    last?.role !== "assistant" ||
    !last.text.includes("?") ||
    last.text.length > 1600
  ) {
    return null;
  }

  return { question: last.text, answer: reply };
}
