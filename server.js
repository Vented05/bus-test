const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// AC Transit API Credentials & Base URLs
const ACT_TOKEN = 'E8B5BCE12863B6FF772C0D59FB2843AF';
const ACT_API_BASE = 'https://api.actransit.org/transit';
const OTP_BASE = 'https://tp.actransit.org/otp1/otp/routers/default';
const PELIAS_BASE = 'https://tp.actransit.org/pelias/v1';
const MAPS_BASE = 'https://maps.actransit.org/map';

// Middlewares
app.use(compression());
app.use(cors({ origin: '*' }));
app.use(express.json());

// In-memory data caches
let stopsCache = [];
let stopsById = new Map();
let stopsByCode = new Map();
let routesCache = [];
let routesById = new Map();
let routeShapesCache = new Map();
let liveVehiclesCache = { data: [], timestamp: 0 };

// Polyline decoder utility
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0, coordinates = [];
  const len = str.length;
  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    coordinates.push([lng / 1e5, lat / 1e5]);
  }
  return coordinates;
}

// Distance utility (Haversine in meters)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Helper: HTTP GET JSON
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ACTransitMaps/1.0',
      ...(options.headers || {})
    },
    ...options
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return await res.json();
}

// Feed time parsing & formatting (Exact times matching official AC Transit app)
const pt = s => {
  const m = /(\d{4})(\d\d)(\d\d) (\d\d):(\d\d)/.exec(s || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
};

const fmtTime = d => {
  if (!d || !(d instanceof Date) || isNaN(d)) return '';
  return (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (d.getHours() < 12 ? 'am' : 'pm');
};

const fmtMins = p => {
  if (!p) return 'Due';
  if (/^due$/i.test(p.prdctdn) || +p.prdctdn <= 0) return 'Due';
  return `${p.prdctdn} min`;
};

// Canceled trips cache
let canceledTripsCache = { timestamp: 0, data: [] };
async function getCanceledTrips() {
  const now = Date.now();
  if (now - canceledTripsCache.timestamp < 45000 && canceledTripsCache.data.length > 0) {
    return canceledTripsCache.data;
  }
  const pad = n => String(n).padStart(2, '0');
  const fDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dNow = new Date();
  const tFrom = fDate(new Date(dNow.getTime() - 2 * 3600000));
  const tTo = fDate(new Date(dNow.getTime() + 10 * 3600000));
  try {
    const url = `${ACT_API_BASE}/trips/canceled?tripDateTimeFrom=${tFrom}&tripDateTimeTo=${tTo}&token=${ACT_TOKEN}`;
    const data = await fetchJson(url);
    if (Array.isArray(data)) {
      canceledTripsCache = { timestamp: now, data };
      return data;
    }
  } catch (err) {
    console.warn('[CanceledTrips] Fetch error:', err.message);
  }
  return canceledTripsCache.data || [];
}

// Smart deduplication and grouping for transit stops
function groupAndDeduplicateStops(stops, query) {
  const qLower = query.toLowerCase().trim();
  const isNumeric = /^\d{4,6}$/.test(qLower);

  if (isNumeric) {
    const exact = stops.filter(s => String(s.code || s.stopId) === qLower);
    if (exact.length > 0) {
      return exact.map(s => ({
        id: `stop_${s.stopId}`,
        name: `${s.name} (Stop #${s.code || s.stopId})`,
        label: s.city ? `${s.city}` : 'East Bay, CA',
        city: s.city || 'East Bay',
        lat: s.lat,
        lon: s.lon,
        type: 'stop',
        stopId: String(s.code || s.stopId),
        allStopIds: [String(s.code || s.stopId)],
        isHub: false,
        stopCount: 1
      }));
    }
  }

  const matches = stops.filter(s => {
    const nameMatch = s.name && s.name.toLowerCase().includes(qLower);
    const codeMatch = s.code && String(s.code) === qLower;
    return nameMatch || codeMatch;
  });

  const distM = (a, b) => {
    const r = Math.PI / 180;
    const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
              Math.cos(a.lat * r) * Math.cos(b.lat * r) *
              Math.sin((b.lon - a.lon) * r / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(x));
  };

  const groups = [];
  for (const s of matches) {
    const canonName = s.name.trim()
      .replace(/\s*\(bay\s+[a-z0-9]+\)/i, '')
      .replace(/\s+bay\s+[a-z0-9]+/i, '')
      .replace(/\s+transit\s+center/i, '')
      .replace(/\s+station/i, '')
      .trim()
      .toLowerCase();

    let foundGroup = null;
    for (const g of groups) {
      if (g.canonName === canonName && distM(g, s) < 550) {
        foundGroup = g;
        break;
      }
    }
    if (foundGroup) {
      foundGroup.stops.push(s);
    } else {
      const cleanName = s.name.trim()
        .replace(/\s*\(bay\s+[a-z0-9]+\)/i, '')
        .replace(/\s+bay\s+[a-z0-9]+/i, '')
        .trim();
      groups.push({
        name: cleanName,
        canonName: canonName,
        normName: s.name.trim().toLowerCase(),
        city: s.city || '',
        lat: s.lat,
        lon: s.lon,
        stops: [s]
      });
    }
  }

  groups.sort((a, b) => {
    const aStarts = a.normName.startsWith(qLower);
    const bStarts = b.normName.startsWith(qLower);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return b.stops.length - a.stops.length;
  });

  return groups.slice(0, 6).map(g => {
    const count = g.stops.length;
    const codes = g.stops.map(s => String(s.code || s.stopId));
    const avgLat = g.stops.reduce((sum, s) => sum + s.lat, 0) / count;
    const avgLon = g.stops.reduce((sum, s) => sum + s.lon, 0) / count;

    if (count > 1) {
      return {
        id: `hub_${codes[0]}`,
        name: g.name,
        label: `Transit Center · ${count} Bays · ${g.city || 'East Bay'}`,
        city: g.city || 'East Bay',
        lat: avgLat,
        lon: avgLon,
        type: 'stop',
        stopId: codes.join(','),
        allStopIds: codes,
        isHub: true,
        stopCount: count
      };
    } else {
      const s = g.stops[0];
      return {
        id: `stop_${s.stopId}`,
        name: s.name,
        label: `Stop #${s.code || s.stopId} · ${s.city}`,
        city: s.city || 'East Bay',
        lat: s.lat,
        lon: s.lon,
        type: 'stop',
        stopId: String(s.code || s.stopId),
        allStopIds: [String(s.code || s.stopId)],
        isHub: false,
        stopCount: 1
      };
    }
  });
}

// Route classification & color assignment
function getRouteMeta(r) {
  const id = r.RouteId || r.id || '';
  const name = r.Name || r.shortName || id;
  const isRapid = r.IsRapid || id === '1T' || id.toLowerCase().includes('tempo');
  const isTransbay = r.IsTransbay || /^[A-Z]$|^[A-Z]{2}$/.test(id) && id !== '1T';
  const isAllNighter = r.IsAllNighter || /^8\d\d$/.test(id);
  const isSchool = r.IsSchool || /^\d{3}$/.test(id) && parseInt(id, 10) >= 600 && parseInt(id, 10) <= 699;
  const isLocal = !isRapid && !isTransbay && !isAllNighter && !isSchool;

  let category = 'Local';
  let color = '#0072CE'; // AC Transit Blue
  let textColor = '#FFFFFF';

  if (isRapid) {
    category = 'Rapid';
    color = '#E65100'; // Tempo Orange
  } else if (isTransbay) {
    category = 'Transbay';
    color = '#6A1B9A'; // Transbay Purple
  } else if (isAllNighter) {
    category = 'All-Nighter';
    color = '#1A237E'; // Night Indigo
  } else if (isSchool) {
    category = 'School';
    color = '#F57F17'; // School Amber
  } else {
    // Distinctive color palettes for popular local corridors
    if (['51A', '51B'].includes(id)) color = '#0288D1';
    else if (['72', '72M', '72R'].includes(id)) color = '#2E7D32';
    else if (['6', '18', '88'].includes(id)) color = '#00838F';
    else if (['40', '14', '20'].includes(id)) color = '#303F9F';
    else if (['73', '74', '76'].includes(id)) color = '#00796B';
    else color = '#0072CE';
  }

  return {
    routeId: id,
    name: name,
    description: r.Description || r.longName || name,
    category,
    color,
    textColor,
    division: r.Division || 'AC'
  };
}

// Preload stops and routes on server startup
async function initData() {
  console.log('[Init] Fetching AC Transit routes...');
  try {
    const routesData = await fetchJson(`${ACT_API_BASE}/routes?token=${ACT_TOKEN}`);
    routesCache = routesData.map(getRouteMeta);
    routesCache.sort((a, b) => {
      // Prioritize Rapid (1T), then Transbay, then Local by numeric sort
      if (a.category === 'Rapid' && b.category !== 'Rapid') return -1;
      if (b.category === 'Rapid' && a.category !== 'Rapid') return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    routesById.clear();
    routesCache.forEach(r => routesById.set(r.routeId.toUpperCase(), r));
    console.log(`[Init] Loaded ${routesCache.length} routes.`);
  } catch (err) {
    console.error('[Init] Error fetching routes:', err.message);
  }

  console.log('[Init] Fetching AC Transit stops...');
  try {
    const stopsData = await fetchJson(`${ACT_API_BASE}/stops?token=${ACT_TOKEN}`);
    stopsCache = stopsData.map(s => ({
      stopId: s.StopId,
      code: String(s.StopId),
      name: s.Name,
      lat: s.Latitude,
      lon: s.Longitude,
      city: s.City || 'East Bay'
    }));
    stopsById.clear();
    stopsByCode.clear();
    stopsCache.forEach(s => {
      stopsById.set(s.stopId, s);
      stopsByCode.set(s.code, s);
    });
    console.log(`[Init] Loaded ${stopsCache.length} stops.`);
  } catch (err) {
    console.error('[Init] Error fetching stops:', err.message);
  }
}

// ----------------- API ROUTES -----------------

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    routesCount: routesCache.length,
    stopsCount: stopsCache.length,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Get all routes
app.get('/api/routes', (req, res) => {
  const { category, search } = req.query;
  let results = routesCache;
  if (category) {
    results = results.filter(r => r.category.toLowerCase() === category.toLowerCase());
  }
  if (search) {
    const q = search.toLowerCase().trim();
    results = results.filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }
  res.json(results);
});

// Get single route info
app.get('/api/routes/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  const route = routesById.get(id);
  if (!route) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.json(route);
});

// Get route stops by direction
app.get('/api/routes/:id/stops', async (req, res) => {
  const id = req.params.id.toUpperCase();
  try {
    const data = await fetchJson(`${ACT_API_BASE}/route/${encodeURIComponent(id)}/stops?token=${ACT_TOKEN}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch route stops', details: err.message });
  }
});

// Get live GPS vehicles on route
app.get('/api/routes/:id/vehicles', async (req, res) => {
  const id = req.params.id.toUpperCase();
  try {
    const data = await fetchJson(`${ACT_API_BASE}/route/${encodeURIComponent(id)}/vehicles?token=${ACT_TOKEN}`);
    const vehicles = (Array.isArray(data) ? data : []).map(v => ({
      vehicleId: v.VehicleId,
      tripId: v.CurrentTripId,
      routeId: id,
      lat: v.Latitude,
      lon: v.Longitude,
      heading: v.Heading || 0,
      lastReported: v.TimeLastReported
    }));
    res.json(vehicles);
  } catch (err) {
    res.json([]);
  }
});

// Get route shape geometry (as GeoJSON LineString)
app.get('/api/routes/:id/shape', async (req, res) => {
  const id = req.params.id.toUpperCase();
  if (routeShapesCache.has(id)) {
    return res.json(routeShapesCache.get(id));
  }
  try {
    // Attempt OTP trip geometry
    const trips = await fetchJson(`${OTP_BASE}/index/routes/2:${encodeURIComponent(id)}/trips`);
    if (Array.isArray(trips) && trips.length > 0) {
      // Pick first trip for each direction
      const shapes = [];
      const seenDirs = new Set();
      for (const trip of trips) {
        const dir = trip.direction ?? 0;
        if (!seenDirs.has(dir) && trip.id) {
          seenDirs.add(dir);
          try {
            const geom = await fetchJson(`${OTP_BASE}/index/trips/${trip.id}/geometry`);
            if (geom && geom.points) {
              const coords = decodePolyline(geom.points);
              shapes.push({
                direction: dir,
                headsign: trip.tripHeadsign || '',
                coordinates: coords
              });
            }
          } catch (e) {}
        }
        if (shapes.length >= 2) break;
      }
      if (shapes.length > 0) {
        const result = { routeId: id, shapes };
        routeShapesCache.set(id, result);
        return res.json(result);
      }
    }
  } catch (err) {
    console.warn(`[Shape] OTP shape lookup failed for ${id}, falling back to stops.`);
  }

  // Fallback: connect stops in order
  try {
    const stopsData = await fetchJson(`${ACT_API_BASE}/route/${encodeURIComponent(id)}/stops?token=${ACT_TOKEN}`);
    const shapes = (stopsData || []).map(d => ({
      direction: d.Direction,
      destination: d.Destination,
      coordinates: (d.Stops || []).map(s => [s.Longitude, s.Latitude])
    }));
    const result = { routeId: id, shapes };
    routeShapesCache.set(id, result);
    return res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate shape', details: err.message });
  }
});

// Get route timetable/schedule
app.get('/api/routes/:id/schedule', async (req, res) => {
  const id = req.params.id.toUpperCase();
  try {
    const data = await fetchJson(`${ACT_API_BASE}/route/${encodeURIComponent(id)}/schedule?token=${ACT_TOKEN}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch schedule', details: err.message });
  }
});

// Get all stops or bbox filtered
app.get('/api/stops', (req, res) => {
  const { minLat, maxLat, minLon, maxLon, search, limit } = req.query;
  let results = stopsCache;

  if (minLat && maxLat && minLon && maxLon) {
    const nMinLat = parseFloat(minLat);
    const nMaxLat = parseFloat(maxLat);
    const nMinLon = parseFloat(minLon);
    const nMaxLon = parseFloat(maxLon);
    results = results.filter(s =>
      s.lat >= nMinLat && s.lat <= nMaxLat &&
      s.lon >= nMinLon && s.lon <= nMaxLon
    );
  }

  if (search) {
    const q = search.toLowerCase().trim();
    results = results.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.code.includes(q) ||
      s.city.toLowerCase().includes(q)
    );
  }

  const max = limit ? parseInt(limit, 10) : 500;
  res.json(results.slice(0, max));
});

// Nearby stops
app.get('/api/stops/nearby', (req, res) => {
  const { lat, lon, radius = 1000, limit = 15 } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'Missing lat or lon query parameter' });
  }
  const uLat = parseFloat(lat);
  const uLon = parseFloat(lon);
  const maxRadius = parseFloat(radius);
  const maxLimit = parseInt(limit, 10);

  const nearby = [];
  for (const stop of stopsCache) {
    const dist = getDistanceMeters(uLat, uLon, stop.lat, stop.lon);
    if (dist <= maxRadius) {
      nearby.push({
        ...stop,
        distanceMeters: Math.round(dist),
        distanceMiles: +(dist / 1609.34).toFixed(2)
      });
    }
  }

  nearby.sort((a, b) => a.distanceMeters - b.distanceMeters);
  res.json(nearby.slice(0, maxLimit));
});

// Single stop details
app.get('/api/stops/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stop = stopsById.get(id) || stopsByCode.get(req.params.id);
  if (!stop) {
    return res.status(404).json({ error: 'Stop not found' });
  }
  res.json(stop);
});

// Live predictions for a stop (supports single ID or comma-separated multi-stop IDs for transit centers)
app.get('/api/stops/:id/predictions', async (req, res) => {
  const stopIdParam = req.params.id;
  const ids = String(stopIdParam).split(',').map(s => s.trim()).filter(Boolean);
  const results = {
    stopId: ids.join(','),
    timestamp: new Date().toISOString(),
    predictions: []
  };

  try {
    const prdList = [];
    // Batch in groups of up to 10 stop IDs as supported by AC Transit Bustime
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const bustimeUrl = `${ACT_API_BASE}/actrealtime/prediction?stpid=${chunk.join(',')}&token=${ACT_TOKEN}`;
      const bustimeData = await fetchJson(bustimeUrl);
      const items = bustimeData?.['bustime-response']?.prd || [];
      if (Array.isArray(items)) prdList.push(...items);
    }

    if (prdList.length > 0) {
      results.predictions = prdList.map(p => {
        const predDate = pt(p.prdtm);
        const isDue = /^due$/i.test(p.prdctdn) || +p.prdctdn <= 0;
        const minsVal = isDue ? 0 : (+p.prdctdn || (predDate ? Math.max(0, Math.round((predDate.getTime() - Date.now()) / 60000)) : 0));

        return {
          route: p.rt,
          direction: p.rtdir,
          destination: p.des,
          vehicleId: p.vid,
          stopId: p.stpid,
          stopName: p.stpnm,
          predictedTime: p.prdtm,
          formattedTime: fmtTime(predDate),
          countdown: fmtMins(p),
          minutes: minsVal,
          passengerLoad: p.psgld || null,
          isDelayed: Boolean(p.dly),
          isLive: true
        };
      });
      results.predictions.sort((a, b) => a.minutes - b.minutes);
      return res.json(results);
    }
  } catch (err) {
    console.warn(`[Predictions] Bustime fetch error for stop ${stopIdParam}:`, err.message);
  }

  // 2. Fallback to OTP stoptimes if Bustime returns empty or off-hours
  try {
    const firstId = ids[0];
    const otpUrl = `${OTP_BASE}/index/stops/2:${encodeURIComponent(firstId)}/stoptimes?numberOfDepartures=6`;
    const otpData = await fetchJson(otpUrl);
    if (Array.isArray(otpData)) {
      const fallbackList = [];
      const nowSec = Math.floor(Date.now() / 1000);
      for (const pattern of otpData) {
        const routeId = pattern.pattern?.id?.split(':')?.[1] || '';
        const desc = pattern.pattern?.desc || '';
        for (const t of pattern.times || []) {
          const depTimeSec = t.realtimeDeparture || t.scheduledDeparture;
          const serviceDay = t.serviceDay || nowSec;
          const fullDepTime = serviceDay + depTimeSec;
          const diffMinutes = Math.max(0, Math.round((fullDepTime - nowSec) / 60));
          const predDate = new Date(fullDepTime * 1000);
          fallbackList.push({
            route: routeId,
            direction: desc,
            destination: desc.split(' to ')?.[1]?.split(' (2:')?.[0] || desc,
            vehicleId: null,
            stopId: firstId,
            stopName: '',
            predictedTime: null,
            formattedTime: fmtTime(predDate),
            countdown: diffMinutes <= 0 ? 'Due' : `${diffMinutes} min`,
            minutes: diffMinutes,
            passengerLoad: null,
            isDelayed: (t.departureDelay || 0) > 120,
            isLive: Boolean(t.realtime)
          });
        }
      }
      fallbackList.sort((a, b) => a.minutes - b.minutes);
      results.predictions = fallbackList.slice(0, 8);
    }
  } catch (err) {
    console.warn(`[Predictions] OTP fallback error for stop ${stopIdParam}:`, err.message);
  }

  res.json(results);
});

// Canceled Trips Endpoint
app.get('/api/trips/canceled', async (req, res) => {
  const data = await getCanceledTrips();
  res.json(data);
});

// Live Fleet Overview (parallel batching for all active buses)
app.get('/api/fleet', async (req, res) => {
  const now = Date.now();
  if (now - liveVehiclesCache.timestamp < 6000 && liveVehiclesCache.data.length > 0) {
    return res.json(liveVehiclesCache.data);
  }

  const targetRoutes = routesCache.length > 0
    ? routesCache.slice(0, 40).map(r => r.routeId)
    : ['1T', '51A', '51B', '72', '72M', '72R', '6', '18', '88', '40', '14', '20', '73', 'F', 'NL', 'O', 'W'];

  try {
    const promises = targetRoutes.map(async (rid) => {
      try {
        const vList = await fetchJson(`${ACT_API_BASE}/route/${encodeURIComponent(rid)}/vehicles?token=${ACT_TOKEN}`);
        if (!Array.isArray(vList)) return [];
        return vList.map(v => ({
          vehicleId: v.VehicleId,
          tripId: v.CurrentTripId,
          routeId: rid,
          lat: v.Latitude,
          lon: v.Longitude,
          heading: v.Heading || 0,
          lastReported: v.TimeLastReported
        }));
      } catch (e) {
        return [];
      }
    });

    const results = await Promise.all(promises);
    const flattened = results.flat();
    liveVehiclesCache = { data: flattened, timestamp: now };
    res.json(flattened);
  } catch (err) {
    res.json(liveVehiclesCache.data || []);
  }
});

// Pelias Geocoding / Autocomplete with Smart Stop Grouping & Deduplication
app.get('/api/geocode', async (req, res) => {
  const { query, lat, lon } = req.query;
  if (!query || query.trim().length === 0) {
    return res.json([]);
  }

  const qLower = query.toLowerCase().trim();
  const cleanQ = qLower.replace(/^(line|bus|route)\s+/i, '').trim();

  // 1. Routes match
  const localRouteMatches = routesCache
    .filter(r => {
      const rLower = r.name.toLowerCase();
      return rLower === cleanQ || rLower === qLower ||
             rLower.startsWith(cleanQ) ||
             r.description.toLowerCase().includes(cleanQ);
    })
    .slice(0, 4)
    .map(r => ({
      id: `route_${r.routeId}`,
      name: `Line ${r.name}`,
      label: `Line ${r.name} - ${r.description}`,
      type: 'route',
      routeId: r.routeId,
      color: r.color,
      category: r.category
    }));

  // 2. Smart clustered & deduplicated stops
  const localStopMatches = groupAndDeduplicateStops(stopsCache, cleanQ || query);

  try {
    const focusLat = lat || 37.8044;
    const focusLon = lon || -122.2711;
    const peliasUrl = `${PELIAS_BASE}/autocomplete?api_key=&text=${encodeURIComponent(query)}&focus.point.lat=${focusLat}&focus.point.lon=${focusLon}&boundary.rect.min_lat=37.2445&boundary.rect.min_lon=-123.2&boundary.rect.max_lat=38.5026&boundary.rect.max_lon=-121`;
    const peliasData = await fetchJson(peliasUrl);
    const features = peliasData?.features || [];

    const stopNameSet = new Set(localStopMatches.map(s => s.name.toLowerCase().trim()));
    const routeNameSet = new Set(localRouteMatches.map(r => r.name.toLowerCase().trim()));

    const placeMatches = features
      .filter(f => {
        const layer = (f.properties?.layer || '').toLowerCase();
        const val = (f.properties?.osm_value || '').toLowerCase();
        if (['bus_stop', 'bus_station', 'station', 'stop', 'tram_stop', 'platform'].includes(val)) return false;
        if (layer === 'station') return false;
        return true;
      })
      .map(f => ({
        id: f.properties.id || f.properties.gid,
        name: f.properties.name,
        label: f.properties.label || f.properties.name,
        city: f.properties.locality || f.properties.county || 'Bay Area',
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        type: 'place'
      }))
      .filter(p => {
        const pLower = (p.name || '').toLowerCase().trim();
        if (stopNameSet.has(pLower) || routeNameSet.has(pLower)) return false;
        for (const s of localStopMatches) {
          const sLower = s.name.toLowerCase().trim();
          if (sLower.includes(pLower) || pLower.includes(sLower) || (pLower.includes('bart') && sLower.includes('bart'))) {
            const dist = getDistanceMeters(s.lat, s.lon, p.lat, p.lon);
            if (dist < 1500) return false;
          }
        }
        return true;
      })
      .slice(0, 4);

    res.json([...localRouteMatches, ...localStopMatches, ...placeMatches]);
  } catch (err) {
    res.json([...localRouteMatches, ...localStopMatches]);
  }
});

// Trip Planner (Google Maps Directions) with Canceled Trips & Realignment Exclusion
app.get('/api/plan', async (req, res) => {
  const {
    from, // "lat,lon" or "name::lat,lon"
    to,   // "lat,lon" or "name::lat,lon"
    date, // YYYY-MM-DD
    time, // HH:MM or HH:MMam/pm
    arriveBy = 'false',
    mode = 'WALK,BUS,TRAM,RAIL,SUBWAY,FERRY',
    maxWalkDistance = '1609',
    wheelchair = 'false'
  } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: 'Missing required from or to parameters' });
  }

  try {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const h12 = now.getHours() % 12 || 12;
    const defaultTime = `${h12}:${pad(now.getMinutes())}${now.getHours() < 12 ? 'am' : 'pm'}`;
    const effectiveDate = date || defaultDate;
    const effectiveTime = time || defaultTime;

    const params = new URLSearchParams({
      fromPlace: from,
      toPlace: to,
      arriveBy: String(arriveBy),
      mode,
      maxWalkDistance,
      optimize: 'QUICK',
      bannedAgencies: 'ACREALIGN',
      walkSpeed: '1.34',
      ignoreRealtimeUpdates: 'false',
      showIntermediateStops: 'true',
      numItineraries: '6',
      wheelchair: String(wheelchair),
      date: effectiveDate,
      time: effectiveTime
    });

    const canceledTrips = await getCanceledTrips().catch(() => []);
    const canForLeg = (leg) => {
      if (!leg || leg.mode !== 'BUS') return null;
      const routeAlpha = String(leg.routeShortName || leg.route || '').toUpperCase();
      for (const c of canceledTrips) {
        if (String(c.RouteAlpha || '').toUpperCase() !== routeAlpha) continue;
        if (c.TripStartTime && leg.startTime) {
          const cStart = Date.parse(c.TripStartTime);
          if (cStart && Math.abs(cStart - leg.startTime) < 20 * 60000) {
            return 'yes';
          }
        }
      }
      return null;
    };

    let data = null;
    try {
      const otpUrl = `${OTP_BASE}/plan?${params.toString()}`;
      data = await fetchJson(otpUrl);
    } catch (e) {
      console.warn('[Server OTP] Primary plan failed, trying fallback mode:', e.message);
    }

    if (!data || data.error || !data.plan?.itineraries?.length) {
      try {
        params.set('mode', 'WALK,BUS');
        params.set('maxWalkDistance', '2500');
        const fallbackUrl = `${OTP_BASE}/plan?${params.toString()}`;
        const fallbackData = await fetchJson(fallbackUrl);
        if (fallbackData?.plan?.itineraries?.length) {
          data = fallbackData;
        }
      } catch (e) {}
    }

    const itineraries = data?.plan?.itineraries || [];
    const formatted = itineraries.map((itin, index) => {
      let itinHasCanceled = false;
      const legs = (itin.legs || []).map(leg => {
        let routeMeta = null;
        if (leg.mode === 'BUS' && (leg.route || leg.routeShortName)) {
          const rId = leg.routeShortName || leg.route;
          routeMeta = routesById.get(rId.toUpperCase()) || {
            routeId: rId,
            name: rId,
            color: leg.routeColor ? `#${leg.routeColor}` : '#0072CE',
            textColor: leg.routeTextColor ? `#${leg.routeTextColor}` : '#FFFFFF'
          };
        }

        const isCanceled = canForLeg(leg) === 'yes';
        if (isCanceled) itinHasCanceled = true;

        return {
          mode: leg.mode,
          route: leg.routeShortName || leg.route || '',
          routeShortName: leg.routeShortName || leg.route || '',
          routeLongName: leg.routeLongName || routeMeta?.description || '',
          headsign: leg.headsign || '',
          agencyName: leg.agencyName || 'AC TRANSIT',
          color: routeMeta ? routeMeta.color : (leg.mode === 'WALK' ? '#78909C' : '#0072CE'),
          textColor: routeMeta ? routeMeta.textColor : '#FFFFFF',
          durationSeconds: leg.duration,
          durationMinutes: Math.round(leg.duration / 60),
          distanceMeters: Math.round(leg.distance),
          startTime: leg.startTime,
          endTime: leg.endTime,
          isCanceled,
          from: {
            name: leg.from?.name || 'Origin',
            stopId: leg.from?.stopId?.split(':')?.[1] || leg.from?.stopId || null,
            lat: leg.from?.lat,
            lon: leg.from?.lon,
            departureTime: leg.from?.departureTime
          },
          to: {
            name: leg.to?.name || 'Destination',
            stopId: leg.to?.stopId?.split(':')?.[1] || leg.to?.stopId || null,
            lat: leg.to?.lat,
            lon: leg.to?.lon,
            arrivalTime: leg.to?.arrivalTime
          },
          intermediateStopsCount: (leg.intermediateStops || []).length,
          intermediateStops: (leg.intermediateStops || []).map(st => ({
            name: st.name,
            stopId: st.stopId?.split(':')?.[1] || st.stopId,
            lat: st.lat,
            lon: st.lon,
            arrivalTime: st.arrivalTime
          })),
          coordinates: leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points) : [],
          steps: (leg.steps || []).map(step => ({
            instruction: `${step.relativeDirection || 'Continue'} on ${step.streetName || 'path'}`,
            distanceMeters: Math.round(step.distance),
            absoluteDirection: step.absoluteDirection
          }))
        };
      });

      return {
        id: `itin_${index}`,
        durationSeconds: itin.duration,
        durationMinutes: Math.round(itin.duration / 60),
        startTime: itin.startTime,
        endTime: itin.endTime,
        walkTimeMinutes: Math.round((itin.walkTime || 0) / 60),
        transitTimeMinutes: Math.round(((itin.duration || 0) - (itin.walkTime || 0) - (itin.waitingTime || 0)) / 60),
        walkDistanceMeters: Math.round(itin.walkDistance || 0),
        walkDistanceMiles: +((itin.walkDistance || 0) / 1609.34).toFixed(2),
        transfers: itin.transfers || 0,
        hasCanceledBus: itinHasCanceled,
        fare: itin.fare?.fare?.regular?.cents ? `$${(itin.fare.fare.regular.cents / 100).toFixed(2)}` : '$2.50',
        legs
      };
    });

    res.json({
      from: data?.plan?.from,
      to: data?.plan?.to,
      itineraries: formatted
    });

  } catch (err) {
    console.error('[Plan] OTP Error:', err.message);
    res.status(500).json({ error: 'Failed to plan route', details: err.message });
  }
});

// Proxy vector map style with CORS & rewritten URLs
app.get('/api/map/style.json', async (req, res) => {
  try {
    const style = await fetchJson(`${MAPS_BASE}/styles/positron/style.json`);
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}/api/map`;

    // Rewrite source tile URL
    if (style.sources?.openmaptiles?.url) {
      style.sources.openmaptiles.url = `${baseUrl}/data/openmaptiles.json`;
    }
    if (style.sprite) {
      style.sprite = `${baseUrl}/styles/positron/sprite`;
    }
    if (style.glyphs) {
      style.glyphs = `${baseUrl}/fonts/{fontstack}/{range}.pbf`;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(style);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch style', details: err.message });
  }
});

// Proxy tileJSON
app.get('/api/map/data/openmaptiles.json', async (req, res) => {
  try {
    const tileJson = await fetchJson(`${MAPS_BASE}/data/openmaptiles.json`);
    const host = req.get('host');
    const protocol = req.protocol;
    tileJson.tiles = [`${protocol}://${host}/api/map/data/openmaptiles/{z}/{x}/{y}.pbf`];

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(tileJson);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tilejson', details: err.message });
  }
});

// Proxy all map assets (.pbf tiles, fonts, sprites)
app.use('/api/map', async (req, res, next) => {
  // If it matches style.json or data/openmaptiles.json, let those specific routes handle it
  if (req.path === '/style.json' || req.path === '/data/openmaptiles.json') {
    return next();
  }
  const mapPath = req.path.replace(/^\//, '');
  const targetUrl = `${MAPS_BASE}/${mapPath}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ACTransitMaps/1.0'
      }
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (response.headers.has('content-type')) {
      res.setHeader('Content-Type', response.headers.get('content-type'));
    }

    if (targetUrl.endsWith('.pbf')) {
      res.setHeader('Content-Type', 'application/x-protobuf');
    }

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(404).send('Not found');
  }
});

// Serve frontend static files from root and public
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, async () => {
  console.log(`===============================================`);
  console.log(`  AC Transit Maps Web Server Running!          `);
  console.log(`  Local URL: http://localhost:${PORT}          `);
  console.log(`===============================================`);
  await initData();
});
