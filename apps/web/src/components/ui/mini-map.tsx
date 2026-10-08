export interface MapBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

export interface MapPoint {
  key: string;
  lat: number;
  lon: number;
  kind?: string;
  label?: string;
}

export interface MapArea {
  key: string;
  lat: number;
  lon: number;
  radiusKm: number;
  label?: string;
}

export const INDIA_BOX: MapBox = { latMin: 0, latMax: 36, lonMin: 44, lonMax: 100 };

function fit(points: readonly MapPoint[], areas: readonly MapArea[]): MapBox {
  const lats = [...points.map((p) => p.lat), ...areas.map((a) => a.lat)];
  const lons = [...points.map((p) => p.lon), ...areas.map((a) => a.lon)];
  if (!lats.length) return INDIA_BOX;
  const pad = 2;
  const box = {
    latMin: Math.min(...lats) - pad,
    latMax: Math.max(...lats) + pad,
    lonMin: Math.min(...lons) - pad,
    lonMax: Math.max(...lons) + pad,
  };
  const inIndia =
    box.latMin >= INDIA_BOX.latMin &&
    box.latMax <= INDIA_BOX.latMax &&
    box.lonMin >= INDIA_BOX.lonMin &&
    box.lonMax <= INDIA_BOX.lonMax;
  if (!inIndia) return { latMin: -60, latMax: 75, lonMin: -180, lonMax: 180 };
  const span = 8;
  const cLat = (box.latMin + box.latMax) / 2;
  const cLon = (box.lonMin + box.lonMax) / 2;
  const half = Math.max(span, box.lonMax - box.lonMin, (box.latMax - box.latMin) * 2) / 2;
  return {
    latMin: cLat - half / 2,
    latMax: cLat + half / 2,
    lonMin: cLon - half,
    lonMax: cLon + half,
  };
}

function spread<T extends { lat: number; lon: number }>(
  items: readonly T[],
  x: (lon: number) => number,
  y: (lat: number) => number,
  minPx: number,
): Set<T> {
  const kept: T[] = [];
  for (const it of items) {
    const far = kept.every((k) => Math.hypot(x(k.lon) - x(it.lon), y(k.lat) - y(it.lat)) >= minPx);
    if (far) kept.push(it);
  }
  return new Set(kept);
}

export function MiniMap({
  points,
  areas = [],
  box,
  label,
}: {
  points: readonly MapPoint[];
  areas?: readonly MapArea[];
  box?: MapBox;
  label: string;
}) {
  const b = box ?? fit(points, areas);
  const W = 400;
  const H = Math.round((W * (b.latMax - b.latMin)) / (b.lonMax - b.lonMin));
  const x = (lon: number) => ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * W;
  const y = (lat: number) => ((b.latMax - lat) / (b.latMax - b.latMin)) * H;
  const lonSpan = b.lonMax - b.lonMin;
  const step = lonSpan > 90 ? 30 : lonSpan > 20 ? 5 : 2;
  const lonLines: number[] = [];
  for (let v = Math.ceil(b.lonMin / step) * step; v <= b.lonMax; v += step) lonLines.push(v);
  const latLines: number[] = [];
  for (let v = Math.ceil(b.latMin / step) * step; v <= b.latMax; v += step) latLines.push(v);
  const kmToPx = W / ((b.lonMax - b.lonMin) * 111);
  const labelled = spread(areas, x, y, 24);
  return (
    <svg
      className="minimap"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      {lonLines.map((v) => (
        <line key={`lon${v}`} className="graticule" x1={x(v)} x2={x(v)} y1={0} y2={H} />
      ))}
      {latLines.map((v) => (
        <line key={`lat${v}`} className="graticule" x1={0} x2={W} y1={y(v)} y2={y(v)} />
      ))}
      {areas.map((a) => (
        <g key={a.key}>
          <circle
            className="facility"
            cx={x(a.lon)}
            cy={y(a.lat)}
            r={Math.max(3, a.radiusKm * kmToPx)}
          />
          {a.label && labelled.has(a) ? (
            <text
              className="place"
              x={x(a.lon) > W * 0.55 ? x(a.lon) - 6 : x(a.lon) + 6}
              y={y(a.lat) - 4}
              textAnchor={x(a.lon) > W * 0.55 ? "end" : "start"}
            >
              {a.label}
            </text>
          ) : null}
        </g>
      ))}
      {points.map((p) => (
        <circle
          key={p.key}
          className="point"
          data-class={p.kind}
          cx={x(p.lon)}
          cy={y(p.lat)}
          r={2.5}
        >
          {p.label ? <title>{p.label}</title> : null}
        </circle>
      ))}
    </svg>
  );
}
