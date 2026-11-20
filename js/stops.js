/**
 * AC Transit Maps — Stops & Real-Time Departures Controller
 * Live countdown arrivals powered by Bustime & OpenTripPlanner,
 * nearby stop detection, and bookmarking.
 */

import { api } from './api.js';

export class StopsController {
  constructor(mapController, app) {
    this.map = mapController;
    this.app = app;
    this.currentStop = null;
    this.refreshTimer = null;
    this.nearbyStops = [];
  }

  init() {
    this.stopCard = document.getElementById('stop-details-card');
    this.nearbyList = document.getElementById('nearby-list');
    this.refreshNearbyBtn = document.getElementById('refresh-nearby-btn');

    if (this.refreshNearbyBtn) {
      this.refreshNearbyBtn.addEventListener('click', () => this.loadNearbyStops());
    }
  }

  // Inspect a specific stop by ID or object
  async inspectStop(stopOrId) {
    let stop = stopOrId;
    if (typeof stopOrId === 'string' || typeof stopOrId === 'number') {
      try {
        stop = await api.getStop(stopOrId);
      } catch (err) {
        this.app.showToast('Could not load stop details.');
        return;
      }
    }

    if (!stop) return;
    this.currentStop = stop;

    // Show stop on map
    this.map.setSelectedStop(stop);
    this.map.flyTo([stop.lon, stop.lat], 16);

    const isHub = Boolean(stop.isHub || (stop.allStopIds && stop.allStopIds.length > 1));
    const subtitle = isHub
      ? (stop.label || `${stop.city || 'East Bay'} Transit Center`)
      : `Stop #${stop.code || stop.stopId} • ${stop.city || 'East Bay'}`;

    // Render stop card UI
    this.app.openPanel('view-stop', stop.name, subtitle);
    this._renderStopCard(stop);

    // Fetch initial predictions & start auto-refresh polling
    const queryIds = stop.allStopIds ? stop.allStopIds.join(',') : (stop.stopId || stop.code);
    this.fetchPredictions(queryIds);
    this._startPolling(queryIds);
  }

  _startPolling(stopId) {
    this._stopPolling();
    this.refreshTimer = setInterval(() => {
      this.fetchPredictions(stopId, true);
    }, 12000);
  }

  _stopPolling() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  _renderStopCard(stop) {
    const isSaved = this.app.isSaved('stops', stop.stopId || stop.code);
    const isHub = Boolean(stop.isHub || (stop.allStopIds && stop.allStopIds.length > 1));
    const stopCount = stop.stopCount || (stop.allStopIds ? stop.allStopIds.length : 1);

    this.stopCard.innerHTML = `
      <div class="stop-card-header">
        <span class="stop-code-badge ${isHub ? 'badge-hub' : ''}">
          ${isHub ? `TRANSIT CENTER · ${stopCount} BAYS` : `STOP #${stop.code || stop.stopId}`}
        </span>
        <h3 class="stop-main-name">${stop.name}</h3>
        <p style="font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;">
          ${isHub ? (stop.label || `${stop.city || 'East Bay'} Transit Center`) : (stop.city || 'East Bay, CA')}
        </p>

        <div class="stop-actions-row">
          <button class="btn-primary" id="stop-dir-to-btn">
            <i data-lucide="navigation"></i> Directions
          </button>
          <button class="btn-secondary" id="stop-save-btn">
            <i data-lucide="${isSaved ? 'bookmark-check' : 'bookmark'}"></i>
            <span>${isSaved ? 'Saved' : 'Save'}</span>
          </button>
          <button class="btn-secondary" id="stop-dir-from-btn" title="Directions from here">
            <i data-lucide="arrow-up-right"></i> From
          </button>
        </div>
      </div>

      <div class="departures-section">
        <div class="section-label">
          <span>${isHub ? 'ALL BAY ARRIVALS' : 'REAL-TIME ARRIVALS'}</span>
          <span style="font-size: 11px; font-weight: 500; color: var(--ac-green); display: flex; align-items: center; gap: 4px;">
            <span class="pulse-dot" style="width: 6px; height: 6px;"></span> Official AC Transit Live
          </span>
        </div>
        <div class="departures-list" id="stop-departures-list">
          <div style="text-align: center; padding: 18px; color: var(--text-secondary);">
            Loading live predictions...
          </div>
        </div>
      </div>
    `;

    if (window.lucide) window.lucide.createIcons({ root: this.stopCard });

    // Action handlers
    document.getElementById('stop-dir-to-btn').addEventListener('click', () => {
      this.app.startDirections(null, { name: stop.name, lat: stop.lat, lon: stop.lon });
    });

    document.getElementById('stop-dir-from-btn').addEventListener('click', () => {
      this.app.startDirections({ name: stop.name, lat: stop.lat, lon: stop.lon }, null);
    });

    const saveBtn = document.getElementById('stop-save-btn');
    saveBtn.addEventListener('click', () => {
      const saved = this.app.toggleSave('stops', stop);
      saveBtn.querySelector('span').innerText = saved ? 'Saved' : 'Save';
      this.app.showToast(saved ? 'Stop saved to bookmarks!' : 'Stop removed from bookmarks.');
      if (window.lucide) window.lucide.createIcons({ root: saveBtn });
    });
  }

  async fetchPredictions(stopId, isBackground = false) {
    const listEl = document.getElementById('stop-departures-list');
    if (!listEl) return;

    try {
      const data = await api.getStopPredictions(stopId);
      const prds = data.predictions || [];

      if (prds.length === 0) {
        listEl.innerHTML = `
          <div style="text-align: center; padding: 18px; color: var(--text-muted); font-size: 13px;">
            No upcoming departures scheduled right now.
          </div>
        `;
        return;
      }

      const isMultiStop = String(stopId).includes(',');

      listEl.innerHTML = prds.map(p => {
        const mins = p.minutes;
        const countdownStr = p.countdown || (mins === 0 ? 'Due' : `${mins} min`);
        const delayClass = p.isDelayed ? 'status-delayed' : 'status-on-time';
        const delayText = p.isDelayed ? 'Delayed' : (p.isLive ? 'On Time' : 'Scheduled');

        // Passenger occupancy indicator (EMPTY, HALF_EMPTY, FULL)
        let loadHtml = '';
        if (p.passengerLoad) {
          const n = { EMPTY: 1, HALF_EMPTY: 2, FULL: 3 }[p.passengerLoad] || 0;
          if (n > 0) {
            const c = n === 1 ? '#2bd35f' : n === 2 ? '#f1c40f' : '#ff5a4d';
            loadHtml = `
              <span class="load-pill" title="Passenger load: ${p.passengerLoad}">
                ${[1, 2, 3].map(k => {
                  const f = k <= n ? c : 'rgba(255,255,255,0.2)';
                  return `<svg width="8" height="16" viewBox="0 0 11 22"><circle cx="5.5" cy="4" r="3.5" fill="${f}"/><path d="M1 21V10c0-2 1.5-3.5 4.5-3.5S10 8 10 10v11z" fill="${f}"/></svg>`;
                }).join('')}
              </span>
            `;
          }
        }

        return `
          <div class="departure-row" data-route="${p.route}" data-vid="${p.vehicleId || ''}">
            <div class="dep-route-col">
              <span class="dep-route-badge" style="background-color: var(--ac-blue);">
                ${p.route}
              </span>
              <div class="dep-info">
                <div class="dep-dest">
                  ${p.destination || p.direction}
                  ${p.formattedTime ? `<span class="dep-exact-time">${p.formattedTime}</span>` : ''}
                </div>
                <div class="dep-status">
                  <span class="${delayClass}">● ${delayText}</span>
                  ${p.vehicleId ? `<span class="dep-bus-pill">Bus #${p.vehicleId}</span>` : ''}
                  ${isMultiStop && p.stopId ? `<span class="dep-bay-pill">Bay / Stop #${p.stopId}</span>` : ''}
                  ${loadHtml}
                </div>
              </div>
            </div>
            <div class="dep-time-col">
              <div class="dep-minutes">${countdownStr === 'Due' ? 'Due' : mins}</div>
              <div class="dep-min-label">${countdownStr === 'Due' ? 'Now' : 'min'}</div>
            </div>
          </div>
        `;
      }).join('');

      // Click on departure row to open Route or track bus
      listEl.querySelectorAll('.departure-row').forEach(row => {
        row.addEventListener('click', () => {
          const rId = row.getAttribute('data-route');
          const vid = row.getAttribute('data-vid');
          if (vid && this.app.busTracker) {
            this.app.busTracker.trackVehicle(vid, rId);
          } else if (rId) {
            this.app.routesController.inspectRoute(rId);
          }
        });
      });

    } catch (err) {
      if (!isBackground) {
        listEl.innerHTML = `
          <div style="text-align: center; padding: 16px; color: var(--text-muted);">
            Unable to update departures.
          </div>
        `;
      }
    }
  }

  // Nearby Stops View
  async loadNearbyStops() {
    this.app.openPanel('view-nearby', 'Nearby Stops', 'AC Transit Stops Near You');
    this.nearbyList.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-secondary);">
        Finding nearest stops...
      </div>
    `;

    // Try current map center or geolocation
    let lat = 37.8044;
    let lon = -122.2711;

    if (this.map.map) {
      const center = this.map.map.getCenter();
      lat = center.lat;
      lon = center.lng;
    }

    try {
      const stops = await api.getNearbyStops(lat, lon, 1200, 15);
      this.nearbyStops = stops;

      if (stops.length === 0) {
        this.nearbyList.innerHTML = `
          <div style="text-align: center; padding: 24px; color: var(--text-muted);">
            No AC Transit stops found in this immediate area. Pan the map or search an East Bay address.
          </div>
        `;
        return;
      }

      this.nearbyList.innerHTML = stops.map(s => `
        <div class="route-list-item nearby-item" data-id="${s.stopId}">
          <div class="item-icon-wrapper">
            <i data-lucide="bus"></i>
          </div>
          <div class="route-desc-col">
            <div class="route-item-title">${s.name}</div>
            <div class="route-item-cat">Stop #${s.code} • ${s.city}</div>
          </div>
          <div style="text-align: right; font-size: 12px; font-weight: 700; color: var(--ac-blue);">
            ${s.distanceMiles < 0.1 ? `${s.distanceMeters} m` : `${s.distanceMiles} mi`}
          </div>
        </div>
      `).join('');

      if (window.lucide) window.lucide.createIcons({ root: this.nearbyList });

      this.nearbyList.querySelectorAll('.nearby-item').forEach(el => {
        el.addEventListener('click', () => {
          const sid = el.getAttribute('data-id');
          this.inspectStop(sid);
        });
      });

    } catch (err) {
      this.nearbyList.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #D32F2F;">
          Could not fetch nearby stops.
        </div>
      `;
    }
  }

  destroy() {
    this._stopPolling();
  }
}
