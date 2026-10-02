import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductArt } from "../web/src/brand";

/**
 * Rendered server-side, because the browser-based suite in tests/e2e needs a
 * Chromium build that is not always downloadable. These assertions cover the
 * image/fallback decision itself rather than pixel layout.
 */
describe("Mini App product artwork", () => {
  it("renders the owner-set image when a link exists", () => {
    const html = renderToStaticMarkup(
      <ProductArt name="Spotify Gift Card" imageUrl="https://cdn.example.com/art/spotify.png"/>,
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="https://cdn.example.com/art/spotify.png"');
    expect(html).toContain('class="product-art"');
    expect(html).toContain('loading="lazy"');
    // Keeps the customer's origin from leaking to a third-party image host.
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("brand-icon");
  });

  it("falls back to the generated brand tile when no image is set", () => {
    for (const imageUrl of [null, undefined]) {
      const html = renderToStaticMarkup(<ProductArt name="Spotify Gift Card" imageUrl={imageUrl}/>);
      expect(html).toContain("brand-icon spotify");
      expect(html).not.toContain("<img");
    }
  });

  it("keeps the small variant sized for order rows", () => {
    const image = renderToStaticMarkup(
      <ProductArt name="Notion Creator Kit" imageUrl="https://cdn.example.com/a.png" small/>,
    );
    expect(image).toContain('class="product-art small"');

    const tile = renderToStaticMarkup(<ProductArt name="Notion Creator Kit" small/>);
    expect(tile).toContain("brand-icon notion small");
  });
});
