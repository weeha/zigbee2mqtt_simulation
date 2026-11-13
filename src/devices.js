// Device type definitions: what each simulated device exposes (Zigbee2MQTT "exposes"),
// how it is announced to Home Assistant (MQTT discovery) and how its state changes.

import { hexToRgb, rgbToHex, rgbToXy, xyToRgb, rgbToHs, hsToRgb, kelvinToRgb } from './color.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toNum = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const round = (v, d) => Number(v.toFixed(d));

// ---------------------------------------------------------------- exposes helpers
const numeric = (name, label, unit, description, extra = {}) => ({
  type: 'numeric', name, label, property: name, access: 1, unit, description, ...extra,
});
const EXP_BATTERY = numeric('battery', 'Battery', '%', 'Remaining battery in %', {
  value_min: 0, value_max: 100, category: 'diagnostic',
});
const EXP_LINKQUALITY = numeric('linkquality', 'Linkquality', 'lqi', 'Link quality (signal strength)', {
  value_min: 0, value_max: 255, category: 'diagnostic',
});

const P_BATTERY = { name: 'battery', label: 'Battery', kind: 'number', min: 0, max: 100, step: 1, unit: '%' };

export const COLOR_TEMP_MIN = 153;
export const COLOR_TEMP_MAX = 500;
const COLOR_TEMP_PRESETS = { coolest: 153, cool: 250, neutral: 370, warm: 454, warmest: 500 };

const binary = (name, label, description, value_on = true) => ({
  type: 'binary', name, label, property: name, access: 1, value_on, value_off: !value_on, description,
});
const actionExposes = (actions) => [
  EXP_BATTERY,
  { type: 'enum', name: 'action', label: 'Action', property: 'action', access: 1, values: actions, description: 'Triggered action (e.g. a button click)', category: 'diagnostic' },
  EXP_LINKQUALITY,
];
const P_SETPOINT = { name: 'occupied_heating_setpoint', label: 'Setpoint', kind: 'number', min: 4, max: 35, step: 0.5, unit: '°C' };
const P_ROOM_TEMPERATURE = { name: 'local_temperature', label: 'Room temperature', kind: 'number', min: -20, max: 60, step: 0.1, unit: '°C' };
const P_MODE = { name: 'system_mode', label: 'Mode', kind: 'enum', values: ['off', 'auto', 'heat'] };
const O_RUNNING = { name: 'running_state', label: 'Running state', kind: 'enum', values: ['idle', 'heat'] };
const CLIMATE_FEATURES = [
  { type: 'numeric', name: 'occupied_heating_setpoint', label: 'Occupied heating setpoint', property: 'occupied_heating_setpoint', access: 7, unit: '°C', value_min: 4, value_max: 35, value_step: 0.5, description: 'Temperature setpoint' },
  { type: 'numeric', name: 'local_temperature', label: 'Local temperature', property: 'local_temperature', access: 5, unit: '°C', description: 'Current temperature measured on the device' },
  { type: 'enum', name: 'system_mode', label: 'System mode', property: 'system_mode', access: 7, values: ['off', 'auto', 'heat'], description: 'Mode of this device' },
  { type: 'enum', name: 'running_state', label: 'Running state', property: 'running_state', access: 5, values: ['idle', 'heat'], description: 'The current running state' },
];
const EXP_STATE = { type: 'binary', name: 'state', label: 'State', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE' };

// props:     what the web UI / scenarios can change ("sim: true" lives in device.sim instead of the state)
// settable:  what may be changed over MQTT (<name>/set); 'all' or a list of attributes
// simFields: simulation settings that the web UI may change
// observe:   read-only values a scenario can check in addition to the props
// actions:   what a remote can send on <name>/action
export const TYPES = {
  light: {
    label: 'Color light',
    vendor: 'Philips',
    model: '9290022166',
    modelId: 'LCA001',
    description: 'Hue white and color ambiance E26/E27',
    powerSource: 'Mains (single phase)',
    zigbeeType: 'Router',
    settable: 'all',
    defaults: () => ({
      state: 'OFF',
      brightness: 254,
      color_mode: 'color_temp',
      color_temp: 370,
      color: colorFromRgb(...kelvinToRgb(1e6 / 370)),
    }),
    props: [
      { name: 'state', label: 'State', kind: 'enum', values: ['ON', 'OFF', 'TOGGLE'] },
      { name: 'brightness', label: 'Brightness', kind: 'number', min: 0, max: 254, step: 1 },
      { name: 'color_temp', label: 'Color temperature', kind: 'number', min: COLOR_TEMP_MIN, max: COLOR_TEMP_MAX, step: 1, unit: 'mired' },
      { name: 'color', label: 'Color', kind: 'color' },
    ],
    exposes: [
      {
        type: 'light',
        features: [
          { ...EXP_STATE, description: 'On/off state of this light' },
          { type: 'numeric', name: 'brightness', label: 'Brightness', property: 'brightness', access: 7, value_min: 0, value_max: 254, description: 'Brightness of this light' },
          {
            type: 'numeric', name: 'color_temp', label: 'Color temp', property: 'color_temp', access: 7, unit: 'mired',
            value_min: COLOR_TEMP_MIN, value_max: COLOR_TEMP_MAX, description: 'Color temperature of this light',
            presets: Object.entries(COLOR_TEMP_PRESETS).map(([name, value]) => ({ name, value, description: `Color temperature ${value} mired` })),
          },
          {
            type: 'composite', name: 'color_xy', label: 'Color (X/Y)', property: 'color', access: 7,
            description: 'Color of this light in the CIE 1931 color space (x/y)',
            features: [
              { type: 'numeric', name: 'x', label: 'X', property: 'x', access: 7 },
              { type: 'numeric', name: 'y', label: 'Y', property: 'y', access: 7 },
            ],
          },
          {
            type: 'composite', name: 'color_hs', label: 'Color (HS)', property: 'color', access: 7,
            description: 'Color of this light expressed as hue/saturation',
            features: [
              { type: 'numeric', name: 'hue', label: 'Hue', property: 'hue', access: 7 },
              { type: 'numeric', name: 'saturation', label: 'Saturation', property: 'saturation', access: 7 },
            ],
          },
        ],
      },
      EXP_LINKQUALITY,
    ],
  },

  plug: {
    label: 'Smart plug (power metering)',
    vendor: 'Tuya',
    model: 'TS011F_plug_1',
    modelId: 'TS011F',
    description: 'Smart plug (with power monitoring)',
    powerSource: 'Mains (single phase)',
    zigbeeType: 'Router',
    settable: ['state'],
    defaults: () => ({ state: 'OFF', power: 0, current: 0, voltage: 230, energy: 0 }),
    sim: () => ({ load: 60 }),
    props: [
      { name: 'state', label: 'State', kind: 'enum', values: ['ON', 'OFF'], toggle: true },
      { name: 'load', label: 'Connected load', kind: 'number', min: 0, max: 3500, step: 1, unit: 'W', sim: true },
    ],
    observe: [
      { name: 'power', label: 'Power', kind: 'number', min: 0, max: 3500, unit: 'W' },
      { name: 'energy', label: 'Energy', kind: 'number', min: 0, max: 100000, unit: 'kWh' },
    ],
    exposes: [
      { type: 'switch', features: [{ ...EXP_STATE, description: 'On/off state of the switch' }] },
      numeric('power', 'Power', 'W', 'Instantaneous measured power'),
      numeric('current', 'Current', 'A', 'Instantaneous measured electrical current'),
      numeric('voltage', 'Voltage', 'V', 'Measured electrical potential value'),
      numeric('energy', 'Energy', 'kWh', 'Sum of consumed energy'),
      EXP_LINKQUALITY,
    ],
  },

  thermostat: {
    label: 'Radiator thermostat',
    vendor: 'SONOFF',
    model: 'TRVZB',
    modelId: 'TRVZB',
    description: 'Zigbee thermostatic radiator valve',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    settable: ['occupied_heating_setpoint', 'system_mode'],
    defaults: () => ({ occupied_heating_setpoint: 21, local_temperature: 20, system_mode: 'heat', running_state: 'heat', battery: 100 }),
    sim: () => ({ auto: false, ambient: 17 }),
    simFields: { auto: 'bool', ambient: [-20, 40] },
    props: [
      P_SETPOINT,
      P_ROOM_TEMPERATURE,
      P_MODE,
      P_BATTERY,
    ],
    observe: [O_RUNNING],
    exposes: [
      {
        type: 'climate',
        features: [
          { type: 'numeric', name: 'occupied_heating_setpoint', label: 'Occupied heating setpoint', property: 'occupied_heating_setpoint', access: 7, unit: '°C', value_min: 4, value_max: 35, value_step: 0.5, description: 'Temperature setpoint' },
          { type: 'numeric', name: 'local_temperature', label: 'Local temperature', property: 'local_temperature', access: 5, unit: '°C', description: 'Current temperature measured on the device' },
          { type: 'enum', name: 'system_mode', label: 'System mode', property: 'system_mode', access: 7, values: ['off', 'auto', 'heat'], description: 'Mode of this device' },
          { type: 'enum', name: 'running_state', label: 'Running state', property: 'running_state', access: 5, values: ['idle', 'heat'], description: 'The current running state' },
        ],
      },
      EXP_BATTERY,
      EXP_LINKQUALITY,
    ],
  },

  trv: {
    label: 'Radiator thermostat with valve position',
    vendor: 'Bosch',
    model: 'BTH-RA',
    modelId: 'RBSH-TRV0-ZB-EU',
    description: 'Radiator thermostat II',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    settable: ['occupied_heating_setpoint', 'system_mode', 'window_detection'],
    defaults: () => ({
      occupied_heating_setpoint: 21, local_temperature: 20, system_mode: 'heat', running_state: 'heat',
      pi_heating_demand: 40, window_detection: 'OFF', battery: 100,
    }),
    sim: () => ({ detect: true }), // detect: notices a sudden temperature drop and pauses heating by itself
    simFields: { detect: 'bool' },
    props: [
      P_SETPOINT,
      P_ROOM_TEMPERATURE,
      P_MODE,
      { name: 'window_detection', label: 'Window open mode', kind: 'enum', values: ['ON', 'OFF'], toggle: true },
      P_BATTERY,
    ],
    observe: [O_RUNNING, { name: 'pi_heating_demand', label: 'Valve position', kind: 'number', min: 0, max: 100, unit: '%' }],
    exposes: [
      { type: 'climate', features: CLIMATE_FEATURES },
      numeric('pi_heating_demand', 'PI heating demand', '%', 'Position of the valve (= demanded heat) where 0% is fully closed and 100% is fully open', { value_min: 0, value_max: 100 }),
      { type: 'binary', name: 'window_detection', label: 'Window detection', property: 'window_detection', access: 7, value_on: 'ON', value_off: 'OFF', description: 'Window open mode: heating is paused while it is on' },
      EXP_BATTERY,
      EXP_LINKQUALITY,
    ],
  },

  cover: {
    label: 'Roller blind',
    vendor: 'IKEA',
    model: 'E1757',
    modelId: 'FYRTUR block-out roller blind',
    description: 'FYRTUR roller blind, block-out',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    settable: ['state', 'position'],
    defaults: () => ({ state: 'OPEN', position: 100, battery: 100 }),
    props: [
      { name: 'position', label: 'Position', kind: 'number', min: 0, max: 100, step: 1, unit: '% open' },
      { name: 'state', label: 'Command', kind: 'enum', values: ['OPEN', 'CLOSE', 'STOP'] },
      P_BATTERY,
    ],
    exposes: [
      {
        type: 'cover',
        features: [
          { type: 'enum', name: 'state', label: 'State', property: 'state', access: 3, values: ['OPEN', 'CLOSE', 'STOP'] },
          { type: 'numeric', name: 'position', label: 'Position', property: 'position', access: 7, unit: '%', value_min: 0, value_max: 100, description: 'Position of this cover' },
        ],
      },
      EXP_BATTERY,
      EXP_LINKQUALITY,
    ],
  },

  sensor: {
    label: 'Temperature & humidity sensor',
    vendor: 'SONOFF',
    model: 'SNZB-02',
    modelId: 'TH01',
    description: 'Temperature and humidity sensor',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    defaults: () => ({ temperature: 21.5, humidity: 48, battery: 100 }),
    sim: () => ({ auto: false, interval: 30, outdoor: false }),
    simFields: { auto: 'bool', interval: [1, 3600], outdoor: 'bool' }, // outdoor: follows the simulated weather
    props: [
      { name: 'temperature', label: 'Temperature', kind: 'number', min: -40, max: 80, step: 0.1, unit: '°C' },
      { name: 'humidity', label: 'Humidity', kind: 'number', min: 0, max: 100, step: 0.1, unit: '%' },
      P_BATTERY,
    ],
    exposes: [
      EXP_BATTERY,
      numeric('temperature', 'Temperature', '°C', 'Measured temperature value'),
      numeric('humidity', 'Humidity', '%', 'Measured relative humidity'),
      EXP_LINKQUALITY,
    ],
  },

  air: {
    label: 'Air quality sensor',
    vendor: 'Tuya',
    model: 'TS0601_air_quality_sensor',
    modelId: 'TS0601',
    description: 'Air quality sensor',
    powerSource: 'DC Source',
    zigbeeType: 'EndDevice',
    defaults: () => ({ co2: 600, voc: 120, temperature: 21.5, humidity: 48 }),
    props: [
      { name: 'co2', label: 'CO₂', kind: 'number', min: 350, max: 5000, step: 1, unit: 'ppm' },
      { name: 'voc', label: 'VOC', kind: 'number', min: 0, max: 5000, step: 1, unit: 'ppb' },
      { name: 'temperature', label: 'Temperature', kind: 'number', min: -40, max: 80, step: 0.1, unit: '°C' },
      { name: 'humidity', label: 'Humidity', kind: 'number', min: 0, max: 100, step: 0.1, unit: '%' },
    ],
    exposes: [
      numeric('temperature', 'Temperature', '°C', 'Measured temperature value'),
      numeric('humidity', 'Humidity', '%', 'Measured relative humidity'),
      numeric('co2', 'CO2', 'ppm', 'The measured CO2 (carbon dioxide) value'),
      numeric('voc', 'VOC', 'ppb', 'Measured VOC value'),
      EXP_LINKQUALITY,
    ],
  },

  motion: {
    label: 'Motion sensor',
    vendor: 'Aqara',
    model: 'RTCGQ11LM',
    modelId: 'lumi.sensor_motion.aq2',
    description: 'Motion sensor',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    defaults: () => ({ occupancy: false, illuminance: 120, battery: 100 }),
    sim: () => ({ timeout: 90, sun: false, peak: 400 }),
    simFields: { timeout: [0, 3600], sun: 'bool', peak: [0, 10000] }, // sun: illuminance follows the daylight, up to "peak" lx
    props: [
      { name: 'occupancy', label: 'Occupancy', kind: 'bool', labels: { true: 'motion detected', false: 'clear' } },
      { name: 'illuminance', label: 'Illuminance', kind: 'number', min: 0, max: 10000, step: 1, unit: 'lx' },
      P_BATTERY,
    ],
    exposes: [
      EXP_BATTERY,
      binary('occupancy', 'Occupancy', 'Indicates whether the device detected occupancy'),
      numeric('illuminance', 'Illuminance', 'lx', 'Measured illuminance'),
      EXP_LINKQUALITY,
    ],
  },

  presence: {
    label: 'Presence sensor (mmWave)',
    vendor: 'Aqara',
    model: 'RTCZCGQ11LM',
    modelId: 'lumi.motion.ac01',
    description: 'Presence sensor FP1',
    powerSource: 'DC Source',
    zigbeeType: 'EndDevice',
    defaults: () => ({ presence: false, presence_event: 'leave' }),
    props: [{ name: 'presence', label: 'Presence', kind: 'bool', labels: { true: 'somebody is here', false: 'nobody' } }],
    observe: [{ name: 'presence_event', label: 'Presence event', kind: 'enum', values: ['enter', 'leave'] }],
    exposes: [
      binary('presence', 'Presence', 'Indicates whether the device detected presence'),
      { type: 'enum', name: 'presence_event', label: 'Presence event', property: 'presence_event', access: 1, values: ['enter', 'leave', 'left_enter', 'right_leave', 'right_enter', 'left_leave', 'approach', 'away'], description: 'Presence events' },
      EXP_LINKQUALITY,
    ],
  },

  window: {
    label: 'Window sensor',
    vendor: 'Aqara',
    model: 'MCCGQ11LM',
    modelId: 'lumi.sensor_magnet.aq2',
    description: 'Door and window sensor',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    defaults: () => ({ contact: true, battery: 100 }),
    props: [
      { name: 'contact', label: 'Contact', kind: 'bool', labels: { true: 'closed', false: 'open' } },
      P_BATTERY,
    ],
    exposes: [
      EXP_BATTERY,
      binary('contact', 'Contact', 'Indicates if the contact is closed (= true) or open (= false)', false),
      EXP_LINKQUALITY,
    ],
  },

  leak: {
    label: 'Water leak sensor',
    vendor: 'Aqara',
    model: 'SJCGQ11LM',
    modelId: 'lumi.sensor_wleak.aq1',
    description: 'Water leak sensor',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    defaults: () => ({ water_leak: false, battery: 100 }),
    props: [
      { name: 'water_leak', label: 'Water leak', kind: 'bool', labels: { true: 'leak detected', false: 'dry' } },
      P_BATTERY,
    ],
    exposes: [EXP_BATTERY, binary('water_leak', 'Water leak', 'Indicates whether the device detected a water leak'), EXP_LINKQUALITY],
  },

  smoke: {
    label: 'Smoke detector',
    vendor: 'Aqara',
    model: 'JTYJ-GD-01LM/BW',
    modelId: 'lumi.sensor_smoke',
    description: 'Smoke detector',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    defaults: () => ({ smoke: false, battery: 100 }),
    props: [
      { name: 'smoke', label: 'Smoke', kind: 'bool', labels: { true: 'smoke detected', false: 'clear' } },
      P_BATTERY,
    ],
    exposes: [EXP_BATTERY, binary('smoke', 'Smoke', 'Indicates whether the device detected smoke'), EXP_LINKQUALITY],
  },

  lock: {
    label: 'Door lock',
    vendor: 'Yale',
    model: 'YRD226HA2619',
    modelId: 'YRD226 TSDB',
    description: 'Assure lock',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    settable: ['state'],
    defaults: () => ({ state: 'LOCK', lock_state: 'locked', battery: 100 }),
    props: [{ name: 'state', label: 'Lock', kind: 'enum', values: ['LOCK', 'UNLOCK'], toggle: true }, P_BATTERY],
    observe: [{ name: 'lock_state', label: 'Lock state', kind: 'enum', values: ['locked', 'unlocked'] }],
    exposes: [
      {
        type: 'lock',
        features: [
          { type: 'binary', name: 'state', label: 'State', property: 'state', access: 7, value_on: 'LOCK', value_off: 'UNLOCK', description: 'State of the lock' },
          { type: 'enum', name: 'lock_state', label: 'Lock state', property: 'lock_state', access: 1, values: ['not_fully_locked', 'locked', 'unlocked'], description: 'Actual state of the lock' },
        ],
      },
      EXP_BATTERY,
      EXP_LINKQUALITY,
    ],
  },

  siren: {
    label: 'Siren',
    vendor: 'Neo',
    model: 'NAS-AB02B2',
    modelId: 'TS0601',
    description: 'Alarm',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    settable: ['alarm', 'volume', 'duration', 'melody'],
    defaults: () => ({ alarm: false, volume: 'medium', duration: 10, melody: 1, battery: 100 }),
    props: [
      { name: 'alarm', label: 'Alarm', kind: 'bool', labels: { true: 'sounding', false: 'silent' } },
      { name: 'volume', label: 'Volume', kind: 'enum', values: ['low', 'medium', 'high'] },
      { name: 'duration', label: 'Duration', kind: 'number', min: 1, max: 1800, step: 1, unit: 's' },
      { name: 'melody', label: 'Melody', kind: 'number', min: 1, max: 18, step: 1 },
      P_BATTERY,
    ],
    exposes: [
      { type: 'binary', name: 'alarm', label: 'Alarm', property: 'alarm', access: 3, value_on: true, value_off: false, description: 'Sound the alarm' },
      { type: 'enum', name: 'volume', label: 'Volume', property: 'volume', access: 3, values: ['low', 'medium', 'high'], description: 'Volume of the alarm' },
      numeric('duration', 'Duration', 's', 'How long the alarm sounds', { access: 3, value_min: 1, value_max: 1800 }),
      numeric('melody', 'Melody', undefined, 'Which melody is played', { access: 3, value_min: 1, value_max: 18 }),
      EXP_BATTERY,
      EXP_LINKQUALITY,
    ],
  },

  button: {
    label: 'Button',
    vendor: 'Aqara',
    model: 'WXKG11LM',
    modelId: 'lumi.remote.b1acn01',
    description: 'Wireless mini switch',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    actions: ['single', 'double', 'triple', 'quadruple', 'hold', 'release'],
    defaults: () => ({ battery: 100 }),
    props: [P_BATTERY],
    get exposes() {
      return actionExposes(this.actions);
    },
  },

  dial: {
    label: 'Dial remote (4 buttons and rotation)',
    vendor: 'Philips',
    model: '8719514440937',
    modelId: 'RDM002',
    description: 'Hue Tap dial switch',
    powerSource: 'Battery',
    zigbeeType: 'EndDevice',
    actions: [
      ...[1, 2, 3, 4].flatMap((n) => ['press', 'press_release', 'hold', 'hold_release'].map((kind) => `button_${n}_${kind}`)),
      ...['left', 'right'].flatMap((side) => ['step', 'slow', 'fast'].map((kind) => `dial_rotate_${side}_${kind}`)),
    ],
    /** What the real remote reports along with a rotation. */
    actionExtra: (action) => {
      const m = /^dial_rotate_(left|right)_(step|slow|fast)$/.exec(action);
      return m ? { action_direction: m[1], action_type: m[2] === 'step' ? 'step' : 'rotate', action_time: { step: 0, slow: 15, fast: 60 }[m[2]] } : {};
    },
    defaults: () => ({ battery: 100 }),
    props: [P_BATTERY],
    get exposes() {
      return actionExposes(this.actions);
    },
  },
};

// ---------------------------------------------------------------- state handling

function colorFromRgb(r, g, b) {
  return { ...rgbToXy(r, g, b), ...rgbToHs(r, g, b) };
}

function parseColor(c) {
  if (typeof c === 'string') {
    const rgb = hexToRgb(c);
    return rgb ? colorFromRgb(...rgb) : null;
  }
  if (!c || typeof c !== 'object') return null;
  const x = toNum(c.x);
  const y = toNum(c.y);
  if (x !== undefined && y !== undefined) {
    const cx = round(clamp(x, 0, 1), 4);
    const cy = round(clamp(y, 0, 1), 4);
    return { x: cx, y: cy, ...rgbToHs(...xyToRgb(cx, cy)) };
  }
  if (c.hex !== undefined) return parseColor(String(c.hex));
  if (typeof c.rgb === 'string') {
    const parts = c.rgb.split(',').map(toNum);
    if (parts.length === 3 && parts.every((p) => p !== undefined)) return colorFromRgb(...parts.map((p) => clamp(p, 0, 255)));
    return null;
  }
  const [r, g, b] = [toNum(c.r), toNum(c.g), toNum(c.b)];
  if (r !== undefined && g !== undefined && b !== undefined) return colorFromRgb(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255));
  const hue = toNum(c.hue ?? c.h);
  const sat = toNum(c.saturation ?? c.s);
  if (hue !== undefined || sat !== undefined) return colorFromRgb(...hsToRgb(hue ?? 0, sat ?? 100));
  return null;
}

function applyLight(s, v) {
  let changed = false;
  if (v.state !== undefined) {
    const st = String(v.state).toUpperCase();
    if (st === 'TOGGLE') { s.state = s.state === 'ON' ? 'OFF' : 'ON'; changed = true; }
    else if (st === 'ON' || st === 'OFF') { s.state = st; changed = true; }
  }
  let b = toNum(v.brightness);
  if (b === undefined && toNum(v.brightness_percent) !== undefined) b = toNum(v.brightness_percent) * 2.54;
  if (b !== undefined) {
    b = clamp(Math.round(b), 0, 254);
    if (b === 0) s.state = 'OFF';
    else {
      s.brightness = b;
      if (v.state === undefined) s.state = 'ON'; // like a real bulb: a level command switches it on
    }
    changed = true;
  }
  if (v.color_temp !== undefined) {
    const ct = toNum(COLOR_TEMP_PRESETS[v.color_temp] ?? v.color_temp);
    if (ct !== undefined) {
      s.color_temp = clamp(Math.round(ct), COLOR_TEMP_MIN, COLOR_TEMP_MAX);
      s.color_mode = 'color_temp';
      s.color = colorFromRgb(...kelvinToRgb(1e6 / s.color_temp));
      changed = true;
    }
  }
  if (v.color !== undefined) {
    const color = parseColor(v.color);
    if (color) {
      s.color = color;
      s.color_mode = 'xy';
      changed = true;
    }
  }
  return changed;
}

function parseBool(v, labels = {}) {
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (s === labels.true || ['true', '1', 'on', 'closed', 'close'].includes(s)) return true;
  if (s === labels.false || ['false', '0', 'off', 'open', 'opened'].includes(s)) return false;
  return undefined;
}

/** Values that follow from other values (a plug's power, whether a thermostat is heating). */
function derive(dev) {
  const s = dev.state;
  if (dev.type === 'plug') {
    s.power = s.state === 'ON' ? dev.sim.load : 0;
    s.current = round(s.power / s.voltage, 2);
  }
  if (dev.type === 'thermostat') {
    if (s.system_mode === 'off') s.running_state = 'idle';
    else if (s.local_temperature < s.occupied_heating_setpoint - 0.2) s.running_state = 'heat';
    else if (s.local_temperature >= s.occupied_heating_setpoint) s.running_state = 'idle';
  }
  if (dev.type === 'trv') {
    // The valve opens in proportion to how far the room is below the setpoint (fully open at 2.5 °C).
    const paused = s.system_mode === 'off' || s.window_detection === 'ON';
    s.pi_heating_demand = paused ? 0 : clamp(Math.ceil((s.occupied_heating_setpoint - s.local_temperature) * 8) * 5, 0, 100);
    s.running_state = s.pi_heating_demand > 0 ? 'heat' : 'idle';
  }
  if (dev.type === 'lock') s.lock_state = s.state === 'LOCK' ? 'locked' : 'unlocked';
  if (dev.type === 'presence') s.presence_event = s.presence ? 'enter' : 'leave';
}

// ---------------------------------------------------------------- firmware (OTA updates)

const FIRMWARE = 16777220; // Zigbee file versions are plain numbers

/** The firmware of a device: { installed, latest, state: idle | available | updating, progress?, remaining? } */
export function otaOf(dev) {
  return (dev.ota ??= { installed: FIRMWARE, latest: FIRMWARE, state: 'idle' });
}

/** Applies a set of values to a device. Returns true if something was accepted. */
export function applyValues(dev, values) {
  if (!values || typeof values !== 'object') return false;
  if (dev.type === 'light') return applyLight(dev.state, values);
  let changed = false;
  for (const p of TYPES[dev.type].props) {
    if (!(p.name in values)) continue;
    const target = p.sim ? dev.sim : dev.state;
    const raw = values[p.name];
    let v;
    if (p.kind === 'number') {
      v = toNum(raw);
      if (v !== undefined) v = clamp(round(Math.round(v / p.step) * p.step, 2), p.min, p.max);
    } else if (p.kind === 'bool') {
      v = parseBool(raw, p.labels);
    } else if (p.kind === 'enum') {
      const text = String(raw).toLowerCase();
      v = p.values.find((x) => x.toLowerCase() === text);
      if (v === undefined && text === 'toggle' && p.toggle) v = target[p.name] === p.values[0] ? p.values[1] : p.values[0];
    }
    if (v !== undefined) {
      target[p.name] = v;
      changed = true;
    }
  }
  derive(dev);
  return changed;
}

/** The JSON a device publishes on its state topic (without linkquality). */
export function statePayload(dev) {
  const s = { ...dev.state };
  if (dev.type === 'plug') s.energy = round(s.energy, 3);
  const { installed, latest, state, progress, remaining } = otaOf(dev);
  s.update = { state, installed_version: installed, latest_version: latest, ...(state === 'updating' ? { progress, remaining } : {}) };
  return s;
}

/** What a scenario can check on a device of this type: the reported values, without pure commands. */
export function observables(type) {
  const t = TYPES[type];
  const own = t.props.filter((p) => !p.sim).map((p) => {
    if (p.kind !== 'enum') return p;
    const label = type === 'cover' && p.name === 'state' ? 'State' : p.label;
    return { ...p, label, values: p.values.filter((v) => v !== 'TOGGLE' && v !== 'STOP') };
  });
  const update = { name: 'update_state', label: 'Firmware update', kind: 'enum', values: ['idle', 'available', 'updating'] };
  return [...own, ...(t.observe || []), update];
}

/** Current value of something from observables(); a light's colour is reported as #rrggbb. */
export function observe(dev, property) {
  if (dev.type === 'light' && property === 'color') return lightHex(dev.state);
  if (property === 'update_state') return otaOf(dev).state;
  return dev.state[property];
}

/** Colour to show in the web UI for a light. */
export function lightHex(state) {
  const rgb = state.color_mode === 'color_temp' ? kelvinToRgb(1e6 / state.color_temp) : xyToRgb(state.color.x, state.color.y);
  return rgbToHex(...rgb);
}

// ---------------------------------------------------------------- bridge/devices entry

export function bridgeDeviceEntry(dev) {
  const t = TYPES[dev.type];
  return {
    ieee_address: dev.ieee,
    type: t.zigbeeType,
    network_address: dev.network_address,
    supported: true,
    friendly_name: dev.friendly_name,
    disabled: false,
    definition: {
      model: t.model,
      vendor: t.vendor,
      description: t.description,
      exposes: t.exposes,
      options: [],
      supports_ota: true,
      source: 'native',
    },
    power_source: t.powerSource,
    model_id: t.modelId,
    manufacturer: t.vendor,
    software_build_id: String(otaOf(dev).installed),
    interview_completed: true,
    interviewing: false,
    interview_state: 'SUCCESSFUL',
    endpoints: { 1: { bindings: [], configured_reportings: [], clusters: { input: [], output: [] }, scenes: [] } },
  };
}

// ---------------------------------------------------------------- Home Assistant discovery

/**
 * Returns the retained discovery messages for one device as [{topic, payload}].
 * ctx: { base, discovery, coordinator, version }
 */
export function buildDiscovery(dev, ctx) {
  const t = TYPES[dev.type];
  const stateTopic = `${ctx.base}/${dev.friendly_name}`;
  const common = {
    availability: [
      { topic: `${ctx.base}/bridge/state`, value_template: '{{ value_json.state }}' },
      { topic: `${stateTopic}/availability`, value_template: '{{ value_json.state }}' },
    ],
    availability_mode: 'all',
    device: {
      identifiers: [`zigbee2mqtt_${dev.ieee}`],
      name: dev.friendly_name,
      manufacturer: t.vendor,
      model: t.description,
      model_id: t.model,
      via_device: `zigbee2mqtt_bridge_${ctx.coordinator}`,
    },
    origin: { name: 'Zigbee2MQTT Simulator', sw: ctx.version, url: 'https://www.zigbee2mqtt.io' },
  };
  const out = [];
  const add = (component, objectId, payload) =>
    out.push({
      topic: `${ctx.discovery}/${component}/${dev.ieee}/${objectId}/config`,
      payload: { ...common, unique_id: `${dev.ieee}_${objectId}_zigbee2mqtt`, ...payload },
    });
  const sensor = (objectId, name, extra) =>
    add('sensor', objectId, {
      name,
      state_topic: stateTopic,
      value_template: `{{ value_json.${objectId} }}`,
      state_class: 'measurement',
      ...extra,
    });

  const binarySensor = (objectId, deviceClass, onValue = true) =>
    add('binary_sensor', objectId, {
      name: null,
      state_topic: stateTopic,
      value_template: `{{ value_json.${objectId} }}`,
      payload_on: onValue,
      payload_off: !onValue,
      device_class: deviceClass,
    });

  if (dev.type === 'plug') {
    add('switch', 'switch', {
      name: null,
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set`,
      value_template: '{{ value_json.state }}',
      payload_on: 'ON',
      payload_off: 'OFF',
    });
    sensor('power', 'Power', { device_class: 'power', unit_of_measurement: 'W' });
    sensor('energy', 'Energy', { device_class: 'energy', unit_of_measurement: 'kWh', state_class: 'total_increasing' });
    sensor('current', 'Current', { device_class: 'current', unit_of_measurement: 'A' });
    sensor('voltage', 'Voltage', { device_class: 'voltage', unit_of_measurement: 'V' });
  }
  if (dev.type === 'thermostat' || dev.type === 'trv') {
    add('climate', 'climate', {
      name: null,
      temperature_unit: 'C',
      temp_step: 0.5,
      min_temp: 4,
      max_temp: 35,
      current_temperature_topic: stateTopic,
      current_temperature_template: '{{ value_json.local_temperature }}',
      temperature_state_topic: stateTopic,
      temperature_state_template: '{{ value_json.occupied_heating_setpoint }}',
      temperature_command_topic: `${stateTopic}/set/occupied_heating_setpoint`,
      modes: ['off', 'auto', 'heat'],
      mode_state_topic: stateTopic,
      mode_state_template: '{{ value_json.system_mode }}',
      mode_command_topic: `${stateTopic}/set/system_mode`,
      action_topic: stateTopic,
      action_template: "{% set values = {None:None,'idle':'idle','heat':'heating','cool':'cooling','fan_only':'fan'} %}{{ values[value_json.running_state] }}",
    });
  }
  if (dev.type === 'trv') {
    sensor('pi_heating_demand', 'Valve position', { unit_of_measurement: '%', icon: 'mdi:radiator' });
    add('switch', 'window_detection', {
      name: 'Window open mode',
      icon: 'mdi:window-open-variant',
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set/window_detection`,
      value_template: '{{ value_json.window_detection }}',
      payload_on: 'ON',
      payload_off: 'OFF',
    });
  }
  if (dev.type === 'lock') {
    add('lock', 'lock', {
      name: null,
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set`,
      value_template: '{{ value_json.state }}',
      payload_lock: 'LOCK',
      payload_unlock: 'UNLOCK',
      state_locked: 'LOCK',
      state_unlocked: 'UNLOCK',
    });
  }
  if (dev.type === 'siren') {
    add('switch', 'alarm', {
      name: 'Alarm',
      icon: 'mdi:alarm-light',
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set/alarm`,
      value_template: "{{ 'ON' if value_json.alarm else 'OFF' }}",
      state_on: 'ON',
      state_off: 'OFF',
      payload_on: 'true',
      payload_off: 'false',
    });
    add('select', 'volume', {
      name: 'Volume',
      entity_category: 'config',
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set/volume`,
      value_template: '{{ value_json.volume }}',
      options: ['low', 'medium', 'high'],
    });
    add('number', 'duration', {
      name: 'Duration',
      entity_category: 'config',
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set/duration`,
      value_template: '{{ value_json.duration }}',
      min: 1,
      max: 1800,
      unit_of_measurement: 's',
    });
  }
  if (dev.type === 'presence') {
    binarySensor('presence', 'presence');
    sensor('presence_event', 'Presence event', { state_class: undefined, device_class: 'enum', options: ['enter', 'leave'] });
  }
  if (dev.type === 'air') {
    sensor('co2', 'CO2', { device_class: 'carbon_dioxide', unit_of_measurement: 'ppm' });
    sensor('voc', 'VOC', { device_class: 'volatile_organic_compounds_parts', unit_of_measurement: 'ppb' });
    sensor('temperature', 'Temperature', { device_class: 'temperature', unit_of_measurement: '°C' });
    sensor('humidity', 'Humidity', { device_class: 'humidity', unit_of_measurement: '%' });
  }
  if (dev.type === 'cover') {
    add('cover', 'cover', {
      name: null,
      device_class: 'blind',
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set`,
      value_template: '{{ value_json.state }}',
      state_open: 'OPEN',
      state_closed: 'CLOSE',
      state_stopped: 'STOP',
      position_topic: stateTopic,
      position_template: '{{ value_json.position }}',
      set_position_topic: `${stateTopic}/set`,
      set_position_template: '{ "position": {{ position }} }',
    });
  }
  if (dev.type === 'motion') {
    binarySensor('occupancy', 'occupancy');
    sensor('illuminance', 'Illuminance', { device_class: 'illuminance', unit_of_measurement: 'lx' });
  }
  if (dev.type === 'leak') binarySensor('water_leak', 'moisture');
  if (dev.type === 'smoke') binarySensor('smoke', 'smoke');
  if (dev.type === 'window') binarySensor('contact', 'window', false);
  if (dev.type === 'sensor') {
    sensor('temperature', 'Temperature', { device_class: 'temperature', unit_of_measurement: '°C' });
    sensor('humidity', 'Humidity', { device_class: 'humidity', unit_of_measurement: '%' });
  }
  if (dev.type === 'light') {
    add('light', 'light', {
      name: null,
      schema: 'json',
      state_topic: stateTopic,
      command_topic: `${stateTopic}/set`,
      brightness: true,
      brightness_scale: 254,
      supported_color_modes: ['xy', 'color_temp'],
      min_mireds: COLOR_TEMP_MIN,
      max_mireds: COLOR_TEMP_MAX,
    });
  }
  if (t.actions) {
    add('event', 'action', {
      name: 'Action',
      state_topic: stateTopic,
      event_types: t.actions,
      icon: 'mdi:gesture-double-tap',
      value_template:
        "{% if value_json.action is defined and value_json.action %}{{ {'event_type': value_json.action} | tojson }}{% endif %}",
    });
    for (const action of t.actions) {
      out.push({
        topic: `${ctx.discovery}/device_automation/${dev.ieee}/action_${action}/config`,
        payload: {
          automation_type: 'trigger',
          type: 'action',
          subtype: action,
          payload: action,
          topic: `${stateTopic}/action`,
          device: common.device,
          origin: common.origin,
        },
      });
    }
  }
  if (t.powerSource === 'Battery') {
    sensor('battery', 'Battery', { device_class: 'battery', unit_of_measurement: '%', entity_category: 'diagnostic' });
  }
  add('update', 'update', {
    name: null,
    device_class: 'firmware',
    entity_category: 'config',
    state_topic: stateTopic,
    value_template: "{{ {'installed_version': value_json['update']['installed_version'] | string, 'latest_version': value_json['update']['latest_version'] | string, "
      + "'in_progress': value_json['update']['state'] == 'updating', 'update_percentage': value_json['update'].get('progress')} | tojson }}",
    command_topic: `${ctx.base}/bridge/request/device/ota_update/update`,
    payload_install: JSON.stringify({ id: dev.ieee }),
  });
  sensor('linkquality', 'Linkquality', {
    unit_of_measurement: 'lqi',
    icon: 'mdi:signal',
    entity_category: 'diagnostic',
    enabled_by_default: false,
  });
  return out;
}
