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
    if (this.isStatic) {
      const url = `${ACT_API_BASE}/actrealtime/prediction?stpid=${encodeURIComponent(stopId)}&token=${ACT_TOKEN}`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        const prdList = data?.['bustime-response']?.prd || [];
        const predictions = prdList.map(p => {
          let minutes = null;
          if (p.prdtm) {
            const parts = p.prdtm.split(' ');
            if (parts.length === 2) {
              const timeParts = parts[1].split(':');
              const now = new Date();
              const predDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(timeParts[0], 10), parseInt(timeParts[1], 10));
              minutes = Math.max(0, Math.round((predDate.getTime() - Date.now()) / 60000));
            }
          }
          return {
            route: p.rt,
            direction: p.rtdir,
            destination: p.des,
            vehicleId: p.vid,
            predictedTime: p.prdtm,
            minutes: minutes !== null ? minutes : (p.dstp ? Math.round(p.dstp / 500) : 0),
            isDelayed: Boolean(p.dly),
            isLive: true
          };
        });
        predictions.sort((a, b) => a.minutes - b.minutes);
        return { stopId, timestamp: new Date().toISOString(), predictions };
      } catch {
        return { stopId, timestamp: new Date().toISOString(), predictions: [] };
      }
    }
    return this.request(`/api/stops/${encodeURIComponent(stopId)}/predictions`);
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

      const localRouteMatches = (this.staticRoutes || [])
        .filter(r => r.name.toLowerCase() === qLower || r.name.toLowerCase().startsWith(qLower) || r.description.toLowerCase().includes(qLower))
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

      const localStopMatches = (this.staticStops || [])
        .filter(s => s.name.toLowerCase().includes(qLower) || s.code === qLower)
        .slice(0, 5)
        .map(s => ({
          id: `stop_${s.stopId}`,
          name: s.name,
          label: `${s.name} (Stop #${s.code})`,
          city: s.city,
          lat: s.lat,
          lon: s.lon,
          type: 'stop',
          stopId: s.stopId
        }));

      try {
        const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&bbox=-123.2,37.24,-121,38.5&limit=5`;
        const pRes = await fetch(photonUrl);
        const pData = await pRes.json();
        const placeMatches = (pData.features || []).map(f => ({
          id: f.properties.osm_id || Math.random(),
          name: f.properties.name || f.properties.street || query,
          label: [f.properties.name, f.properties.street, f.properties.city].filter(Boolean).join(', '),
          city: f.properties.city || 'Bay Area',
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          type: 'place'
        }));
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
      const defaultDate = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
      
      const params = new URLSearchParams({
        fromPlace: options.from,
        toPlace: options.to,
        arriveBy: String(options.arriveBy || 'false'),
        mode: options.mode || 'WALK,BUS,TRAM,RAIL,SUBWAY,FERRY',
        maxWalkDistance: options.maxWalkDistance || '1609',
        optimize: 'QUICK',
        showIntermediateStops: 'true',
        numItineraries: '5',
        wheelchair: String(options.wheelchair || 'false'),
        date: options.date || defaultDate
      });
      if (options.time) params.append('time', options.time);

      const res = await fetch(`${OTP_BASE}/plan?${params.toString()}`);
      const data = await res.json();
      const itineraries = data?.plan?.itineraries || [];

      const formatted = itineraries.map((itin, index) => {
        const legs = (itin.legs || []).map(leg => {
          const rId = leg.routeShortName || leg.route || '';
          const decodedCoords = leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points) : [];
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
