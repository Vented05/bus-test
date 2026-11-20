/**
 * AC Transit Maps — Routes Catalog & Inspector
 * Route line alignment shapes, direction switcher, stops timeline,
 * and live GPS vehicle tracking on lines.
 */

import { api } from './api.js';

export class RoutesController {
  constructor(mapController, app) {
    this.map = mapController;
    this.app = app;
    this.routes = [];
    this.currentRoute = null;
    this.currentDirectionIndex = 0;
    this.routeStopsData = [];
    this.vehiclesPollingTimer = null;
  }

  init() {
    this.routesListEl = document.getElementById('routes-list');
    this.routeCardEl = document.getElementById('route-details-card');
    this.catalogFilters = document.getElementById('catalog-filters');

    if (this.catalogFilters) {
      this.catalogFilters.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          this.catalogFilters.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const cat = tab.getAttribute('data-cat');
          this.filterCatalog(cat);
        });
      });
    }
  }

  // Load All Routes Catalog
  async loadRoutesCatalog() {
    this.app.openPanel('view-routes-catalog', 'AC Transit Routes', '120+ Lines across East Bay & Transbay');
    this.routesListEl.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-secondary);">
        Loading route network...
      </div>
    `;

    try {
      this.routes = await api.getRoutes();
      this.filterCatalog('all');
    } catch (err) {
      this.routesListEl.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #D32F2F;">
          Failed to load routes list.
        </div>
      `;
    }
  }

  filterCatalog(category = 'all') {
    let filtered = this.routes;
    if (category !== 'all') {
      filtered = this.routes.filter(r => r.category.toLowerCase() === category.toLowerCase());
    }

    if (filtered.length === 0) {
      this.routesListEl.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--text-muted);">
          No routes found in this category.
        </div>
      `;
      return;
    }

    this.routesListEl.innerHTML = filtered.map(r => `
      <div class="route-list-item" data-id="${r.routeId}">
        <span class="dep-route-badge" style="background-color: ${r.color}; color: ${r.textColor};">
          ${r.name}
        </span>
        <div class="route-desc-col">
          <div class="route-item-title">${r.name} — ${r.description}</div>
          <div class="route-item-cat">${r.category} • Division ${r.division}</div>
        </div>
        <i data-lucide="chevron-right" style="color: var(--text-muted); width: 16px; height: 16px;"></i>
      </div>
    `).join('');

    if (window.lucide) window.lucide.createIcons({ root: this.routesListEl });

    this.routesListEl.querySelectorAll('.route-list-item').forEach(el => {
      el.addEventListener('click', () => {
        const rid = el.getAttribute('data-id');
        this.inspectRoute(rid);
      });
    });
  }

  // Inspect a Route
  async inspectRoute(routeId) {
    this._stopVehiclePolling();
    this.map.clearVehicles();

    try {
      const route = await api.getRoute(routeId);
      this.currentRoute = route;

      this.app.openPanel('view-route', `Line ${route.name}`, route.description);
      
      // Fetch stops & shape in parallel
      const [stopsData, shapeData] = await Promise.all([
        api.getRouteStops(routeId).catch(() => []),
        api.getRouteShape(routeId).catch(() => null)
      ]);

      this.routeStopsData = Array.isArray(stopsData) ? stopsData : [];

      // Render UI Card
      this._renderRouteCard(route, this.routeStopsData);

      // Render Shape on Map
      if (shapeData && shapeData.shapes && shapeData.shapes.length > 0) {
        const primaryShape = shapeData.shapes[0];
        this.map.setRouteShape(primaryShape.coordinates, route.color);
        this.map.fitBounds(primaryShape.coordinates);
      } else if (this.routeStopsData.length > 0 && this.routeStopsData[0].Stops) {
        const coords = this.routeStopsData[0].Stops.map(s => [s.Longitude, s.Latitude]);
        this.map.setRouteShape(coords, route.color);
        this.map.fitBounds(coords);
      }

      // Render stop dots on map
      if (this.routeStopsData.length > 0 && this.routeStopsData[0].Stops) {
        this.map.setRouteStops(this.routeStopsData[0].Stops, route.color);
      }

      // Start live bus GPS tracking on this route
      this._pollVehicles(routeId, route.color);
      this.vehiclesPollingTimer = setInterval(() => {
        this._pollVehicles(routeId, route.color);
      }, 9000);

    } catch (err) {
      console.error('[Routes] Route inspect error:', err);
      this.app.showToast('Could not load line details.');
    }
  }

  _renderRouteCard(route, stopsData) {
    const isSaved = this.app.isSaved('routes', route.routeId);

    // Direction tabs
    const dirTabsHtml = stopsData.map((d, idx) => `
      <button class="dir-tab-btn ${idx === 0 ? 'active' : ''}" data-index="${idx}">
        ${d.Destination || d.Direction}
      </button>
    `).join('');

    // Stops timeline for first direction
    const initialStops = stopsData.length > 0 && stopsData[0].Stops ? stopsData[0].Stops : [];
    const timelineHtml = this._buildStopsTimelineHtml(initialStops);

    this.routeCardEl.innerHTML = `
      <div class="route-header-banner" style="background-color: ${route.color};">
        <span class="route-banner-badge">${route.name}</span>
        <div class="route-banner-title">${route.description}</div>
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.9;">
          ${route.category} Line • Division ${route.division}
        </div>
      </div>

      <div style="display: flex; gap: 8px; margin-bottom: 12px;">
        <button class="btn-start-nav" id="route-start-btn" style="flex: 1;">
          <i data-lucide="navigation"></i> Start Route
        </button>
        <button class="btn-secondary" id="route-schedule-btn">
          <i data-lucide="calendar"></i> Timetable
        </button>
        <button class="btn-secondary" id="route-save-btn">
          <i data-lucide="${isSaved ? 'bookmark-check' : 'bookmark'}"></i>
          <span>${isSaved ? 'Saved' : 'Save'}</span>
        </button>
      </div>

      <!-- Active Buses by Number List -->
      <div id="route-buses-by-number" style="margin-bottom: 10px;"></div>

      <div class="direction-tabs" id="route-direction-tabs">
        ${dirTabsHtml}
      </div>

      <div class="section-label" style="margin-bottom: 8px;">
        <span>STOPS ALONG THIS LINE</span>
        <span id="route-active-buses-label" style="font-size: 11.5px; color: var(--ac-green); font-weight: 600;">
          Tracking buses...
        </span>
      </div>

      <div class="stops-timeline" id="route-stops-timeline">
        ${timelineHtml}
      </div>
    `;

    if (window.lucide) window.lucide.createIcons({ root: this.routeCardEl });

    // Direction switcher
    this.routeCardEl.querySelectorAll('.dir-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.routeCardEl.querySelectorAll('.dir-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        this.switchDirection(idx);
      });
    });

    // Start Route Navigation Button
    const startBtn = document.getElementById('route-start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const stops = (stopsData.length > 0 && stopsData[0].Stops) ? stopsData[0].Stops : [];
        if (stops.length >= 2) {
          const first = stops[0];
          const last = stops[stops.length - 1];
          this.app.startDirections(
            { name: first.Name, lat: first.Latitude, lon: first.Longitude },
            { name: last.Name, lat: last.Latitude, lon: last.Longitude }
          );
        } else {
          this.app.startDirections(null, null);
        }
      });
    }

    // Schedule modal button
    document.getElementById('route-schedule-btn').addEventListener('click', () => {
      this.openScheduleModal(route.routeId);
    });

    // Save button
    const saveBtn = document.getElementById('route-save-btn');
    saveBtn.addEventListener('click', () => {
      const saved = this.app.toggleSave('routes', route);
      saveBtn.querySelector('span').innerText = saved ? 'Saved' : 'Save';
      this.app.showToast(saved ? 'Line saved to bookmarks!' : 'Line removed from bookmarks.');
      if (window.lucide) window.lucide.createIcons({ root: saveBtn });
    });

    this._bindStopNodeClicks();
  }

  _buildStopsTimelineHtml(stops) {
    if (!stops || stops.length === 0) {
      return '<div style="color: var(--text-muted); padding: 12px;">No stops listed for this direction.</div>';
    }

    return stops.map(s => `
      <div class="stop-timeline-node" data-id="${s.StopId}">
        <div class="node-dot"></div>
        <div class="node-name">${s.Name}</div>
      </div>
    `).join('');
  }

  _bindStopNodeClicks() {
    const timeline = document.getElementById('route-stops-timeline');
    if (!timeline) return;

    timeline.querySelectorAll('.stop-timeline-node').forEach(node => {
      node.addEventListener('click', () => {
        const sid = node.getAttribute('data-id');
        this.app.stopsController.inspectStop(sid);
      });
    });
  }

  switchDirection(dirIndex) {
    this.currentDirectionIndex = dirIndex;
    const dirData = this.routeStopsData[dirIndex];
    if (!dirData) return;

    const stops = dirData.Stops || [];
    const timeline = document.getElementById('route-stops-timeline');
    if (timeline) {
      timeline.innerHTML = this._buildStopsTimelineHtml(stops);
      this._bindStopNodeClicks();
    }

    // Update stop dots on map
    this.map.setRouteStops(stops, this.currentRoute.color);
    if (stops.length > 0) {
      const coords = stops.map(s => [s.Longitude, s.Latitude]);
      this.map.setRouteShape(coords, this.currentRoute.color);
      this.map.fitBounds(coords);
    }
  }

  async _pollVehicles(routeId, color) {
    try {
      const vehicles = await api.getRouteVehicles(routeId);
      this.map.updateVehicles(vehicles, color);

      const label = document.getElementById('route-active-buses-label');
      if (label) {
        if (vehicles.length > 0) {
          label.innerHTML = `🟢 ${vehicles.length} bus${vehicles.length > 1 ? 'es' : ''} in service`;
        } else {
          label.innerHTML = `⚪ No buses on road right now`;
        }
      }

      // Populate list of buses by their vehicle number
      const busesContainer = document.getElementById('route-buses-by-number');
      if (busesContainer) {
        if (vehicles.length === 0) {
          busesContainer.innerHTML = '';
        } else {
          busesContainer.innerHTML = `
            <div style="background: var(--bg-secondary); border-radius: var(--radius-sm); border: 1px solid var(--border-light); padding: 8px 12px; margin-bottom: 8px;">
              <div style="font-size: 11px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; letter-spacing: 0.5px;">
                ACTIVE BUSES ON THIS LINE (${vehicles.length}):
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${vehicles.map(v => `
                  <button type="button" class="bus-chip-btn" data-vid="${v.vehicleId}" style="display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border-light); background: var(--bg-primary); cursor: pointer; font-size: 11.5px; font-family: var(--font-family);">
                    <span class="pulse-dot" style="width: 5px; height: 5px;"></span>
                    <strong style="color: var(--ac-blue);">Bus #${v.vehicleId}</strong>
                    <span style="color: var(--text-muted); font-size: 10px;">${v.heading}°</span>
                  </button>
                `).join('')}
              </div>
            </div>
          `;

          busesContainer.querySelectorAll('.bus-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const vid = btn.getAttribute('data-vid');
              const v = vehicles.find(x => String(x.vehicleId) === vid);
              if (v) {
                this.map.flyTo([v.lon, v.lat], 16);
                this.map.showVehiclePopup(v, [v.lon, v.lat]);
              }
            });
          });
        }
      }
    } catch (err) {
      console.warn('[Routes] Vehicle poll warning:', err);
    }
  }

  _stopVehiclePolling() {
    if (this.vehiclesPollingTimer) {
      clearInterval(this.vehiclesPollingTimer);
      this.vehiclesPollingTimer = null;
    }
  }

  // Open Timetable Schedule Modal
  async openScheduleModal(routeId) {
    const modal = document.getElementById('schedule-modal');
    const modalTitle = document.getElementById('schedule-modal-title');
    const modalSubtitle = document.getElementById('schedule-modal-subtitle');
    const modalBody = document.getElementById('schedule-modal-body');

    modalTitle.innerText = `Line ${this.currentRoute ? this.currentRoute.name : routeId} Timetable`;
    modalSubtitle.innerText = 'Official AC Transit Service Timetable';
    modalBody.innerHTML = '<div style="text-align: center; padding: 24px;">Loading schedule data...</div>';
    modal.classList.remove('hidden');

    try {
      const schedule = await api.getRouteSchedule(routeId);
      const profiles = schedule.RouteProfiles || [];

      if (profiles.length === 0) {
        modalBody.innerHTML = '<div style="text-align: center; padding: 20px;">No timetable data currently published.</div>';
        return;
      }

      modalBody.innerHTML = profiles.map(p => `
        <div style="margin-bottom: 20px; border-bottom: 1px solid var(--border-light); padding-bottom: 16px;">
          <h4 style="font-size: 15px; font-weight: 700; color: var(--ac-blue); margin-bottom: 6px;">
            ${p.Profile || 'Trip Pattern'}
          </h4>
          <p style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.5;">
            Scheduled service frequency and key timepoints for ${p.Profile}.
          </p>
        </div>
      `).join('');

    } catch (err) {
      modalBody.innerHTML = '<div style="text-align: center; padding: 20px; color: #D32F2F;">Unable to load schedule timetable.</div>';
    }
  }

  destroy() {
    this._stopVehiclePolling();
  }
}
