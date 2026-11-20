/**
 * AC Transit Maps — Map Controller
 * Powered by MapLibre GL JS with custom real-time layers, smooth transitions,
 * custom vehicle markers with heading orientation, and multi-modal routing lines.
 */

import * as maplibregl from '../vendor/maplibre-gl.mjs';

// Default Bay Area / East Bay Geographic Center
export const DEFAULT_CENTER = [-122.2711, 37.8044]; // Downtown Oakland
export const DEFAULT_ZOOM = 13;

export class MapController {
  constructor(containerId = 'map') {
    this.containerId = containerId;
    this.map = null;
    this.currentStyle = 'transit';
    this.vehicleMarkers = new Map();
    this.stopMarkers = [];
    this.userLocationMarker = null;
    this.originMarker = null;
    this.destMarker = null;
    this.selectedStopMarker = null;
    this.activePopup = null;
    this.clickCallbacks = [];
  }

  async init() {
    // Styles dictionary
    const isStatic = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    this.styles = {
      transit: isStatic ? 'https://maps.actransit.org/map/styles/positron/style.json' : '/api/map/style.json',
      dark: {
        version: 8,
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
            ],
            tileSize: 256
          }
        },
        layers: [{ id: 'carto-dark-layer', type: 'raster', source: 'carto-dark', minzoom: 0, maxzoom: 19 }]
      },
      satellite: {
        version: 8,
        sources: {
          'esri-satellite': {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256
          }
        },
        layers: [{ id: 'esri-satellite-layer', type: 'raster', source: 'esri-satellite', minzoom: 0, maxzoom: 19 }]
      },
      highcontrast: {
        version: 8,
        sources: {
          'carto-voyager': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'
            ],
            tileSize: 256
          }
        },
        layers: [{ id: 'carto-voyager-layer', type: 'raster', source: 'carto-voyager', minzoom: 0, maxzoom: 19 }]
      }
    };

    return new Promise((resolve, reject) => {
      try {
        this.map = new maplibregl.Map({
          container: this.containerId,
          style: this.styles.transit,
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          pitch: 0,
          bearing: 0,
          attributionControl: false
        });

        this.map.on('load', () => {
          this._initLayers();
          this._bindMapEvents();
          console.log('[Map] MapLibre initialized successfully.');
          resolve(this.map);
        });

        this.map.on('error', (e) => {
          console.warn('[Map] Tile/style warning:', e.error?.message || e);
        });
      } catch (err) {
        console.error('[Map] Map initialization error:', err);
        reject(err);
      }
    });
  }

  // Setup vector GeoJSON sources and styling layers
  _initLayers() {
    if (!this.map) return;

    // 1. Selected Route Layer
    if (!this.map.getSource('selected-route')) {
      this.map.addSource('selected-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      // Route line casing
      this.map.addLayer({
        id: 'selected-route-casing',
        type: 'line',
        source: 'selected-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 8,
          'line-opacity': 0.8
        }
      });

      // Route main stroke
      this.map.addLayer({
        id: 'selected-route-line',
        type: 'line',
        source: 'selected-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 5,
          'line-opacity': 0.95
        }
      });
    }

    // 2. Route Stops Layer
    if (!this.map.getSource('route-stops')) {
      this.map.addSource('route-stops', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      this.map.addLayer({
        id: 'route-stops-circles',
        type: 'circle',
        source: 'route-stops',
        paint: {
          'circle-radius': 5,
          'circle-color': '#FFFFFF',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': ['get', 'color']
        }
      });
    }

    // 3. Directions Multi-modal Itinerary Layers
    if (!this.map.getSource('itinerary-legs')) {
      this.map.addSource('itinerary-legs', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      // Walk legs (dashed)
      this.map.addLayer({
        id: 'itinerary-walk-casing',
        type: 'line',
        source: 'itinerary-legs',
        filter: ['==', 'mode', 'WALK'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 6
        }
      });

      this.map.addLayer({
        id: 'itinerary-walk-line',
        type: 'line',
        source: 'itinerary-legs',
        filter: ['==', 'mode', 'WALK'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#455A64',
          'line-width': 4,
          'line-dasharray': [2, 2]
        }
      });

      // Transit legs (solid vibrant)
      this.map.addLayer({
        id: 'itinerary-transit-casing',
        type: 'line',
        source: 'itinerary-legs',
        filter: ['!=', 'mode', 'WALK'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 8
        }
      });

      this.map.addLayer({
        id: 'itinerary-transit-line',
        type: 'line',
        source: 'itinerary-legs',
        filter: ['!=', 'mode', 'WALK'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 5.5
        }
      });
    }
  }

  _bindMapEvents() {
    this.map.on('click', (e) => {
      const { lng, lat } = e.lngLat;
      for (const cb of this.clickCallbacks) {
        cb({ lng, lat, point: e.point });
      }
    });

    // Cursor pointer on interactive layers
    this.map.on('mouseenter', 'route-stops-circles', () => {
      this.map.getCanvas().style.cursor = 'pointer';
    });
    this.map.on('mouseleave', 'route-stops-circles', () => {
      this.map.getCanvas().style.cursor = '';
    });
  }

  onMapClick(callback) {
    this.clickCallbacks.push(callback);
  }

  // Switch Map Style
  setStyle(styleKey) {
    if (!this.map || !this.styles[styleKey]) return;
    this.currentStyle = styleKey;
    const targetStyle = this.styles[styleKey];
    this.map.setStyle(targetStyle);
    this.map.once('style.load', () => {
      this._initLayers();
    });
  }

  // Camera Navigation
  flyTo(coords, zoom = 15, pitch = 0, bearing = 0) {
    if (!this.map) return;
    this.map.flyTo({
      center: coords,
      zoom,
      pitch,
      bearing,
      essential: true,
      speed: 1.4,
      curve: 1.2
    });
  }

  fitBounds(coordinates, padding = { top: 60, bottom: 60, left: 440, right: 60 }) {
    if (!this.map || !coordinates || coordinates.length === 0) return;
    
    // On small mobile screens, adjust left padding to top/bottom
    if (window.innerWidth <= 640) {
      padding = { top: 70, bottom: 260, left: 20, right: 20 };
    }

    const bounds = new maplibregl.LngLatBounds();
    coordinates.forEach(coord => bounds.extend(coord));
    this.map.fitBounds(bounds, {
      padding,
      maxZoom: 16.5,
      duration: 1000
    });
  }

  // Draw Route Shape
  setRouteShape(coordinates, color = '#0072CE') {
    if (!this.map) return;
    const source = this.map.getSource('selected-route');
    if (!source) return;

    if (!coordinates || coordinates.length === 0) {
      source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    source.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { color },
        geometry: {
          type: 'LineString',
          coordinates
        }
      }]
    });
  }

  // Set Route Stop Dots
  setRouteStops(stops, color = '#0072CE') {
    if (!this.map) return;
    const source = this.map.getSource('route-stops');
    if (!source) return;

    if (!stops || stops.length === 0) {
      source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const features = stops.map(s => ({
      type: 'Feature',
      properties: {
        stopId: s.StopId || s.stopId,
        name: s.Name || s.name,
        color
      },
      geometry: {
        type: 'Point',
        coordinates: [s.Longitude || s.lon, s.Latitude || s.lat]
      }
    }));

    source.setData({ type: 'FeatureCollection', features });
  }

  // Draw Directions Multi-modal Itinerary Legs
  setItineraryLegs(legs) {
    if (!this.map) return;
    const source = this.map.getSource('itinerary-legs');
    if (!source) return;

    if (!legs || legs.length === 0) {
      source.setData({ type: 'FeatureCollection', features: [] });
      this.clearOriginDestMarkers();
      return;
    }

    const features = legs.map(leg => ({
      type: 'Feature',
      properties: {
        mode: leg.mode,
        route: leg.routeShortName || leg.route,
        color: leg.color || '#0072CE'
      },
      geometry: {
        type: 'LineString',
        coordinates: leg.coordinates
      }
    }));

    source.setData({ type: 'FeatureCollection', features });

    // Place origin & destination pins
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    if (firstLeg && firstLeg.from && firstLeg.from.lon && firstLeg.from.lat) {
      this.setOriginMarker([firstLeg.from.lon, firstLeg.from.lat], firstLeg.from.name);
    }
    if (lastLeg && lastLeg.to && lastLeg.to.lon && lastLeg.to.lat) {
      this.setDestMarker([lastLeg.to.lon, lastLeg.to.lat], lastLeg.to.name);
    }

    // Fit bounds across all legs
    const allCoords = legs.flatMap(l => l.coordinates);
    if (allCoords.length > 0) {
      this.fitBounds(allCoords);
    }
  }

  clearItinerary() {
    this.setItineraryLegs([]);
  }

  // ----------------- Custom Markers -----------------

  // Bus Vehicle Markers (Real-time GPS with rotating heading)
  updateVehicles(vehicles = [], defaultColor = '#0072CE') {
    if (!this.map) return;
    const currentIds = new Set();

    vehicles.forEach(v => {
      const vid = String(v.vehicleId);
      currentIds.add(vid);
      const coords = [v.lon, v.lat];

      if (this.vehicleMarkers.has(vid)) {
        // Smoothly animate marker to new position
        const existing = this.vehicleMarkers.get(vid);
        existing.marker.setLngLat(coords);
        if (existing.headingEl) {
          existing.headingEl.style.transform = `rotate(${v.heading || 0}deg)`;
        }
      } else {
        // Create new Google Maps-style bus vehicle marker showing route and bus number
        const el = document.createElement('div');
        el.className = 'vehicle-marker';
        el.style.backgroundColor = defaultColor;
        el.setAttribute('data-vid', vid);
        el.title = `Bus #${vid} (Line ${v.routeId || 'AC'})`;

        const headingArrow = document.createElement('div');
        headingArrow.className = 'vehicle-heading-arrow';
        headingArrow.style.transform = `rotate(${v.heading || 0}deg)`;

        if (v.routeId) {
          const routePill = document.createElement('span');
          routePill.className = 'vehicle-route-pill';
          routePill.innerText = v.routeId;
          el.appendChild(routePill);
        }

        const busIdSpan = document.createElement('span');
        busIdSpan.className = 'vehicle-bus-id';
        busIdSpan.innerText = `#${vid}`;

        el.appendChild(headingArrow);
        el.appendChild(busIdSpan);

        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(coords)
          .addTo(this.map);

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showVehiclePopup(v, coords);
        });

        this.vehicleMarkers.set(vid, { marker, el, headingEl: headingArrow });
      }
    });

    // Remove old/disappeared buses
    for (const [vid, entry] of this.vehicleMarkers.entries()) {
      if (!currentIds.has(vid)) {
        entry.marker.remove();
        this.vehicleMarkers.delete(vid);
      }
    }
  }

  clearVehicles() {
    this.vehicleMarkers.forEach(entry => entry.marker.remove());
    this.vehicleMarkers.clear();
  }

  showVehiclePopup(vehicle, coords) {
    if (this.activePopup) this.activePopup.remove();

    const popupHtml = `
      <div class="popup-title">Bus #${vehicle.vehicleId} (Line ${vehicle.routeId})</div>
      <div class="popup-desc">
        ${vehicle.tripId ? `<div>Trip #${vehicle.tripId}</div>` : ''}
        <div>Heading: ${vehicle.heading}°</div>
        <div style="margin-top: 4px; color: #00843D; font-weight: 600;">● Active in Service</div>
      </div>
    `;

    this.activePopup = new maplibregl.Popup({ offset: 16, closeButton: true })
      .setLngLat(coords)
      .setHTML(popupHtml)
      .addTo(this.map);
  }

  // Selected Stop Marker
  setSelectedStop(stop) {
    if (this.selectedStopMarker) {
      this.selectedStopMarker.remove();
      this.selectedStopMarker = null;
    }
    if (!stop) return;

    const el = document.createElement('div');
    el.className = 'stop-dot-marker selected';
    el.style.borderColor = '#0072CE';
    el.style.backgroundColor = '#0072CE';
    el.style.transform = 'scale(1.8)';

    this.selectedStopMarker = new maplibregl.Marker({ element: el })
      .setLngLat([stop.lon, stop.lat])
      .addTo(this.map);
  }

  // Origin & Destination Markers for Directions
  setOriginMarker(coords, title = 'Starting point') {
    if (this.originMarker) this.originMarker.remove();

    const el = document.createElement('div');
    el.className = 'marker-dot origin-dot';
    el.style.width = '14px';
    el.style.height = '14px';
    el.title = title;

    this.originMarker = new maplibregl.Marker({ element: el })
      .setLngLat(coords)
      .addTo(this.map);
  }

  setDestMarker(coords, title = 'Destination') {
    if (this.destMarker) this.destMarker.remove();

    const el = document.createElement('div');
    el.className = 'marker-dot dest-dot';
    el.style.width = '14px';
    el.style.height = '14px';
    el.title = title;

    this.destMarker = new maplibregl.Marker({ element: el })
      .setLngLat(coords)
      .addTo(this.map);
  }

  clearOriginDestMarkers() {
    if (this.originMarker) { this.originMarker.remove(); this.originMarker = null; }
    if (this.destMarker) { this.destMarker.remove(); this.destMarker = null; }
  }

  // User Geolocation Pulsing Marker
  setUserLocation(coords) {
    if (this.userLocationMarker) {
      this.userLocationMarker.setLngLat(coords);
      return;
    }

    const container = document.createElement('div');
    container.className = 'user-location-marker';

    const pulse = document.createElement('div');
    pulse.className = 'user-location-pulse';
    container.appendChild(pulse);

    this.userLocationMarker = new maplibregl.Marker({ element: container })
      .setLngLat(coords)
      .addTo(this.map);
  }
}
