/**
 * AC Transit Maps — Client API Service
 * Dual-Mode Client: Automatically works seamlessly both with local Node.js proxy
 * and as a standalone static application on GitHub Pages!
 */

const ACT_TOKEN = 'E8B5BCE12863B6FF772C0D59FB2843AF';
const ACT_API_BASE = 'https://api.actransit.org/transit';
const OTP_BASE = 'https://tp.actransit.org/otp1/otp/routers/default';

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

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
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

function groupAndDeduplicateStops(stops, query) {
  const qLower = query.toLowerCase().trim();
  const isNumeric = /^\d{4,6}$/.test(qLower);

  // If numeric stop ID, prioritize exact stop ID match
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

  // Filter stops that match the query
  const matches = stops.filter(s => {
    const nameMatch = s.name && s.name.toLowerCase().includes(qLower);
    const codeMatch = s.code && String(s.code) === qLower;
    return nameMatch || codeMatch;
  });

  // Haversine distance in meters
  const distM = (a, b) => {
    const r = Math.PI / 180;
    const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
              Math.cos(a.lat * r) * Math.cos(b.lat * r) *
              Math.sin((b.lon - a.lon) * r / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(x));
  };

  // Group matching stops by canonical name and proximity (< 550 meters)
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

  // Rank groups: exact prefix matches first, then largest multi-stop transit centers/hubs
  groups.sort((a, b) => {
    const aStarts = a.normName.startsWith(qLower);
    const bStarts = b.normName.startsWith(qLower);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return b.stops.length - a.stops.length;
  });

  // Return top deduplicated stop groups
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
        label: `Stop #${s.code || s.stopId} · ${s.city || 'East Bay'}`,
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

class ApiService {
  constructor() {
    this.isStatic = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    this.staticRoutes = null;
    this.staticStops = null;
    this.staticStopsById = new Map();
  }

  async _ensureStaticData() {
    if (!this.staticRoutes) {
      try {
        const res = await fetch('./data/routes.json');
        this.staticRoutes = await res.json();
      } catch (e) {
        this.staticRoutes = [];
      }
    }
    if (!this.staticStops) {
      try {
        const res = await fetch('./data/stops.json');
        this.staticStops = await res.json();
        this.staticStops.forEach(s => {
          this.staticStopsById.set(s.stopId, s);
          this.staticStopsById.set(s.code, s);
        });
      } catch (e) {
        this.staticStops = [];
      }
    }
  }

  async request(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.keys(params).forEach(k => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        url.searchParams.append(k, params[k]);
      }
    });

    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      throw new Error(`API Error ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  }

  // ----------------- Routes -----------------
  async getRoutes(category = '', search = '') {
    if (this.isStatic) {
      await this._ensureStaticData();
      let results = this.staticRoutes || [];
      if (category && category !== 'all') {
        results = results.filter(r => r.category.toLowerCase() === category.toLowerCase());
      }
      if (search) {
        const q = search.toLowerCase().trim();
        results = results.filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
      }
      return results;
    }
    return this.request('/api/routes', { category, search });
  }

  async getRoute(routeId) {
    if (this.isStatic) {
      await this._ensureStaticData();
      const id = routeId.toUpperCase();
      const found = (this.staticRoutes || []).find(r => r.routeId.toUpperCase() === id);
      if (!found) throw new Error('Route not found');
      return found;
    }
    return this.request(`/api/routes/${encodeURIComponent(routeId)}`);
  }

  async getRouteStops(routeId) {
    if (this.isStatic) {
      const url = `${ACT_API_BASE}/route/${encodeURIComponent(routeId)}/stops?token=${ACT_TOKEN}`;
      const res = await fetch(url);
      return await res.json();
    }
    return this.request(`/api/routes/${encodeURIComponent(routeId)}/stops`);
  }

  async getRouteVehicles(routeId) {
    if (this.isStatic) {
      const url = `${ACT_API_BASE}/route/${encodeURIComponent(routeId)}/vehicles?token=${ACT_TOKEN}`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        return (Array.isArray(data) ? data : []).map(v => ({
          vehicleId: v.VehicleId,
          tripId: v.CurrentTripId,
          routeId,
          lat: v.Latitude,
          lon: v.Longitude,
          heading: v.Heading || 0,
          lastReported: v.TimeLastReported
        }));
      } catch {
        return [];
      }
    }
    return this.request(`/api/routes/${encodeURIComponent(routeId)}/vehicles`);
  }

  async getRouteShape(routeId) {
    if (this.isStatic) {
      // Connect stops as fallback shape
      const stopsData = await this.getRouteStops(routeId);
      const shapes = (stopsData || []).map(d => ({
        direction: d.Direction,
        destination: d.Destination,
        coordinates: (d.Stops || []).map(s => [s.Longitude, s.Latitude])
      }));
      return { routeId, shapes };
    }
    return this.request(`/api/routes/${encodeURIComponent(routeId)}/shape`);
  }

  async getRouteSchedule(routeId) {
    if (this.isStatic) {
      const url = `${ACT_API_BASE}/route/${encodeURIComponent(routeId)}/schedule?token=${ACT_TOKEN}`;
      const res = await fetch(url);
      return await res.json();
    }
    return this.request(`/api/routes/${encodeURIComponent(routeId)}/schedule`);
  }

  // ----------------- Stops -----------------
  async getStops(bbox = null, search = '', limit = 500) {
    if (this.isStatic) {
      await this._ensureStaticData();
      let results = this.staticStops || [];
      if (search) {
        const q = search.toLowerCase().trim();
        results = results.filter(s => s.name.toLowerCase().includes(q) || s.code.includes(q) || s.city.toLowerCase().includes(q));
      }
      return results.slice(0, limit);
    }
    const params = { search, limit };
    if (bbox) {
      params.minLat = bbox.minLat;
      params.maxLat = bbox.maxLat;
      params.minLon = bbox.minLon;
      params.maxLon = bbox.maxLon;
    }
    return this.request('/api/stops', params);
  }

  async getNearbyStops(lat, lon, radius = 1000, limit = 15) {
    if (this.isStatic) {
      await this._ensureStaticData();
      const uLat = parseFloat(lat);
      const uLon = parseFloat(lon);
      const nearby = [];
      for (const stop of (this.staticStops || [])) {
        const dist = getDistanceMeters(uLat, uLon, stop.lat, stop.lon);
        if (dist <= radius) {
          nearby.push({
            ...stop,
            distanceMeters: Math.round(dist),
            distanceMiles: +(dist / 1609.34).toFixed(2)
          });
        }
      }
      nearby.sort((a, b) => a.distanceMeters - b.distanceMeters);
      return nearby.slice(0, limit);
    }
    return this.request('/api/stops/nearby', { lat, lon, radius, limit });
  }

  async getStop(stopId) {
    if (this.isStatic) {
      await this._ensureStaticData();
      const id = parseInt(stopId, 10);
      const stop = this.staticStopsById.get(id) || this.staticStopsById.get(String(stopId));
      if (!stop) throw new Error('Stop not found');
      return stop;
    }
    return this.request(`/api/stops/${encodeURIComponent(stopId)}`);
  }

  async getStopPredictions(stopId) {
    const ids = Array.isArray(stopId) 
      ? stopId 
      : String(stopId).split(',').map(s => s.trim()).filter(Boolean);

    if (this.isStatic) {
      try {
        const prdList = [];
        // Batch in groups of up to 10 stop IDs as supported by AC Transit Bustime
        for (let i = 0; i < ids.length; i += 10) {
          const chunk = ids.slice(i, i + 10);
          const url = `${ACT_API_BASE}/actrealtime/prediction?stpid=${chunk.join(',')}&token=${ACT_TOKEN}`;
          const res = await fetch(url);
          const data = await res.json();
          const items = data?.['bustime-response']?.prd || [];
          if (Array.isArray(items)) prdList.push(...items);
        }

        const predictions = prdList.map(p => {
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

        predictions.sort((a, b) => a.minutes - b.minutes);
        return { stopId: ids.join(','), timestamp: new Date().toISOString(), predictions };
      } catch (err) {
        console.warn('[API] getStopPredictions static error:', err);
        return { stopId: ids.join(','), timestamp: new Date().toISOString(), predictions: [] };
      }
    }
    return this.request(`/api/stops/${encodeURIComponent(ids.join(','))}/predictions`);
  }

  // ----------------- Canceled Trips -----------------
  async getCanceledTrips() {
    if (this._canceledTripsCache && (Date.now() - (this._canceledTripsTime || 0) < 45000)) {
      return this._canceledTripsCache;
    }
    const pad = n => String(n).padStart(2, '0');
    const fDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    const tFrom = fDate(new Date(now.getTime() - 2 * 3600000));
    const tTo = fDate(new Date(now.getTime() + 10 * 3600000));

    if (this.isStatic) {
      try {
        const url = `${ACT_API_BASE}/trips/canceled?tripDateTimeFrom=${tFrom}&tripDateTimeTo=${tTo}&token=${ACT_TOKEN}`;
        const res = await fetch(url);
        const data = await res.json();
        this._canceledTripsCache = Array.isArray(data) ? data : [];
        this._canceledTripsTime = Date.now();
        return this._canceledTripsCache;
      } catch (err) {
        console.warn('[API] Canceled trips fetch error:', err);
        return [];
      }
    }
    try {
      const data = await this.request('/api/trips/canceled');
      this._canceledTripsCache = Array.isArray(data) ? data : [];
      this._canceledTripsTime = Date.now();
      return this._canceledTripsCache;
    } catch {
      return [];
    }
  }

  // ----------------- Live Fleet -----------------
  async getLiveFleet() {
    if (this.isStatic) {
      const targetRoutes = ['1T', '51A', '51B', '72', '72M', '72R', '6', '18', '88', '40', '14', '20', '73', 'F', 'NL', 'O', 'W'];
      const promises = targetRoutes.map(async (rid) => {
        try {
          const res = await fetch(`${ACT_API_BASE}/route/${encodeURIComponent(rid)}/vehicles?token=${ACT_TOKEN}`);
          const vList = await res.json();
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
        } catch {
          return [];
        }
      });
      const results = await Promise.all(promises);
      return results.flat();
    }
    return this.request('/api/fleet');
  }

  // ----------------- Autocomplete & Geocoding -----------------
  async getGeocode(query, lat = null, lon = null) {
    if (this.isStatic) {
      await this._ensureStaticData();
      const qLower = query.toLowerCase().trim();
      const cleanQ = qLower.replace(/^(line|bus|route)\s+/i, '').trim();

      const localRouteMatches = (this.staticRoutes || [])
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

      // Smart clustering & deduplication of stops
      const localStopMatches = groupAndDeduplicateStops(this.staticStops || [], cleanQ || query);

      try {
        const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&bbox=-123.2,37.24,-121,38.5&limit=8`;
        const pRes = await fetch(photonUrl);
        const pData = await pRes.json();

        const stopNameSet = new Set(localStopMatches.map(s => s.name.toLowerCase().trim()));
        const routeNameSet = new Set(localRouteMatches.map(r => r.name.toLowerCase().trim()));

        const placeMatches = (pData.features || [])
          .filter(f => {
            const val = (f.properties?.osm_value || '').toLowerCase();
            return !['bus_stop', 'bus_station', 'station', 'stop', 'tram_stop', 'platform'].includes(val);
          })
          .map(f => ({
            id: f.properties.osm_id || Math.random(),
            name: f.properties.name || f.properties.street || query,
            label: [f.properties.name, f.properties.street, f.properties.city].filter(Boolean).join(', '),
            city: f.properties.city || 'Bay Area',
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            type: 'place'
          }))
          .filter(p => {
            const pLower = p.name.toLowerCase().trim();
            // Suppress place if identical to a transit stop or route
            if (stopNameSet.has(pLower) || routeNameSet.has(pLower)) return false;
            // Also suppress if transit stop name contains place name and is within 1.5km
            for (const s of localStopMatches) {
              const sLower = s.name.toLowerCase().trim();
              if (sLower.includes(pLower) || pLower.includes(sLower) || (pLower.includes('bart') && sLower.includes('bart'))) {
                const dist = Math.hypot(s.lat - p.lat, s.lon - p.lon) * 111000;
                if (dist < 1500) return false;
              }
            }
            return true;
          })
          .slice(0, 4);

        return [...localRouteMatches, ...localStopMatches, ...placeMatches];
      } catch {
        return [...localRouteMatches, ...localStopMatches];
      }
    }
    return this.request('/api/geocode', { query, lat, lon });
  }

  // ----------------- Trip Planning -----------------
  async planTrip(options = {}) {
    if (this.isStatic) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const h12 = now.getHours() % 12 || 12;
      const defaultTime = `${h12}:${pad(now.getMinutes())}${now.getHours() < 12 ? 'am' : 'pm'}`;
      
      const params = new URLSearchParams({
        fromPlace: options.from,
        toPlace: options.to,
        arriveBy: String(options.arriveBy || 'false'),
        mode: options.mode || 'WALK,BUS,TRAM,RAIL,SUBWAY,FERRY',
        maxWalkDistance: options.maxWalkDistance || '1609',
        optimize: 'QUICK',
        bannedAgencies: 'ACREALIGN',
        walkSpeed: '1.34',
        ignoreRealtimeUpdates: 'false',
        showIntermediateStops: 'true',
        numItineraries: '6',
        wheelchair: String(options.wheelchair || 'false'),
        date: options.date || defaultDate,
        time: options.time || defaultTime
      });

      const canceledTrips = await this.getCanceledTrips().catch(() => []);
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
      let lastError = null;
      try {
        const res = await fetch(`${OTP_BASE}/plan?${params.toString()}`);
        if (res.ok) {
          data = await res.json();
        } else {
          lastError = new Error(`Planner returned HTTP ${res.status}`);
        }
      } catch (err) {
        lastError = err;
        console.warn('[API] Direct OTP fetch error:', err);
      }

      // Retry with simplified mode if needed
      if (!data || data.error || !data.plan?.itineraries?.length) {
        try {
          params.set('mode', 'WALK,BUS');
          params.set('maxWalkDistance', '2500');
          const fallbackRes = await fetch(`${OTP_BASE}/plan?${params.toString()}`);
          if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json();
            if (fallbackData?.plan?.itineraries?.length) {
              data = fallbackData;
            }
          }
        } catch (e) {}
      }

      if (!data || data.error || !data.plan?.itineraries?.length) {
        const msg = data?.error?.msg || lastError?.message || 'No direct transit routes found for this time. Try setting time to 3:00 PM or Leave Now.';
        throw new Error(msg);
      }
      const itineraries = data?.plan?.itineraries || [];

      const formatted = itineraries.map((itin, index) => {
        let itinHasCanceled = false;
        const legs = (itin.legs || []).map(leg => {
          const rId = leg.routeShortName || leg.route || '';
          const decodedCoords = leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points) : [];
          const isCanceled = canForLeg(leg) === 'yes';
          if (isCanceled) itinHasCanceled = true;

          return {
            mode: leg.mode,
            route: rId,
            routeShortName: rId,
            routeLongName: leg.routeLongName || '',
            headsign: leg.headsign || '',
            agencyName: leg.agencyName || 'AC TRANSIT',
            color: leg.routeColor ? `#${leg.routeColor}` : (leg.mode === 'WALK' ? '#78909C' : '#0072CE'),
            textColor: leg.routeTextColor ? `#${leg.routeTextColor}` : '#FFFFFF',
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
            coordinates: decodedCoords,
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

      return {
        from: data?.plan?.from,
        to: data?.plan?.to,
        itineraries: formatted
      };
    }
    return this.request('/api/plan', options);
  }
}

export const api = new ApiService();
