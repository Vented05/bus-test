# AC Transit Maps — Live Bay Area Transit (`bus-test`)

[![GitHub Pages](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-brightgreen)](https://vented05.github.io/bus-test/)
[![AC Transit](https://img.shields.io/badge/Data-AC%20Transit%20Official-0072CE)](https://www.actransit.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A fast, smooth, Google Maps-inspired transit web application for AC Transit with real-time GPS bus tracking, interactive multi-modal route planning, live countdown departures, and active trip navigation.

🌐 **Live Website**: [https://vented05.github.io/bus-test/](https://vented05.github.io/bus-test/)

---

## 🌟 Key Features

- **Interactive 60 FPS Vector Map**: MapLibre GL JS vector map with official AC Transit Positron tiles, Night mode, Satellite imagery, 3D tilt, and high-accuracy GPS tracking.
- **Buses Displayed by Vehicle Number**: Real-time bus markers displaying route badge and exact bus vehicle number (e.g. `51A · #1711`, `60 · #2204`) with directional heading arrow.
- **Google Maps Active "Start Trip" Navigation**: Top guidance HUD + bottom status bar with live ETA, remaining minutes, remaining miles, and step progression.
- **⚡ 3:00 PM Afternoon Commute Preset**: 1-tap chip to test and plan peak afternoon transit journeys with full date/time synchronization.
- **Real-Time Stop Departures**: Bustime live countdown minutes, on-time/delay badges, and vehicle IDs.
- **120+ Line Directory**: Rapid (Tempo 1T BRT), Local, Transbay, All-Nighter, and School route geometries and timetables.
- **Zero-Setup Static & Local Modes**: Works seamlessly on GitHub Pages and locally with Node.js.

---

## 🚀 Running Locally

```bash
# Clone the repository
git clone https://github.com/Vented05/bus-test.git
cd bus-test

# Install dependencies
npm install

# Start local server
node server.js
```

Open `http://localhost:3000` in your browser.
