import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { freshTask } from "../../src/data/fixtures";
import { ReferenceCreateStage } from "../../src/components/reference-create-stage";

const report = () => ({
  id: "report",
  kind: "research-report" as const,
  title: "New York rooftop research",
  content: "# Tradeoffs\nPrivacy, source quality and budget matter.",
  version: 1,
  dependencies: [],
  evidenceIds: [],
  assumptions: [],
  freshness: "current" as const,
  edited: false,
});

describe("Igor adaptive creation", () => {
  it("never shows an invitation collage or CTA for research documents", () => {
    const task = freshTask("research-case", "owner");
    task.brief.kind = "discovery";
    task.brief.goal = "Compare New York rooftops";
    task.artifacts.push(report());
    const html = renderToStaticMarkup(createElement(ReferenceCreateStage, {
      task, busy: false, onTurn: vi.fn(),
    }));
    expect(html).toContain("ig-create-stage-document");
    expect(html).toContain("New York rooftop research");
    expect(html).toContain("Research and document creation");
    expect(html).not.toContain("ig-create-collage");
    expect(html).not.toContain("Create invite");
    expect(html).not.toContain("An evening together");
  });

  it("a research report overrides a stale gathering brief instead of reusing the event collage", () => {
    const task = freshTask("research-from-event", "owner");
    task.artifacts.push(report());
    const html = renderToStaticMarkup(createElement(ReferenceCreateStage, {
      task, busy: false, onTurn: vi.fn(),
    }));
    expect(html).toContain("ig-create-stage-document");
    expect(html).not.toContain("ig-create-collage");
  });

  it("a genuine invitation retains the image-led composition", () => {
    const task = freshTask("event-case", "owner");
    task.artifacts.push({ ...report(), kind: "invitation", title: "Evening invitation" });
    const html = renderToStaticMarkup(createElement(ReferenceCreateStage, {
      task, busy: false, onTurn: vi.fn(),
    }));
    expect(html).toContain("ig-create-collage");
    expect(html).toContain("Create invite");
  });
});
