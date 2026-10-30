/** A successful provider response that could not supply one authorized tool call.
 * This is a model-only formatting failure: Igor may request one repaired choice,
 * but must never rerun an external action or retry provider HTTP failures.
 */
export class ModelToolProtocolError extends Error {
  constructor(readonly reason: "missing-or-multiple" | "unexpected") {
    super("Invalid model tool-call protocol.");
    this.name = "ModelToolProtocolError";
  }
}
