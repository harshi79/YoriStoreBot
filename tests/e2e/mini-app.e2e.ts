import { test, expect } from "@playwright/test";

test("desktop and mobile journeys use the live demo database", async ({ page, request }) => {
  // Never point a mutating browser test at a real store.
  const config = await (await request.get("/api/config")).json();
  expect(config.demoMode).toBe(true);
  await page.route("https://telegram.org/**", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Explore the collection/ })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(8);
  await page.getByRole("button", { name: "Streaming", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(2);
  await page.getByRole("button", { name: "All good things", exact: true }).click();
  await page.getByRole("textbox", { name: "Search products" }).fill("Notion");
  await expect(page.locator(".product-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".product-card")).toHaveCount(8);

  const heart = page.getByRole("button", { name: /Spotify Gift Card.*wishlist/ });
  const wasSaved = await heart.getAttribute("aria-pressed");
  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", wasSaved === "true" ? "false" : "true");
  await page.reload();
  await expect(page.getByRole("heading", { name: /Explore the collection/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Spotify Gift Card.*wishlist/ })).toHaveAttribute("aria-pressed", wasSaved === "true" ? "false" : "true");
  await page.getByRole("button", { name: /Spotify Gift Card.*wishlist/ }).click();

  await page.getByRole("button", { name: "My wallet", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your wallet/ })).toBeVisible();
  await expect(page.locator(".ledger-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Add credits", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /Try the demo gift code/ }).click();
  await expect(page.getByRole("textbox", { name: "Have a gift code?" })).toHaveValue("IRIS-DEMO-GIFT-PACK");
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: "Discover", exact: true }).first().click();
  await page.getByRole("button", { name: "Lightroom Presets", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Increase quantity", exact: true }).click();
  await expect(page.locator(".quantity>span")).toHaveText("2");
  await page.getByRole("button", { name: "Make it yours", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your digital delivery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reveal delivery", exact: true }).click();
  await expect(page.locator(".delivery-item")).toHaveCount(2);
  await expect(page.locator(".delivery-item pre").first()).toContainText("DEMO-LIGHTROOM");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save your private receipt" }).click();
  expect((await download).suggestedFilename()).toMatch(/^iris-order-/);
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: /My profile/, exact: true }).click();
  await expect(page.getByRole("heading", { name: /A space that’s very you/ })).toBeVisible();
  await page.getByRole("button", { name: /Make it feel like you/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /Make it feel like you/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-nav")).toBeVisible();
  await page.locator(".mobile-nav").getByRole("button", { name: "Discover", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Explore the collection/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.locator(".mobile-nav").getByRole("button", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Good things, safely collected/ })).toBeVisible();
  await page.locator(".order-card").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your digital delivery", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
