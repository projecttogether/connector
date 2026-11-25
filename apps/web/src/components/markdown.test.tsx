import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./markdown";

describe("MarkdownView", () => {
  it("opens web links in a new tab and keeps anchors", () => {
    render(<MarkdownView markdown={"[Site](https://example.org) [Top](#decision) [Rel](../x)"} />);
    const external = screen.getByText("Site").closest("a");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Top").closest("a")).toHaveAttribute("href", "#decision");
    expect(screen.getByText("Rel").closest("a")).toBeNull();
  });

  it("never renders HTML or images", () => {
    const { container } = render(
      <MarkdownView
        markdown={"Hello <b>bold</b>\n\n<script>alert(1)</script>\n\n![x](https://example.org/a.png)"}
      />,
    );
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    expect(container.querySelector("b, script, img")).toBeNull();
  });

  it("renders tables in a scroll area", () => {
    const { container } = render(<MarkdownView markdown={"| A | B |\n| - | - |\n| 1 | 2 |\n"} />);
    expect(container.querySelector("table")?.parentElement).toHaveClass("overflow-x-auto");
  });

  it("shows Markdown nested too deep as plain text", () => {
    const { container } = render(<MarkdownView markdown={`${">".repeat(10_000)} deep`} />);
    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.textContent).toMatch(/deep$/);
  });
});
