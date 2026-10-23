// @ts-check
// Browser side of the live hero sentence; the logic is shared with the server's first paint.
import { heroHtml } from '@lt/core/hero.js';

/**
 * @param {any[]} stations GeoJSON features from /api/stations
 * @param {any[]} areas GeoJSON features from /api/areas
 * @param {{ lat: number, lng: number } | null} viewer
 */
export function heroSentence(stations, areas, viewer) {
  const html = heroHtml(
    stations.map((f) => ({ ...f.properties, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
    areas.map((f) => ({ ...f.properties, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
    viewer,
  );
  return html ? { html } : null;
}
