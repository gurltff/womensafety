// Rover presets. Illustrative values for typical classes of lunar rover, not any vendor's real
// specifications: replace them with your own rover's numbers.
export const ROVERS = [
  {
    id: 'micro', name: 'Micro rover (CLPS payload class)',
    massKg: 15, solarW: 60, panel: 'vertical', batteryWh: 200, idleW: 12, hibernateW: 2, driveW: 15,
    speedMh: 100, maxSlopeDeg: 20, heatWperK: 0.04, rhuW: 0, minTempC: -30, maxTempC: 80, reservePct: 30, needsComms: true,
  },
  {
    id: 'mid', name: 'Mid-size rover (~120 kg)',
    massKg: 120, solarW: 250, panel: 'vertical', batteryWh: 1500, idleW: 45, hibernateW: 8, driveW: 120,
    speedMh: 150, maxSlopeDeg: 20, heatWperK: 0.15, rhuW: 0, minTempC: -30, maxTempC: 80, reservePct: 30, needsComms: true,
  },
  {
    id: 'large', name: 'Large polar rover (VIPER-like, ~450 kg)',
    massKg: 450, solarW: 450, panel: 'vertical', batteryWh: 3000, idleW: 120, hibernateW: 25, driveW: 250,
    speedMh: 200, maxSlopeDeg: 25, heatWperK: 0.35, rhuW: 0, minTempC: -30, maxTempC: 80, reservePct: 30, needsComms: true,
  },
];

// Fields shown in the rover form, in order: [key, label, unit, step].
export const ROVER_FIELDS = [
  ['massKg', 'Mass', 'kg', 1],
  ['solarW', 'Solar array (peak)', 'W', 5],
  ['batteryWh', 'Battery', 'Wh', 10],
  ['idleW', 'Awake power (avionics, comms)', 'W', 1],
  ['hibernateW', 'Hibernation power', 'W', 1],
  ['driveW', 'Extra power while driving', 'W', 5],
  ['speedMh', 'Driving speed', 'm/h', 5],
  ['maxSlopeDeg', 'Steepest slope it can climb', '°', 1],
  ['heatWperK', 'Heat leak (insulation)', 'W/K', 0.01],
  ['rhuW', 'Radioisotope heater units', 'W', 1],
  ['minTempC', 'Coldest allowed inside', '°C', 1],
  ['maxTempC', 'Hottest ground it can drive on', '°C', 1],
  ['reservePct', 'Stop driving below battery', '%', 1],
];
