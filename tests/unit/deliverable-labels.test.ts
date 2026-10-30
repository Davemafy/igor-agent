import { describe, expect, it } from "vitest";
import { reconcileDeliverableLabels } from "../../src/core/deliverable-labels";

describe("requested artifact contract", () => {
  const content =
    "A source-supported investment memo with clear competing network operators, " +
    "a risk register, evidence links, limitations and a recommendation. " +
    "The estimates remain provisional without provider pricing verification.";

  it("recognizes an explicitly titled investment memo despite a proposal label", () => {
    expect(
      reconcileDeliverableLabels(
        "EV Charging Market Investment Memo",
        content,
        ["proposal"],
        ["investment-memo"],
      ),
    ).toEqual(["proposal", "investment-memo"]);
  });

  it("recognizes a memo from both the user request and the title despite a generic model label", () => {
    expect(
      reconcileDeliverableLabels(
        "EV Charging Market Investment Memo",
        content,
        ["proposal"],
        ["proposal"],
        "Research EV charging competitors and save an investment memo.",
      ),
    ).toEqual(["proposal", "memo"]);
  });

  it("does not infer memo metadata from the title alone", () => {
    expect(
      reconcileDeliverableLabels(
        "Investment Memo",
        content,
        ["proposal"],
        ["proposal"],
        "Write a proposal about funding priorities.",
      ),
    ).toEqual(["proposal"]);
  });

  it("does not invent an unrelated deliverable", () => {
    expect(
      reconcileDeliverableLabels(
        "Draft invitation",
        content,
        ["invitation"],
        ["investment-memo", "plan"],
      ),
    ).toEqual(["invitation"]);
  });

  it("does not upgrade a short placeholder into a completed memo", () => {
    expect(
      reconcileDeliverableLabels(
        "Investment Memo",
        "Placeholder only.",
        [],
        ["investment-memo"],
      ),
    ).toEqual([]);
  });

  it("does not strip model-provided labels when no request exists", () => {
    expect(
      reconcileDeliverableLabels("Draft Proposal", content, ["proposal"], []),
    ).toEqual(["proposal"]);
  });
});
