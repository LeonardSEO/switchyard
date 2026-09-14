import { describe, expect, it } from "vitest";
import { cheapestAboveQuality, dominates, isParetoOptimal, paretoFrontier } from "../src/index";

interface Point {
  id: string;
  price?: number;
  quality?: number;
}

const axes = { price: (p: Point) => p.price, quality: (p: Point) => p.quality };

const points: Point[] = [
  { id: "cheap-weak", price: 0.01, quality: 0.2 },
  { id: "dominated", price: 0.05, quality: 0.3 },
  { id: "value", price: 0.02, quality: 0.55 },
  { id: "expensive-strong", price: 1, quality: 0.8 },
  { id: "no-benchmark", quality: 0.9 },
  { id: "free-unmeasured", price: 0 },
];

describe("pareto", () => {
  it("drops models that are both dearer and worse", () => {
    const ids = paretoFrontier(points, axes).map((p) => p.id);
    expect(ids).toContain("value");
    expect(ids).toContain("cheap-weak");
    expect(ids).toContain("expensive-strong");
    expect(ids).not.toContain("dominated");
  });

  it("never lets an unknown value dominate a measured one", () => {
    // no-benchmark has the highest quality but no price; free-unmeasured has the
    // lowest price but no quality. Neither may dominate `value`.
    expect(isParetoOptimal({ id: "value", price: 0.02, quality: 0.55 }, points, axes)).toBe(true);
    expect(dominates({ id: "x", price: 0 }, { id: "value", price: 0.02, quality: 0.55 }, axes)).toBe(false);
    expect(
      dominates({ id: "x", quality: 0.9 }, { id: "value", price: 0.02, quality: 0.55 }, axes),
    ).toBe(false);
  });

  it("finds the cheapest model above a quality floor", () => {
    const best = cheapestAboveQuality(points, 0.5, axes);
    expect(best?.id).toBe("value");
    expect(cheapestAboveQuality(points, 0.95, axes)).toBeUndefined();
  });

  it("ignores unmeasured quality when a floor is set", () => {
    const unmeasured: Point[] = [{ id: "mystery", price: 0.001, quality: undefined }];
    expect(cheapestAboveQuality(unmeasured, 0.5, axes)).toBeUndefined();
  });
});
