// ---------------------------------------------------------------------------
// Browser board — pure renderers + custom ids
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  BOARD_SHOT_NAME,
  renderHandBackModal,
  buildBrowserCustomId,
  enabledActions,
  isBrowserCustomId,
  parseBrowserCustomId,
  renderBrowserBoard,
  type BrowserBoardView,
} from "../../src/browser/board.js";
import type { BrowserState } from "../../src/browser/state.js";

function view(over: Partial<BrowserBoardView> = {}): BrowserBoardView {
  return {
    browserId: "abc_DEF-123",
    url: "https://example.com/",
    title: "Example Domain",
    state: "running",
    lastAction: "🤖 navigate: https://example.com/",
    actionCount: 3,
    ...over,
  };
}

type Button = { custom_id: string; disabled: boolean; label: string };

function buttons(state: BrowserState): Button[] {
  const payload = renderBrowserBoard(view({ state }));
  const row = payload.components[0] as { components: Button[] } | undefined;
  return row?.components ?? [];
}

describe("browser board custom ids", () => {
  it("round-trips every action", () => {
    for (const action of ["live", "pause", "resume", "takeover", "done", "handback", "handback-submit", "stop"] as const) {
      const id = buildBrowserCustomId("b1", action)!;
      expect(id).toBe(`br:b1:${action}`);
      expect(isBrowserCustomId(id)).toBe(true);
      expect(parseBrowserCustomId(id)).toEqual({ browserId: "b1", action });
    }
  });

  it("rejects unsafe ids and unknown actions", () => {
    expect(buildBrowserCustomId("bad id", "live")).toBeNull();
    expect(buildBrowserCustomId("x".repeat(41), "live")).toBeNull();
    expect(parseBrowserCustomId("br:b1:explode")).toBeNull();
    expect(parseBrowserCustomId("br:b 1:live")).toBeNull();
    expect(parseBrowserCustomId("sub:b1:stop")).toBeNull();
    expect(isBrowserCustomId("sub:b1:stop")).toBe(false);
  });

  it("keeps custom ids under Discord's 100-char limit", () => {
    expect(buildBrowserCustomId("x".repeat(40), "takeover")!.length).toBeLessThanOrEqual(100);
  });
});

describe("renderBrowserBoard", () => {
  it("renders five buttons with board custom ids while live", () => {
    const b = buttons("running");
    expect(b.map((x) => x.custom_id)).toEqual([
      "br:abc_DEF-123:live",
      "br:abc_DEF-123:pause",
      "br:abc_DEF-123:takeover",
      "br:abc_DEF-123:done",
      "br:abc_DEF-123:stop",
    ]);
  });

  it("enables the right buttons per state", () => {
    const enabled = (s: BrowserState) =>
      buttons(s).filter((x) => !x.disabled).map((x) => x.custom_id.split(":")[2]);
    expect(enabled("running")).toEqual(["live", "pause", "takeover", "stop"]);
    expect(enabled("paused")).toEqual(["live", "resume", "takeover", "stop"]);
    expect(enabled("needs-human")).toEqual(["live", "takeover", "done", "stop"]);
    expect(enabled("human-control")).toEqual(["live", "handback", "stop"]);
  });

  it("swaps Done for Hand back… while a human has control, and labels stop as Close", () => {
    const b = buttons("human-control");
    expect(b[3]).toMatchObject({ custom_id: "br:abc_DEF-123:handback", label: "Hand back…", disabled: false });
    expect(buttons("needs-human")[3].custom_id).toBe("br:abc_DEF-123:done");
    expect(b[4]).toMatchObject({ custom_id: "br:abc_DEF-123:stop", label: "Close" });
  });

  it("swaps Pause for Resume while paused", () => {
    expect(buttons("paused")[1].custom_id).toBe("br:abc_DEF-123:resume");
    expect(buttons("running")[1].custom_id).toBe("br:abc_DEF-123:pause");
  });

  it("has no controls once closed", () => {
    expect(buttons("closed")).toEqual([]);
    expect(enabledActions("closed").size).toBe(0);
    const embed = renderBrowserBoard(view({ state: "closed", hasShot: true })).embeds[0];
    expect(embed.image).toBeUndefined();
  });

  it("references the attached screenshot only when there is one", () => {
    expect(renderBrowserBoard(view({ hasShot: true })).embeds[0].image).toEqual({
      url: `attachment://${BOARD_SHOT_NAME}`,
    });
    expect(renderBrowserBoard(view()).embeds[0].image).toBeUndefined();
  });

  it("shows the reason when a human is needed", () => {
    const embed = renderBrowserBoard(view({ state: "needs-human", humanReason: "Log in please" })).embeds[0];
    expect(String(embed.description)).toContain("Log in please");
    expect(String(embed.title)).toContain("Needs you");
  });

  it("enforces embed limits on huge inputs", () => {
    const embed = renderBrowserBoard(
      view({
        title: "t".repeat(5000),
        url: `https://example.com/${"u".repeat(5000)}`,
        lastAction: "a".repeat(5000),
        state: "needs-human",
        humanReason: "r".repeat(5000),
      }),
    ).embeds[0] as { title: string; description: string; fields: Array<{ value: string }> };
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    for (const f of embed.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  it("renders the hand-back modal with capped choice and note inputs", () => {
    const modal = renderHandBackModal("b1", ["Logged in", "Gave up"]) as any;
    expect(modal.custom_id).toBe("br:b1:handback-submit");
    expect(parseBrowserCustomId(modal.custom_id)).toEqual({ browserId: "b1", action: "handback-submit" });
    const inputs = modal.components.map((r: any) => r.components[0]);
    expect(inputs.map((i: any) => [i.custom_id, i.max_length, i.required])).toEqual([
      ["choice", 40, false],
      ["note", 500, false],
    ]);
    expect(inputs[0].placeholder).toContain("Logged in, Gave up");
    expect((renderHandBackModal("b1") as any).components[0].components[0].placeholder).toContain("Didn't work");
    expect(renderHandBackModal("bad id")).toBeNull();
  });

  it("renders no controls for an unsafe browser id", () => {
    expect(renderBrowserBoard(view({ browserId: "has space" })).components).toEqual([]);
  });
});
