import { expect, test } from "@playwright/test";

const scenarios = [
  { side: "left", key: "ArrowLeft" },
  { side: "right", key: "ArrowRight" },
  { side: "left", key: null },
  { side: "right", key: null },
  { side: "tie", key: "ArrowUp" },
] as const;

for (const mirror of [false, true]) {
  test(`ranking exports the physical choice in Hebrew (${mirror ? "mirrored grid" : "default grid"})`, async ({ page }) => {
    const batch = "fixture-realism-ranking" + (mirror ? "-mirror" : "");
    await page.goto(`/app/#b/${batch}`);
    if (mirror) await page.addStyleTag({ content: ".realism-pair { direction: rtl !important; }" });
    await page.getByLabel("dev subject").fill("ranking-e2e");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const terms = page.locator(".termsform button[type=submit]");
    await expect(terms.or(page.locator(".ranking-choice").first()).first()).toBeVisible();
    if (await terms.isVisible()) await terms.click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    for (const [i, { side, key }] of scenarios.entries()) {
      await page.setViewportSize(i < 2 ? { width: 1440, height: 960 } : { width: 412, height: 860 });
      await expect(page.locator(".realism-counter")).toContainText(`זוג ${i + 1} מתוך 5`);
      await expect(page.locator(".ranking-choice").first()).toBeEnabled();
      const panels = await page.locator(".ranking-panel").evaluateAll(elements => elements.map(panel => {
        const photo = panel.querySelector("img")!;
        const button = panel.querySelector<HTMLButtonElement>(".ranking-choice")!;
        const imgRect = photo.getBoundingClientRect(), buttonRect = button.getBoundingClientRect();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(photo, 0, 0, 1, 1);
        const [red, , blue] = context.getImageData(0, 0, 1, 1).data;
        return { id: red! > blue! ? "red" : "blue", imageX: imgRect.x + imgRect.width / 2,
          buttonX: buttonRect.x + buttonRect.width / 2, buttonY: buttonRect.y + buttonRect.height / 2, label: button.textContent };
      }).sort((a, b) => a.imageX - b.imageX));
      expect(panels).toHaveLength(2);
      const [left, right] = panels;
      expect(left!.buttonX).toBeLessThan(right!.buttonX);
      expect(left!.label).toBe("השמאלי אמיתי יותר");
      expect(right!.label).toBe("הימני אמיתי יותר");
      const response = page.waitForResponse(r => r.url().endsWith(`/pairs/${i + 1}/choice`));
      if (key) await page.keyboard.press(key);
      else {
        const physical = side === "left" ? left! : right!;
        await page.mouse.click(physical.buttonX, physical.buttonY);
      }
      expect((await response).ok()).toBeTruthy();
      const file = await page.evaluate(async id => {
        const res = await fetch(`/api/admin/batches/${id}/export`);
        return (await res.json()).files["realism_ranking_cc0.json"];
      }, batch);
      const recorded = file.decisions.find((answer: { pair_id: string }) => answer.pair_id === `pair-${i + 1}`);
      const winner = side === "tie" ? null : `${(side === "left" ? left! : right!).id}-${i + 1}`;
      expect(recorded).toMatchObject({ choice: side, mapping_version: 2, winner_item_id: winner,
        left_item_id: `${left!.id}-${i + 1}`, right_item_id: `${right!.id}-${i + 1}` });
    }
  });
}
