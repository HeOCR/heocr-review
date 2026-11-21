export type PixelPoint = [number, number];
export type PixelPolygon = PixelPoint[];

const orientation = (a: PixelPoint, b: PixelPoint, c: PixelPoint) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function intersects(a: PixelPoint, b: PixelPoint, c: PixelPoint, d: PixelPoint): boolean {
  const disjoint = [0, 1].some(i =>
    Math.max(a[i]!, b[i]!) < Math.min(c[i]!, d[i]!) || Math.max(c[i]!, d[i]!) < Math.min(a[i]!, b[i]!));
  return !disjoint && orientation(a, b, c) * orientation(a, b, d) <= 0 &&
    orientation(c, d, a) * orientation(c, d, b) <= 0;
}

export function linePolygons(value: unknown, width: number, height: number): PixelPolygon[] | null {
  if (!Array.isArray(value) || value.length !== 10) return null;
  const out: PixelPolygon[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 3 || raw.length > 32 || !raw.every(p =>
      Array.isArray(p) && p.length === 2 && p.every(Number.isSafeInteger) && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height)) return null;
    const p = raw as PixelPolygon;
    if (new Set(p.map(point => point.join(","))).size !== p.length) return null;
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!, b = p[(i + 1) % p.length]!;
      area += a[0] * b[1] - a[1] * b[0];
      for (let j = i + 2; j < p.length; j++) {
        if (i === 0 && j === p.length - 1) continue;
        if (intersects(a, b, p[j]!, p[(j + 1) % p.length]!)) return null;
      }
    }
    if (area === 0) return null;
    out.push(p);
  }
  // A line must not reuse an identical region under another position.
  return new Set(out.map(p => p.map(point => point.join(",")).sort().join(";"))).size === 10 ? out : null;
}

export function polygonBounds(p: PixelPolygon) {
  const xs = p.map(pt => pt[0]), ys = p.map(pt => pt[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}
