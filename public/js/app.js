/**
 * AC Transit Maps — Main Application Orchestrator
 * Seamlessly integrates Google Maps-style search, routing, stops,
 * real-time bus tracking, and persistent bookmarks.
 */

import { api } from './api.js';
import { MapController } from './map.js';
import { DirectionsController } from './directions.js';
import { StopsController } from './stops.js';
import { RoutesController } from './routes.js';
import { BusTrackerController } from './busTracker.js';

class App {
  constructor() {
    this.map = new MapController('map');
    this.directionsController = new DirectionsController(this.map, this);
    this.stopsController = new StopsController(this.map, this);
    this.routesController = new RoutesController(this.map, this);
    this.busTrackerController = new BusTrackerController(this.map, this);

    this.activeView = 'explore';
    this.searchDebounceTimer = null;
    this.savedStops = this._loadSaved('act_saved_stops');
    this.savedRoutes = this._loadSaved('act_saved_routes');
  }

  async init() {
    console.log('[App] Bootstrapping AC Transit Maps...');
    
    // 1. Initialize Map
    await this.map.init();

    // 2. Initialize Controllers
    this.directionsController.init();
    this.stopsController.init();
    this.routesController.init();
    this.busTrackerController.init();

    // 3. Bind UI Events
    this._bindSearch();
    this._bindActionChips();
    this._bindMapControls();
    this._bindPanelControls();
    this._bindModals();
    this._bindMapInteractions();

    // 4. Lucide Icons Setup
    if (window.lucide) {
      window.lucide.createIcons();
    }

    console.log('[App] AC Transit Maps Ready.');
  }

  // ----------------- Top Search Bar -----------------
  _bindSearch() {
    this.searchInput = document.getElementById('main-search-input');
    this.clearBtn = document.getElementById('clear-search-btn');
    this.dropdown = document.getElementById('search-dropdown');
    this.dropdownList = document.getElementById('dropdown-list');
    this.dirModeBtn = document.getElementById('directions-mode-btn');

    this.searchInput.addEventListener('input', (e) => {
      const q = e.target.value;
      if (q.length > 0) {
        this.clearBtn.classList.remove('hidden');
      } else {
        this.clearBtn.classList.add('hidden');
        this.dropdown.classList.add('hidden');
        return;
      }

      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = setTimeout(async () => {
        if (q.trim().length >= 2) {
          try {
            const results = await api.getGeocode(q.trim());
            this._renderSearchDropdown(results);
          } catch (err) {
            console.warn('[Search] Geocode error:', err);
          }
        }
      }, 200);
    });

    this.clearBtn.addEventListener('click', () => {
      this.searchInput.value = '';
      this.clearBtn.classList.add('hidden');
      this.dropdown.classList.add('hidden');
      this.searchInput.focus();
    });

    this.dirModeBtn.addEventListener('click', () => {
      this.startDirections();
    });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#search-card')) {
        this.dropdown.classList.add('hidden');
      }
    });

    // Enter key handling
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const firstItem = this.dropdownList.querySelector('.dropdown-item');
        if (firstItem) {
          firstItem.click();
        }
      }
    });
  }

  _renderSearchDropdown(results) {
    if (!results || results.length === 0) {
      this.dropdown.classList.add('hidden');
      return;
    }

    this.dropdownList.innerHTML = results.map((item, idx) => {
      let icon = 'map-pin';
      let iconColor = 'inherit';
      let iconBg = 'var(--bg-tertiary)';

      if (item.type === 'route') {
        icon = 'git-branch';
        iconBg = item.color || 'var(--ac-blue)';
        iconColor = '#FFFFFF';
      } else if (item.type === 'stop') {
        icon = item.isHub ? 'building-2' : 'bus';
        if (item.isHub) {
          iconBg = '#FFF3E0';
          iconColor = '#E65100';
        }
      }

      return `
        <div class="dropdown-item" data-idx="${idx}" data-type="${item.type}" data-id="${item.id}" data-lat="${item.lat || ''}" data-lon="${item.lon || ''}" data-routeid="${item.routeId || ''}" data-stopid="${item.stopId || ''}">
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
    if (window.lucide) window.lucide.createIcons({ root: this.dropdownList });

    // Item click handling
    this.dropdownList.querySelectorAll('.dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        const item = results[idx];
        const type = el.getAttribute('data-type');
        this.dropdown.classList.add('hidden');

        if (type === 'route') {
          const routeId = el.getAttribute('data-routeid');
          this.routesController.inspectRoute(routeId);
        } else if (type === 'stop') {
          this.stopsController.inspectStop(item || el.getAttribute('data-stopid'));
        } else {
          // Place / Address
          const lat = parseFloat(el.getAttribute('data-lat'));
          const lon = parseFloat(el.getAttribute('data-lon'));
          if (!isNaN(lat) && !isNaN(lon)) {
            this.map.flyTo([lon, lat], 16);
            this.showToast(`Navigated to ${el.querySelector('.item-title').innerText}`);
          }
        }
      });
    });
  }

  // ----------------- Action Chips Navigation -----------------
  _bindActionChips() {
    this.chips = document.querySelectorAll('.chip-btn');
    this.chips.forEach(chip => {
      chip.addEventListener('click', () => {
        const action = chip.getAttribute('data-action');
        this.selectAction(action);
      });
    });
  }

  selectAction(action) {
    this.chips.forEach(c => {
      if (c.getAttribute('data-action') === action) {
        c.classList.add('active');
      } else {
        c.classList.remove('active');
      }
    });

    this.activeView = action;

    switch (action) {
      case 'explore':
        this.closePanel();
        this.map.clearItinerary();
        this.map.clearVehicles();
        this.map.setRouteShape([]);
        this.map.setRouteStops([]);
        break;
      case 'directions':
        this.openPanel('view-directions', 'Directions', 'AC Transit Trip Planner');
        break;
      case 'routes':
        this.routesController.loadRoutesCatalog();
        break;
      case 'nearby':
        this.stopsController.loadNearbyStops();
        break;
      case 'fleet':
        this.busTrackerController.loadLiveFleet();
        break;
      case 'saved':
        this.openSavedBookmarks();
        break;
    }
  }

  startDirections(origin = null, destination = null) {
    this.selectAction('directions');
    if (origin) {
      this.directionsController.setOrigin(origin);
    }
    if (destination) {
      this.directionsController.setDestination(destination);
    }
  }

  // ----------------- Side Panel Management -----------------
  _bindPanelControls() {
    this.sidePanel = document.getElementById('side-panel');
    this.panelTitle = document.getElementById('panel-title');
    this.panelSubtitle = document.getElementById('panel-subtitle');
    this.closePanelBtn = document.getElementById('close-panel-btn');

    this.closePanelBtn.addEventListener('click', () => {
      this.closePanel();
      this.selectAction('explore');
    });

    // Mobile swipe handle
    this._bindDrawerDrag();
  }

  openPanel(viewId, title = '', subtitle = '') {
    this.sidePanel.classList.remove('hidden');
    this.panelTitle.innerText = title;
    this.panelSubtitle.innerText = subtitle;

    // Hide all views, show targeted view
    document.querySelectorAll('.panel-view').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(viewId);
    if (target) {
      target.classList.remove('hidden');
    }

    if (window.lucide) window.lucide.createIcons({ root: this.sidePanel });
  }

  closePanel() {
    this.sidePanel.classList.add('hidden');
    this.stopsController.destroy();
    this.routesController.destroy();
    this.busTrackerController.destroy();
  }

  // ----------------- Map Controls (Bottom-Right) -----------------
  _bindMapControls() {
    // Zoom In & Out
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      if (this.map.map) this.map.map.zoomIn({ duration: 300 });
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      if (this.map.map) this.map.map.zoomOut({ duration: 300 });
    });

    // Reset North Compass
    const compassBtn = document.getElementById('btn-compass');
    compassBtn.addEventListener('click', () => {
      if (this.map.map) {
        this.map.map.easeTo({ bearing: 0, pitch: 0, duration: 600 });
      }
    });

    // Rotate compass icon with map bearing
    if (this.map.map) {
      this.map.map.on('rotate', () => {
        const bearing = this.map.map.getBearing();
        const icon = document.getElementById('compass-icon');
        if (icon) {
          icon.style.transform = `rotate(${-bearing}deg)`;
        }
      });
    }

    // Toggle 3D Perspective
    let is3D = false;
    document.getElementById('btn-pitch-3d').addEventListener('click', () => {
      if (!this.map.map) return;
      is3D = !is3D;
      this.map.map.easeTo({
        pitch: is3D ? 55 : 0,
        duration: 800
      });
      document.getElementById('btn-pitch-3d').classList.toggle('active', is3D);
    });

    // Locate Me Button
    document.getElementById('btn-locate').addEventListener('click', () => {
      if (!navigator.geolocation) {
        this.showToast('Geolocation is not supported by your browser.');
        return;
      }

      this.showToast('Locating your position...');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = [pos.coords.longitude, pos.coords.latitude];
          this.map.setUserLocation(coords);
          this.map.flyTo(coords, 16);
          this.showToast('Centered on your location');
        },
        () => {
          this.showToast('Unable to access location.');
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    // Map Style / Layer Switcher
    const layerBtn = document.getElementById('btn-layer-switch');
    const layerPopover = document.getElementById('layer-switcher-popover');

    layerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layerPopover.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#layer-switcher-popover') && !e.target.closest('#btn-layer-switch')) {
        layerPopover.classList.add('hidden');
      }
    });

    layerPopover.querySelectorAll('.layer-option').forEach(opt => {
      opt.addEventListener('click', () => {
        layerPopover.querySelectorAll('.layer-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const layerKey = opt.getAttribute('data-layer');
        this.map.setStyle(layerKey);
        layerPopover.classList.add('hidden');
        this.showToast(`Switched map layer to ${opt.querySelector('span').innerText}`);
      });
    });
  }

  _bindMapInteractions() {
    this.map.onMapClick((e) => {
      if (this.activeView === 'directions') {
        this.directionsController.handleMapClick(e);
      }
    });
  }

  // ----------------- Bookmarks (Saved Stops & Routes) -----------------
  _loadSaved(key) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  _persistSaved(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {}
  }

  isSaved(type, id) {
    const list = type === 'stops' ? this.savedStops : this.savedRoutes;
    const sId = String(id);
    return list.some(item => String(type === 'stops' ? (item.stopId || item.code) : item.routeId) === sId);
  }

  toggleSave(type, item) {
    const list = type === 'stops' ? this.savedStops : this.savedRoutes;
    const id = String(type === 'stops' ? (item.stopId || item.code) : item.routeId);
    const existingIndex = list.findIndex(x => String(type === 'stops' ? (x.stopId || x.code) : x.routeId) === id);

    let saved = false;
    if (existingIndex >= 0) {
      list.splice(existingIndex, 1);
      saved = false;
    } else {
      list.push(item);
      saved = true;
    }

    this._persistSaved(type === 'stops' ? 'act_saved_stops' : 'act_saved_routes', list);
    return saved;
  }

  openSavedBookmarks() {
    this.openPanel('view-saved', 'Saved Bookmarks', 'Your favorite stops & routes');
    const container = document.getElementById('saved-list');
    const tabs = document.querySelectorAll('.saved-tabs .sub-tab');

    const render = (type) => {
      const items = type === 'stops' ? this.savedStops : this.savedRoutes;

      if (items.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 24px; color: var(--text-muted);">
            No saved ${type} yet. Tap the bookmark icon on any ${type === 'stops' ? 'stop' : 'line'} to save it here.
          </div>
        `;
        return;
      }

      if (type === 'stops') {
        container.innerHTML = items.map(s => `
          <div class="route-list-item saved-stop-item" data-id="${s.stopId || s.code}">
            <div class="item-icon-wrapper">
              <i data-lucide="bus"></i>
            </div>
            <div class="route-desc-col">
              <div class="route-item-title">${s.name}</div>
              <div class="route-item-cat">Stop #${s.code || s.stopId} • ${s.city || 'East Bay'}</div>
            </div>
          </div>
        `).join('');

        container.querySelectorAll('.saved-stop-item').forEach(el => {
          el.addEventListener('click', () => {
            const sid = el.getAttribute('data-id');
            this.stopsController.inspectStop(sid);
          });
        });
      } else {
        container.innerHTML = items.map(r => `
          <div class="route-list-item saved-route-item" data-id="${r.routeId}">
            <span class="dep-route-badge" style="background-color: ${r.color || 'var(--ac-blue)'};">
              ${r.name || r.routeId}
            </span>
            <div class="route-desc-col">
              <div class="route-item-title">Line ${r.name || r.routeId}</div>
              <div class="route-item-cat">${r.description || ''}</div>
            </div>
          </div>
        `).join('');

        container.querySelectorAll('.saved-route-item').forEach(el => {
          el.addEventListener('click', () => {
            const rid = el.getAttribute('data-id');
            this.routesController.inspectRoute(rid);
          });
        });
      }

      if (window.lucide) window.lucide.createIcons({ root: container });
    };

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        render(tab.getAttribute('data-saved'));
      });
    });

    render('stops');
  }

  // ----------------- Modals -----------------
  _bindModals() {
    const modal = document.getElementById('schedule-modal');
    const closeBtn = document.getElementById('close-schedule-modal');

    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  // ----------------- Mobile Drawer Drag -----------------
  _bindDrawerDrag() {
    const handle = document.getElementById('drawer-handle');
    if (!handle) return;

    let startY = 0;
    let currentY = 0;

    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      if (deltaY > 0) {
        this.sidePanel.style.transform = `translateY(${deltaY}px)`;
      }
    }, { passive: true });

    handle.addEventListener('touchend', () => {
      const deltaY = currentY - startY;
      this.sidePanel.style.transform = '';
      if (deltaY > 100) {
        this.closePanel();
        this.selectAction('explore');
      }
    });
  }

  // ----------------- Toast Notifications -----------------
  showToast(message, duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }
}

// Instantiate and Mount
window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.app = app;
  app.init().catch(err => {
    console.error('[App] Fatal startup error:', err);
  });
});
