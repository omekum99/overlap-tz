'use strict';

/*
 * tzcities.js — friendly timezone search.
 *
 * Nobody thinks "Asia/Kolkata" — they think "India" or "Boston". This maps the
 * way people actually search (city, country, common aliases) to IANA zones, and
 * falls back to a humanized version of the full IANA list so nothing is missing.
 */

// Curated business hubs + countries. `aka` holds extra search aliases.
const TZ_CURATED = [
  // North America
  { tz: 'America/New_York', city: 'New York', country: 'USA', aka: 'nyc boston washington dc philadelphia miami atlanta detroit eastern et usa united states america' },
  { tz: 'America/Chicago', city: 'Chicago', country: 'USA', aka: 'dallas houston austin texas minneapolis central ct' },
  { tz: 'America/Denver', city: 'Denver', country: 'USA', aka: 'salt lake city mountain mt colorado' },
  { tz: 'America/Phoenix', city: 'Phoenix', country: 'USA', aka: 'arizona' },
  { tz: 'America/Los_Angeles', city: 'Los Angeles', country: 'USA', aka: 'la san francisco sf seattle portland san diego silicon valley pacific pt california' },
  { tz: 'America/Toronto', city: 'Toronto', country: 'Canada', aka: 'ottawa montreal canada eastern' },
  { tz: 'America/Vancouver', city: 'Vancouver', country: 'Canada', aka: 'canada pacific' },
  { tz: 'America/Mexico_City', city: 'Mexico City', country: 'Mexico', aka: 'mexico cdmx' },
  // Latin America
  { tz: 'America/Sao_Paulo', city: 'São Paulo', country: 'Brazil', aka: 'sao paulo rio de janeiro brazil brasil' },
  { tz: 'America/Argentina/Buenos_Aires', city: 'Buenos Aires', country: 'Argentina', aka: 'argentina' },
  { tz: 'America/Bogota', city: 'Bogotá', country: 'Colombia', aka: 'bogota colombia' },
  { tz: 'America/Lima', city: 'Lima', country: 'Peru', aka: 'peru' },
  { tz: 'America/Santiago', city: 'Santiago', country: 'Chile', aka: 'chile' },
  // Europe
  { tz: 'Europe/London', city: 'London', country: 'UK', aka: 'england britain uk united kingdom manchester edinburgh gmt bst' },
  { tz: 'Europe/Dublin', city: 'Dublin', country: 'Ireland', aka: 'ireland' },
  { tz: 'Europe/Lisbon', city: 'Lisbon', country: 'Portugal', aka: 'portugal porto' },
  { tz: 'Europe/Madrid', city: 'Madrid', country: 'Spain', aka: 'spain barcelona' },
  { tz: 'Europe/Paris', city: 'Paris', country: 'France', aka: 'france' },
  { tz: 'Europe/Berlin', city: 'Berlin', country: 'Germany', aka: 'germany munich frankfurt hamburg cet' },
  { tz: 'Europe/Amsterdam', city: 'Amsterdam', country: 'Netherlands', aka: 'netherlands holland' },
  { tz: 'Europe/Brussels', city: 'Brussels', country: 'Belgium', aka: 'belgium' },
  { tz: 'Europe/Zurich', city: 'Zürich', country: 'Switzerland', aka: 'zurich geneva switzerland' },
  { tz: 'Europe/Rome', city: 'Rome', country: 'Italy', aka: 'italy milan' },
  { tz: 'Europe/Stockholm', city: 'Stockholm', country: 'Sweden', aka: 'sweden' },
  { tz: 'Europe/Oslo', city: 'Oslo', country: 'Norway', aka: 'norway' },
  { tz: 'Europe/Copenhagen', city: 'Copenhagen', country: 'Denmark', aka: 'denmark' },
  { tz: 'Europe/Helsinki', city: 'Helsinki', country: 'Finland', aka: 'finland' },
  { tz: 'Europe/Warsaw', city: 'Warsaw', country: 'Poland', aka: 'poland' },
  { tz: 'Europe/Prague', city: 'Prague', country: 'Czechia', aka: 'czech republic czechia' },
  { tz: 'Europe/Vienna', city: 'Vienna', country: 'Austria', aka: 'austria' },
  { tz: 'Europe/Athens', city: 'Athens', country: 'Greece', aka: 'greece' },
  { tz: 'Europe/Istanbul', city: 'Istanbul', country: 'Turkey', aka: 'turkey ankara' },
  { tz: 'Europe/Moscow', city: 'Moscow', country: 'Russia', aka: 'russia' },
  { tz: 'Europe/Kyiv', city: 'Kyiv', country: 'Ukraine', aka: 'kiev ukraine' },
  // Middle East & Africa
  { tz: 'Asia/Dubai', city: 'Dubai', country: 'UAE', aka: 'abu dhabi uae united arab emirates gulf' },
  { tz: 'Asia/Riyadh', city: 'Riyadh', country: 'Saudi Arabia', aka: 'saudi arabia jeddah' },
  { tz: 'Asia/Jerusalem', city: 'Tel Aviv', country: 'Israel', aka: 'jerusalem israel' },
  { tz: 'Africa/Cairo', city: 'Cairo', country: 'Egypt', aka: 'egypt' },
  { tz: 'Africa/Nairobi', city: 'Nairobi', country: 'Kenya', aka: 'kenya' },
  { tz: 'Africa/Lagos', city: 'Lagos', country: 'Nigeria', aka: 'nigeria' },
  { tz: 'Africa/Johannesburg', city: 'Johannesburg', country: 'South Africa', aka: 'cape town south africa' },
  { tz: 'Africa/Casablanca', city: 'Casablanca', country: 'Morocco', aka: 'morocco' },
  // South Asia
  { tz: 'Asia/Kolkata', city: 'India', country: 'India', aka: 'mumbai delhi bangalore bengaluru kolkata chennai hyderabad pune india bharat ist' },
  { tz: 'Asia/Karachi', city: 'Karachi', country: 'Pakistan', aka: 'lahore islamabad pakistan' },
  { tz: 'Asia/Dhaka', city: 'Dhaka', country: 'Bangladesh', aka: 'bangladesh' },
  { tz: 'Asia/Colombo', city: 'Colombo', country: 'Sri Lanka', aka: 'sri lanka' },
  { tz: 'Asia/Kathmandu', city: 'Kathmandu', country: 'Nepal', aka: 'nepal' },
  // SE & East Asia
  { tz: 'Asia/Bangkok', city: 'Bangkok', country: 'Thailand', aka: 'thailand' },
  { tz: 'Asia/Jakarta', city: 'Jakarta', country: 'Indonesia', aka: 'indonesia bali' },
  { tz: 'Asia/Singapore', city: 'Singapore', country: 'Singapore', aka: 'sg' },
  { tz: 'Asia/Kuala_Lumpur', city: 'Kuala Lumpur', country: 'Malaysia', aka: 'malaysia' },
  { tz: 'Asia/Manila', city: 'Manila', country: 'Philippines', aka: 'philippines' },
  { tz: 'Asia/Ho_Chi_Minh', city: 'Ho Chi Minh City', country: 'Vietnam', aka: 'saigon hanoi vietnam' },
  { tz: 'Asia/Hong_Kong', city: 'Hong Kong', country: 'Hong Kong', aka: 'hk' },
  { tz: 'Asia/Shanghai', city: 'Shanghai', country: 'China', aka: 'beijing shenzhen guangzhou china' },
  { tz: 'Asia/Taipei', city: 'Taipei', country: 'Taiwan', aka: 'taiwan' },
  { tz: 'Asia/Seoul', city: 'Seoul', country: 'South Korea', aka: 'korea' },
  { tz: 'Asia/Tokyo', city: 'Tokyo', country: 'Japan', aka: 'osaka kyoto japan jst' },
  // Oceania
  { tz: 'Australia/Sydney', city: 'Sydney', country: 'Australia', aka: 'melbourne canberra brisbane australia' },
  { tz: 'Australia/Perth', city: 'Perth', country: 'Australia', aka: 'western australia' },
  { tz: 'Pacific/Auckland', city: 'Auckland', country: 'New Zealand', aka: 'wellington new zealand nz' },
  { tz: 'Pacific/Honolulu', city: 'Honolulu', country: 'USA', aka: 'hawaii' },
  { tz: 'UTC', city: 'UTC', country: 'Coordinated Universal Time', aka: 'gmt utc zulu' },
];

// Turn "Asia/Kolkata" → "Kolkata" / region "Asia".
function _humanizeTz(tz) {
  const parts = tz.split('/');
  const city = parts[parts.length - 1].replace(/_/g, ' ');
  const region = parts.length > 1 ? parts[0].replace(/_/g, ' ') : '';
  return { city, region };
}

// Full index: curated first, then every other IANA zone humanized.
const TZ_INDEX = (() => {
  const seen = new Set();
  const out = [];
  for (const c of TZ_CURATED) {
    seen.add(c.tz);
    const label = c.city === c.country ? c.city : `${c.city}, ${c.country}`;
    out.push({ tz: c.tz, label, hay: `${c.city} ${c.country} ${c.aka} ${c.tz}`.toLowerCase() });
  }
  const all = (typeof VALID_ZONES !== 'undefined' && VALID_ZONES) ? [...VALID_ZONES] : [];
  for (const tz of all) {
    if (seen.has(tz)) continue;
    const { city, region } = _humanizeTz(tz);
    out.push({ tz, label: `${city}${region ? ' · ' + region : ''}`, hay: `${city} ${region} ${tz}`.toLowerCase() });
  }
  return out;
})();

// The label we show once a zone is chosen.
function labelForTz(tz) {
  const hit = TZ_INDEX.find(e => e.tz === tz);
  if (hit) return hit.label;
  const { city, region } = _humanizeTz(tz);
  return `${city}${region ? ' · ' + region : ''}`;
}

// Search by city / country / alias. Ranked, capped.
function tzSearch(query, limit = 8) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return TZ_CURATED.slice(0, limit).map(c => ({ tz: c.tz, label: c.city === c.country ? c.city : `${c.city}, ${c.country}` }));
  const tokens = q.split(/\s+/);
  const scored = [];
  for (const e of TZ_INDEX) {
    if (!tokens.every(t => e.hay.includes(t))) continue;
    let score = 0;
    if (e.hay.startsWith(q)) score += 5;
    if (e.label.toLowerCase().startsWith(q)) score += 3;
    if (e.hay.includes(' ' + q)) score += 1;
    scored.push({ tz: e.tz, label: e.label, score });
  }
  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  return scored.slice(0, limit);
}
