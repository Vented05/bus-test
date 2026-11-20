/**
 * AC Transit Maps — Directions & Journey Planner
 * Google Maps-style A-to-B transit navigation, multi-modal itineraries,
 * active "Start Trip" navigation HUD, intermediate stops, and live tracking.
 */

import { api } from './api.js';

export class DirectionsController {
  constructor(mapController, app) {
    this.map = mapController;
    this.app = app;
    this.origin = null;       // { name, lat, lon }
    this.destination = null;  // { name, lat, lon }
    this.activeInput = null;  // 'from' | 'to'
    this.itineraries = [];
    this.selectedItinIndex = 0;
    this.debounceTimer = null;

    // Active Navigation state
    this.isNavigating = false;
    this.currentNavItin = null;
    this.currentNavLegIndex = 0;
  }

  init() {
    this._bindElements();
    this._bindNavControls();
  }

  _bindElements() {
    this.fromInput = document.getElementById('dir-from-input');
    this.toInput = document.getElementById('dir-to-input');
    this.swapBtn = document.getElementById('swap-endpoints-btn');
    this.useLocBtn = document.getElementById('dir-use-loc-btn');
    this.timeTypeSelect = document.getElementById('dir-time-type');
    this.timeValInput = document.getElementById('dir-time-val');
    this.modeSelect = document.getElementById('dir-mode-select');
    this.planTripBtn = document.getElementById('plan-trip-btn');
    this.itinerariesContainer = document.getElementById('itineraries-container');
    this.dropdown = document.getElementById('dir-dropdown');

    // Quick presets (Now, 3:00 PM, 8:00 AM)
    const presetNow = document.getElementById('preset-now');
    const preset3pm = document.getElementById('preset-3pm');
    const preset8am = document.getElementById('preset-8am');

    if (presetNow) {
      presetNow.addEventListener('click', () => {
        this._setPresetActive(presetNow);
        this.timeTypeSelect.value = 'now';
        this.timeValInput.classList.add('hidden');
        if (this.origin && this.destination) this.planTrip();
      });
    }

    if (preset3pm) {
      preset3pm.addEventListener('click', () => {
        this._setPresetActive(preset3pm);
        this.timeTypeSelect.value = 'depart';
        this.timeValInput.value = '15:00';
        this.timeValInput.classList.remove('hidden');
        this.app.showToast('Configured trip for 3:00 PM Afternoon Commute');
        if (this.origin && this.destination) this.planTrip();
      });
    }

    if (preset8am) {
      preset8am.addEventListener('click', () => {
        this._setPresetActive(preset8am);
        this.timeTypeSelect.value = 'depart';
        this.timeValInput.value = '08:00';
        this.timeValInput.classList.remove('hidden');
        this.app.showToast('Configured trip for 8:00 AM Morning Commute');
        if (this.origin && this.destination) this.planTrip();
      });
    }

    // Autocomplete on inputs
    this.fromInput.addEventListener('input', (e) => this._onInput(e, 'from'));
    this.fromInput.addEventListener('focus', () => { this.activeInput = 'from'; });
    this.toInput.addEventListener('input', (e) => this._onInput(e, 'to'));
    this.toInput.addEventListener('focus', () => { this.activeInput = 'to'; });

    // Swap endpoints
    this.swapBtn.addEventListener('click', () => this.swapEndpoints());

    // Use current location as origin
    this.useLocBtn.addEventListener('click', () => this.useCurrentLocation());

    // Time select toggle
    this.timeTypeSelect.addEventListener('change', () => {
      const val = this.timeTypeSelect.value;
      if (val === 'depart' || val === 'arrive') {
        this.timeValInput.classList.remove('hidden');
        if (!this.timeValInput.value) {
          this.timeValInput.value = '15:00'; // Default convenient 3:00 PM
        }
      } else {
        this.timeValInput.classList.add('hidden');
      }
    });

    if (this.modeSelect) {
      this.modeSelect.addEventListener('change', () => {
        if (this.origin && this.destination) this.planTrip();
      });
    }

    // Plan trip button
    this.planTripBtn.addEventListener('click', () => this.planTrip());

    // Keyboard Enter to plan
    const handleEnter = (e) => {
      if (e.key === 'Enter') {
        this.planTrip();
      }
    };
    this.fromInput.addEventListener('keydown', handleEnter);
    this.toInput.addEventListener('keydown', handleEnter);

    // Hide dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.directions-form')) {
        this.dropdown.classList.add('hidden');
      }
    });
  }

  _setPresetActive(activeEl) {
    document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
    activeEl.classList.add('active');
  }

  _bindNavControls() {
    this.navHud = document.getElementById('nav-hud-banner');
    this.navBottomBar = document.getElementById('nav-bottom-bar');
    this.navTitle = document.getElementById('nav-hud-title');
    this.navDesc = document.getElementById('nav-hud-desc');
    this.navBusTag = document.getElementById('nav-hud-bus-tag');
    this.navCountdown = document.getElementById('nav-hud-countdown');
    this.navIcon = document.getElementById('nav-hud-icon');

    this.navStatTime = document.getElementById('nav-stat-time');
    this.navStatDist = document.getElementById('nav-stat-dist');
    this.navStatEta = document.getElementById('nav-stat-eta');
    this.navCounter = document.getElementById('nav-step-counter');

    const prevBtn = document.getElementById('nav-prev-step-btn');
    const nextBtn = document.getElementById('nav-next-step-btn');
    const exitBtn = document.getElementById('nav-exit-btn');
    const exitTopBtn = document.getElementById('nav-exit-btn-top');

    if (prevBtn) prevBtn.addEventListener('click', () => this.prevNavStep());
    if (nextBtn) nextBtn.addEventListener('click', () => this.nextNavStep());
    if (exitBtn) exitBtn.addEventListener('click', () => this.exitNavigation());
    if (exitTopBtn) exitTopBtn.addEventListener('click', () => this.exitNavigation());
  }

  // Handle Autocomplete Typing
  _onInput(e, type) {
    this.activeInput = type;
    const query = e.target.value.trim();
    clearTimeout(this.debounceTimer);

    if (query.length < 2) {
      this.dropdown.classList.add('hidden');
      return;
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        const results = await api.getGeocode(query);
        this._renderDropdown(results, type);
      } catch (err) {
        console.warn('[Directions] Geocode error:', err);
      }
    }, 200);
  }

  _renderDropdown(results, type) {
    if (!results || results.length === 0) {
      this.dropdown.classList.add('hidden');
      return;
    }

    this.dropdown.innerHTML = results.map(item => {
      let icon = item.type === 'stop' ? (item.isHub ? 'building-2' : 'bus') : 'map-pin';
      let iconBg = item.isHub ? '#FFF3E0' : 'var(--bg-tertiary)';
      let iconColor = item.isHub ? '#E65100' : 'var(--text-secondary)';

      return `
        <div class="dropdown-item" data-id="${item.id}" data-name="${item.name}" data-lat="${item.lat}" data-lon="${item.lon}">
          <div class="item-icon-wrapper" style="background-color: ${iconBg}; color: ${iconColor};">
            <i data-lucide="${icon}"></i>
          </div>
          <div class="item-content">
            <div class="item-title">${item.name}</div>
            <div class="item-subtitle">${item.label || item.city || ''}</div>
          </div>
        </div>
      `;
    }).join('');

    this.dropdown.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: this.dropdown });

    // Item selection
    this.dropdown.querySelectorAll('.dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.getAttribute('data-name');
        const lat = parseFloat(el.getAttribute('data-lat'));
        const lon = parseFloat(el.getAttribute('data-lon'));

        if (type === 'from') {
          this.setOrigin({ name, lat, lon });
        } else {
          this.setDestination({ name, lat, lon });
        }
        this.dropdown.classList.add('hidden');

        if (this.origin && this.destination) {
          this.planTrip();
        }
      });
    });
  }

  setOrigin(place) {
    this.origin = place;
    this.fromInput.value = place.name;
    this.map.setOriginMarker([place.lon, place.lat], place.name);
    if (!this.destination) {
      this.map.flyTo([place.lon, place.lat], 14);
    }
  }

  setDestination(place) {
    this.destination = place;
    this.toInput.value = place.name;
    this.map.setDestMarker([place.lon, place.lat], place.name);
    if (this.origin) {
      this.planTrip();
    } else {
      this.map.flyTo([place.lon, place.lat], 14);
    }
  }

  swapEndpoints() {
    const temp = this.origin;
    this.origin = this.destination;
    this.destination = temp;

    this.fromInput.value = this.origin ? this.origin.name : '';
    this.toInput.value = this.destination ? this.destination.name : '';

    if (this.origin) {
      this.map.setOriginMarker([this.origin.lon, this.origin.lat], this.origin.name);
    } else {
      this.map.clearOriginDestMarkers();
    }

    if (this.destination) {
      this.map.setDestMarker([this.destination.lon, this.destination.lat], this.destination.name);
    }

    if (this.origin && this.destination) {
      this.planTrip();
    }
  }

  useCurrentLocation() {
    if (!navigator.geolocation) {
      this.app.showToast('Geolocation is not supported by your browser.');
      return;
    }

    this.useLocBtn.innerHTML = '<span class="loading-spinner-sm"></span>';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        this.setOrigin({
          name: 'Your Current Location',
          lat,
          lon
        });
        this.map.setUserLocation([lon, lat]);
        this.useLocBtn.innerHTML = '<i data-lucide="crosshair"></i>';
        if (window.lucide) window.lucide.createIcons({ root: this.useLocBtn });
      },
      (err) => {
        this.useLocBtn.innerHTML = '<i data-lucide="crosshair"></i>';
        if (window.lucide) window.lucide.createIcons({ root: this.useLocBtn });
        this.app.showToast('Could not obtain current location.');
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  handleMapClick(coords) {
    const defaultName = `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
    if (!this.origin) {
      this.setOrigin({ name: defaultName, lat: coords.lat, lon: coords.lng });
    } else if (!this.destination) {
      this.setDestination({ name: defaultName, lat: coords.lat, lon: coords.lng });
    } else {
      if (this.activeInput === 'from') {
        this.setOrigin({ name: defaultName, lat: coords.lat, lon: coords.lng });
      } else {
        this.setDestination({ name: defaultName, lat: coords.lat, lon: coords.lng });
      }
    }
  }

  async _resolveEndpoint(type) {
    const input = type === 'from' ? this.fromInput : this.toInput;
    const current = type === 'from' ? this.origin : this.destination;
    const val = input.value.trim();

    if (!val) return null;

    if (current && current.name === val) {
      return current;
    }

    if (/current location|my location/i.test(val)) {
      if (this.app.userLocation) {
        const place = { name: 'Your Location', lat: this.app.userLocation[1], lon: this.app.userLocation[0] };
        if (type === 'from') this.setOrigin(place); else this.setDestination(place);
        return place;
      }
      return new Promise((res) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const place = { name: 'Your Location', lat: pos.coords.latitude, lon: pos.coords.longitude };
            if (type === 'from') this.setOrigin(place); else this.setDestination(place);
            res(place);
          },
          () => res(null),
          { timeout: 5000, enableHighAccuracy: true }
        );
      });
    }

    // Direct stop code match if numeric
    if (/^\d{4,6}$/.test(val)) {
      try {
        const stops = await api.getStops(null, val, 1);
        if (stops && stops.length > 0) {
          const s = stops[0];
          const place = { name: `${s.name} (Stop #${s.code || s.stopId})`, lat: s.lat, lon: s.lon, stopId: s.code || s.stopId };
          if (type === 'from') this.setOrigin(place); else this.setDestination(place);
          return place;
        }
      } catch (e) {}
    }

    // Search via geocode / autocomplete
    try {
      const results = await api.getGeocode(val);
      if (results && results.length > 0) {
        const top = results[0];
        const place = {
          name: top.name,
          lat: top.lat,
          lon: top.lon,
          stopId: top.stopId || null
        };
        if (type === 'from') this.setOrigin(place); else this.setDestination(place);
        return place;
      }
    } catch (e) {
      console.warn('[Directions] Endpoint resolution error:', e);
    }

    return current;
  }

  // Plan Trip Execution
  async planTrip() {
    // Auto-resolve any typed values before verifying endpoints
    if (!this.origin || (this.fromInput.value.trim() && this.origin.name !== this.fromInput.value.trim())) {
      await this._resolveEndpoint('from');
    }
    if (!this.destination || (this.toInput.value.trim() && this.destination.name !== this.toInput.value.trim())) {
      await this._resolveEndpoint('to');
    }

    if (!this.origin || !this.destination) {
      this.app.showToast('Please specify both starting point and destination.');
      return;
    }

    this.itinerariesContainer.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-secondary);">
        <div class="pulse-dot" style="margin: 0 auto 12px; width: 10px; height: 10px;"></div>
        Searching optimal AC Transit routes...
      </div>
    `;

    try {
      const fromParam = `${this.origin.name}::${this.origin.lat},${this.origin.lon}`;
      const toParam = `${this.destination.name}::${this.destination.lat},${this.destination.lon}`;

      const params = {
        from: fromParam,
        to: toParam
      };

      const timeType = this.timeTypeSelect.value;
      if (timeType === 'arrive') {
        params.arriveBy = 'true';
      }

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      params.date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

      if (timeType === 'now') {
        const h12 = now.getHours() % 12 || 12;
        params.time = `${h12}:${pad(now.getMinutes())}${now.getHours() < 12 ? 'am' : 'pm'}`;
      } else if (this.timeValInput.value) {
        const parts = this.timeValInput.value.split(':');
        const hNum = parseInt(parts[0], 10);
        const mStr = parts[1] || '00';
        const h12 = hNum % 12 || 12;
        params.time = `${h12}:${mStr}${hNum < 12 ? 'am' : 'pm'}`;
      }

      if (this.modeSelect) {
        params.mode = this.modeSelect.value;
      }

      const res = await api.planTrip(params);
      this.itineraries = res.itineraries || [];

      if (this.itineraries.length === 0) {
        this.itinerariesContainer.innerHTML = `
          <div style="text-align: center; padding: 24px; color: var(--text-secondary);">
            No transit routes found between these locations for this time. Try setting time to 3:00 PM or Now.
          </div>
        `;
        return;
      }

      this._renderItineraries();
      this.selectItinerary(0);

    } catch (err) {
      console.error('[Directions] Trip plan error:', err);
      const msg = err.message || 'Unable to calculate route. Please try another destination.';
      this.itinerariesContainer.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--text-secondary);">
          <div style="color: #E53935; font-weight: 700; margin-bottom: 8px;">
            <i data-lucide="alert-triangle" style="display: inline-block; vertical-align: middle; margin-right: 6px;"></i>
            Notice
          </div>
          <div style="font-size: 13px; line-height: 1.5; margin-bottom: 14px;">
            ${msg}
          </div>
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button class="preset-chip" id="retry-3pm" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
              Try 3:00 PM
            </button>
            <button class="preset-chip" id="retry-now" style="font-size: 12px; padding: 6px 14px; cursor: pointer;">
              Try Leave Now
            </button>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons({ root: this.itinerariesContainer });
      const r3 = document.getElementById('retry-3pm');
      if (r3) r3.onclick = () => {
        const p3 = document.getElementById('preset-3pm');
        if (p3) p3.click();
        this.planTrip();
      };
      const rn = document.getElementById('retry-now');
      if (rn) rn.onclick = () => {
        const pn = document.getElementById('preset-now');
        if (pn) pn.click();
        this.planTrip();
      };
    }
  }

  _renderItineraries() {
    this.itinerariesContainer.innerHTML = this.itineraries.map((itin, idx) => {
      const durationMins = itin.durationMinutes;
      const startFormatted = new Date(itin.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const endFormatted = new Date(itin.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      // Badges row
      const badgesHtml = itin.legs.map((leg, legIdx) => {
        if (leg.mode === 'WALK') {
          return `
            <span class="walk-badge">
              <i data-lucide="footprints" style="width: 12px; height: 12px;"></i>
              <span>${leg.durationMinutes}m</span>
            </span>
            ${legIdx < itin.legs.length - 1 ? '<span class="arrow-separator">›</span>' : ''}
          `;
        } else {
          return `
            <span class="transit-badge" style="background-color: ${leg.color}; color: ${leg.textColor};">
              <span>${leg.routeShortName || leg.route}</span>
            </span>
            ${leg.isCanceled ? '<span class="badge-canceled">CANCELED</span>' : ''}
            ${legIdx < itin.legs.length - 1 ? '<span class="arrow-separator">›</span>' : ''}
          `;
        }
      }).join('');

      // Steps Breakdown (Turn by Turn)
      const stepsHtml = itin.legs.map(leg => {
        const isWalk = leg.mode === 'WALK';
        const modeColor = leg.color || (isWalk ? '#78909C' : '#0072CE');

        let intermediateHtml = '';
        if (leg.intermediateStops && leg.intermediateStops.length > 0) {
          const stopsList = leg.intermediateStops.map(st => `
            <div style="padding: 2px 0 2px 14px; font-size: 11.5px; color: var(--text-secondary);">
              • ${st.name}
            </div>
          `).join('');

          intermediateHtml = `
            <button class="intermediate-stops-toggle" onclick="this.nextElementSibling.classList.toggle('hidden');">
              <i data-lucide="chevron-down" style="width: 12px; height: 12px;"></i>
              <span>${leg.intermediateStopsCount} stops (${leg.durationMinutes} min)</span>
            </button>
            <div class="hidden" style="margin-top: 4px; border-left: 2px solid var(--border-light); margin-left: 4px;">
              ${stopsList}
            </div>
          `;
        }

        return `
          <div class="step-leg">
            <div class="leg-icon-column">
              <div class="leg-mode-icon" style="background-color: ${modeColor};">
                <i data-lucide="${isWalk ? 'footprints' : 'bus'}"></i>
              </div>
              <div class="leg-connector-line" style="background-color: ${modeColor};"></div>
            </div>
            <div class="leg-details">
              <div class="leg-instruction">
                ${isWalk 
                  ? `Walk ${leg.durationMinutes} min (${(leg.distanceMeters / 1609.34).toFixed(1)} mi) to ${leg.to.name}`
                  : `Board Line ${leg.routeShortName} at ${leg.from.name} toward ${leg.headsign || leg.to.name}`
                }
                ${leg.isCanceled ? '<span class="badge-canceled" style="margin-left: 6px;">CANCELED</span>' : ''}
              </div>
              <div class="leg-subinfo">
                ${isWalk 
                  ? `${leg.steps.length > 0 ? leg.steps[0].instruction : 'Head toward transit stop'}`
                  : `Ride ${leg.intermediateStopsCount || 1} stops (${leg.durationMinutes} min) • Get off at ${leg.to.name}`
                }
              </div>
              ${intermediateHtml}
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="itinerary-card ${idx === 0 ? 'selected' : ''}" data-index="${idx}">
          ${itin.hasCanceledBus ? '<div class="itin-canceled-banner"><i data-lucide="alert-triangle"></i> Trip includes a canceled bus</div>' : ''}
          <div class="itin-header">
            <div class="itin-duration">${durationMins} min</div>
            <div class="itin-times">${startFormatted} – ${endFormatted}</div>
          </div>
          <div class="itin-badges-row">
            ${badgesHtml}
          </div>
          <div class="itin-meta-row">
            <span>Walk: ${itin.walkTimeMinutes} min (${itin.walkDistanceMiles} mi)</span>
            <span>Fare: ${itin.fare}</span>
            <span>${itin.transfers === 0 ? 'Direct' : `${itin.transfers} transfer`}</span>
          </div>

          <!-- Google Maps Start Trip Button -->
          <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-light);">
            <button class="btn-start-nav" data-index="${idx}">
              <i data-lucide="navigation"></i> Start
            </button>
            <span style="font-size: 12px; color: var(--ac-blue); font-weight: 600;">Tap to view steps</span>
          </div>

          <div class="itin-steps-breakdown ${idx === 0 ? '' : 'hidden'}">
            ${stepsHtml}
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) window.lucide.createIcons({ root: this.itinerariesContainer });

    // Card click events
    this.itinerariesContainer.querySelectorAll('.itinerary-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.intermediate-stops-toggle') || e.target.closest('.btn-start-nav')) return;
        const idx = parseInt(card.getAttribute('data-index'), 10);
        this.selectItinerary(idx);
      });
    });

    // Start Navigation Buttons
    this.itinerariesContainer.querySelectorAll('.btn-start-nav').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        this.startNavigation(this.itineraries[idx]);
      });
    });
  }

  selectItinerary(index) {
    this.selectedItinIndex = index;

    this.itinerariesContainer.querySelectorAll('.itinerary-card').forEach((card, i) => {
      const breakdown = card.querySelector('.itin-steps-breakdown');
      if (i === index) {
        card.classList.add('selected');
        if (breakdown) breakdown.classList.remove('hidden');
      } else {
        card.classList.remove('selected');
        if (breakdown) breakdown.classList.add('hidden');
      }
    });

    const chosen = this.itineraries[index];
    if (chosen && chosen.legs) {
      this.map.setItineraryLegs(chosen.legs);
    }
  }

  // ----------------- Google Maps Active Navigation Mode -----------------

  startNavigation(itinerary) {
    if (!itinerary || !itinerary.legs || itinerary.legs.length === 0) return;

    this.isNavigating = true;
    this.currentNavItin = itinerary;
    this.currentNavLegIndex = 0;

    // Hide drawer to give clean full map
    this.app.sidePanel.classList.add('hidden');

    // Show top navigation HUD & bottom bar
    this.navHud.classList.remove('hidden');
    this.navBottomBar.classList.remove('hidden');

    this.app.showToast('Trip Navigation Started');
    this.updateNavUI();
  }

  updateNavUI() {
    if (!this.currentNavItin) return;

    const legs = this.currentNavItin.legs;
    const currentLeg = legs[this.currentNavLegIndex];
    if (!currentLeg) return;

    const isWalk = currentLeg.mode === 'WALK';

    // Top HUD
    if (isWalk) {
      this.navTitle.innerText = `Walk to ${currentLeg.to.name}`;
      this.navDesc.innerText = `${currentLeg.durationMinutes} min • ${(currentLeg.distanceMeters / 1609.34).toFixed(1)} mi`;
      this.navBusTag.classList.add('hidden');
      this.navCountdown.innerText = 'Walking';
      this.navHud.style.backgroundColor = '#455A64';
    } else {
      const routeName = currentLeg.routeShortName || currentLeg.route;
      this.navTitle.innerText = `Board Line ${routeName} toward ${currentLeg.headsign || currentLeg.to.name}`;
      this.navDesc.innerText = `At ${currentLeg.from.name} • Ride ${currentLeg.intermediateStopsCount || 1} stops (${currentLeg.durationMinutes} min)`;
      this.navBusTag.classList.remove('hidden');
      this.navBusTag.innerText = `Line ${routeName}`;
      this.navCountdown.innerText = 'Real-Time';
      this.navHud.style.backgroundColor = currentLeg.color || '#0072CE';

      // Load active buses on this route
      api.getRouteVehicles(routeName).then(vehicles => {
        if (vehicles && vehicles.length > 0) {
          const firstBus = vehicles[0];
          this.navBusTag.innerText = `Bus #${firstBus.vehicleId} (${routeName})`;
          this.map.updateVehicles(vehicles, currentLeg.color);
        }
      }).catch(() => {});
    }

    // Bottom Bar Stats
    this.navStatTime.innerText = `${currentLeg.durationMinutes}m`;
    this.navStatDist.innerText = `${(currentLeg.distanceMeters / 1609.34).toFixed(1)} mi`;
    const arrivalDate = new Date(currentLeg.endTime);
    this.navStatEta.innerText = arrivalDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.navCounter.innerText = `Leg ${this.currentNavLegIndex + 1} of ${legs.length}`;

    // Enable / Disable Prev Next
    const prevBtn = document.getElementById('nav-prev-step-btn');
    const nextBtn = document.getElementById('nav-next-step-btn');
    if (prevBtn) prevBtn.disabled = this.currentNavLegIndex === 0;
    if (nextBtn) nextBtn.disabled = this.currentNavLegIndex === legs.length - 1;

    // Focus map on current leg
    if (currentLeg.coordinates && currentLeg.coordinates.length > 0) {
      this.map.fitBounds(currentLeg.coordinates);
    }

    if (window.lucide) {
      window.lucide.createIcons({ root: this.navHud });
      window.lucide.createIcons({ root: this.navBottomBar });
    }
  }

  nextNavStep() {
    if (!this.currentNavItin) return;
    if (this.currentNavLegIndex < this.currentNavItin.legs.length - 1) {
      this.currentNavLegIndex++;
      this.updateNavUI();
    }
  }

  prevNavStep() {
    if (!this.currentNavItin) return;
    if (this.currentNavLegIndex > 0) {
      this.currentNavLegIndex--;
      this.updateNavUI();
    }
  }

  exitNavigation() {
    this.isNavigating = false;
    this.navHud.classList.add('hidden');
    this.navBottomBar.classList.add('hidden');
    this.app.sidePanel.classList.remove('hidden');
    this.app.showToast('Exited trip navigation.');
  }
}
