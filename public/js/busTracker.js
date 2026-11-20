/**
 * AC Transit Maps — Live Fleet & Bus Tracker
 * Live telemetry tracking across active AC Transit buses with
 * compass heading orientation and fleet overview analytics.
 */

import { api } from './api.js';

export class BusTrackerController {
  constructor(mapController, app) {
    this.map = mapController;
    this.app = app;
    this.fleetVehicles = [];
    this.pollingTimer = null;
  }

  init() {
    this.statsCard = document.getElementById('fleet-stats-card');
    this.busesList = document.getElementById('fleet-buses-list');
  }

  // Load and show active fleet across network
  async loadLiveFleet() {
    this.app.openPanel('view-fleet', 'Live AC Transit Fleet', 'Real-Time Bus GPS Telemetry');
    
    this.statsCard.innerHTML = `
      <div style="text-align: center; padding: 12px;">
        <div class="pulse-dot" style="margin: 0 auto 8px;"></div>
        Polling live vehicle transponders...
      </div>
    `;
    this.busesList.innerHTML = '';

    await this.refreshFleet();
    this._startPolling();
  }

  _startPolling() {
    this._stopPolling();
    this.pollingTimer = setInterval(() => {
      this.refreshFleet(true);
    }, 12000);
  }

  _stopPolling() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  async refreshFleet(isBackground = false) {
    try {
      const vehicles = await api.getLiveFleet();
      this.fleetVehicles = vehicles;

      // Update map vehicle markers
      this.map.updateVehicles(vehicles);

      // Render stats card
      this.statsCard.innerHTML = `
        <div class="fleet-stat-number">${vehicles.length}</div>
        <div class="fleet-stat-label">Active AC Transit buses transmitting live GPS right now</div>
        <div style="display: flex; gap: 12px; margin-top: 10px; font-size: 11.5px; opacity: 0.95;">
          <span>• 10s auto-refresh</span>
          <span>• Heading orientation</span>
          <span>• East Bay network</span>
        </div>
      `;

      // Render list
      if (vehicles.length === 0) {
        this.busesList.innerHTML = `
          <div style="text-align: center; padding: 20px; color: var(--text-muted);">
            No buses reporting GPS coordinates currently.
          </div>
        `;
        return;
      }

      this.busesList.innerHTML = vehicles.map(v => `
        <div class="bus-list-item" data-vid="${v.vehicleId}">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="dep-route-badge" style="background-color: var(--ac-blue);">
              ${v.routeId}
            </span>
            <div>
              <div style="font-size: 13.5px; font-weight: 700; color: var(--text-primary);">
                Bus #${v.vehicleId}
              </div>
              <div style="font-size: 11.5px; color: var(--text-secondary);">
                Heading ${v.heading}° • Trip #${v.tripId || 'Active'}
              </div>
            </div>
          </div>
          <button class="icon-btn" title="Track this bus">
            <i data-lucide="crosshair"></i>
          </button>
        </div>
      `).join('');

      if (window.lucide) window.lucide.createIcons({ root: this.busesList });

      // Click to focus vehicle
      this.busesList.querySelectorAll('.bus-list-item').forEach(el => {
        el.addEventListener('click', () => {
          const vid = el.getAttribute('data-vid');
          const v = this.fleetVehicles.find(x => String(x.vehicleId) === vid);
          if (v) {
            this.map.flyTo([v.lon, v.lat], 16);
            this.map.showVehiclePopup(v, [v.lon, v.lat]);
          }
        });
      });

    } catch (err) {
      if (!isBackground) {
        this.statsCard.innerHTML = `
          <div style="color: #FFCDD2; font-size: 13px;">
            Could not retrieve fleet telemetry.
          </div>
        `;
      }
    }
  }

  destroy() {
    this._stopPolling();
  }
}
