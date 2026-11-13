// The simulated Zigbee2MQTT instance: owns the virtual devices, talks MQTT like the real
// bridge (bridge/* topics, device state, /set + /get, availability, HA discovery).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { DAY, SPEEDS, clockDefaults, environment, formatTime, parseTime } from './clock.js';
import { TYPES, applyValues, bridgeDeviceEntry, buildDiscovery, lightHex, observables, otaOf, statePayload } from './devices.js';

export const VERSION = '2.6.3-sim';
const LOG_SIZE = 300;
const COVER_SPEED = 10; // percent per second
const CLOCK_STEP = 250; // milliseconds between two steps of the simulated clock
const DEFAULT_PEAK = 400; // lx a sun-following motion sensor sees at noon
// Room physics, per second. Fast enough to watch, not meant to be realistic.
const HEAT_RATE = 0.05; // °C a heating radiator adds
const AIRING_RATE = 0.02; // share of the gap to outdoors that one open window closes
const LEAK_RATE = 0.0003; // the same for a closed room (walls)
const SETTLE_RATE = 0.002; // humidity settling at REST_HUMIDITY while the windows are closed
const REST_HUMIDITY = 50;
const CO2_OUTDOORS = 420; // ppm
const CO2_PER_PERSON = 3; // ppm per second somebody is in the room
const CO2_SETTLE_RATE = 0.0005; // a closed, empty room slowly returns to outdoor air
const WINDOW_DROP = 1.5; // °C within WINDOW_SPAN that make a thermostat assume an open window
const WINDOW_SPAN = 30; // seconds
const OTA_SECONDS = 30; // how long a simulated firmware update takes
const LAMP_LUX = 150; // what one lamp at full brightness adds to the room
const REPORT_INTERVAL = 10; // seconds between reports of a metering plug / a simulated thermostat

const randomIeee = (prefix) => '0x' + prefix + crypto.randomBytes(4).toString('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export class Simulator extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, 'store.json');
    this.config = {
      mqtt_url: process.env.MQTT_URL || 'mqtt://localhost:1883',
      username: process.env.MQTT_USERNAME || '',
      password: process.env.MQTT_PASSWORD || '',
      base_topic: process.env.BASE_TOPIC || 'zigbee2mqtt',
      discovery_prefix: process.env.DISCOVERY_PREFIX || 'homeassistant',
      coordinator_ieee: randomIeee('00124b00'),
    };
    this.devices = [];
    this.scenarios = [];
    this.clock = clockDefaults();
    this.rooms = {}; // room name -> { physics, temperature, humidity }
    this.log = [];
    this.client = null;
    this.connected = false;
    this.mqttError = null;
    this.permitJoin = false;
    this.nextReport = new Map();
    this.moving = new Map(); // cover id -> target position
    this.clearAt = new Map(); // motion sensor / siren id -> time at which it clears by itself
    this.trails = new Map(); // thermostat id -> recent temperatures [{ at, temperature }]
    this.autoWindow = new Set(); // thermostats that switched to window open mode by themselves
    this.updating = new Map(); // device id -> { started, respond } while a firmware update runs
    this.load();
    this.ticker = setInterval(() => this.tick(), 1000);
    this.clockAt = Date.now();
    this.clockTicker = setInterval(() => this.advanceClock(), CLOCK_STEP);
  }

  // ------------------------------------------------------------ persistence

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.assign(this.config, data.config);
      this.devices = (data.devices || []).filter((d) => TYPES[d.type]);
      this.scenarios = data.scenarios || [];
      Object.assign(this.clock, data.clock);
      this.rooms = data.rooms || {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${this.file}: ${err.message}`);
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = { config: this.config, devices: this.devices, scenarios: this.scenarios, clock: this.clock, rooms: this.rooms };
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }

  changed() {
    this.save();
    this.emit('change');
  }

  // ------------------------------------------------------------ MQTT plumbing

  get base() {
    return this.config.base_topic;
  }

  get ctx() {
    return {
      base: this.config.base_topic,
      discovery: this.config.discovery_prefix,
      coordinator: this.config.coordinator_ieee,
      version: VERSION,
    };
  }

  connect() {
    const { mqtt_url, username, password } = this.config;
    this.mqttError = null;
    let client;
    try {
      client = mqtt.connect(mqtt_url, {
        clientId: 'z2m_sim_' + crypto.randomBytes(3).toString('hex'),
        username: username || undefined,
        password: password || undefined,
        reconnectPeriod: 3000,
        connectTimeout: 8000,
        will: { topic: `${this.base}/bridge/state`, payload: JSON.stringify({ state: 'offline' }), retain: true, qos: 1 },
      });
    } catch (err) {
      this.mqttError = err.message;
      this.emit('change');
      return;
    }
    this.client = client;
    client.on('connect', () => {
      if (client !== this.client) return;
      this.connected = true;
      this.mqttError = null;
      client.subscribe([`${this.base}/#`, `${this.config.discovery_prefix}/status`]);
      this.publishAll();
      this.emit('change');
    });
    client.on('close', () => {
      if (client !== this.client) return;
      this.connected = false;
      this.emit('change');
    });
    client.on('error', (err) => {
      if (client !== this.client) return;
      this.mqttError = err.message || String(err.code || err);
      this.emit('change');
    });
    client.on('message', (topic, payload) => {
      if (client !== this.client) return;
      try {
        this.onMessage(topic, payload.toString());
      } catch (err) {
        console.error(`Error handling ${topic}: ${err.message}`);
      }
    });
  }

  async disconnect({ clearRetained = false } = {}) {
    const client = this.client;
    if (!client) return;
    if (this.connected) {
      if (clearRetained) this.clearAllRetained();
      else this.publish('bridge/state', { state: 'offline' }, { retain: true });
    }
    this.client = null;
    this.connected = false;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      client.end(false, {}, () => { clearTimeout(timer); resolve(); });
    });
  }

  addLog(dir, topic, payload, retain) {
    const entry = { ts: Date.now(), dir, topic, payload, retain: !!retain };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    this.emit('log', entry);
  }

  /** Publishes to an absolute topic. Objects are sent as JSON. */
  publishRaw(topic, payload, { retain = false } = {}) {
    if (!this.client || !this.connected) return;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(topic, text, { retain, qos: retain ? 1 : 0 });
    this.addLog('out', topic, text, retain);
  }

  /** Publishes below the base topic. */
  publish(topic, payload, opts) {
    this.publishRaw(`${this.base}/${topic}`, payload, opts);
  }

  // ------------------------------------------------------------ what the bridge publishes

  publishAll() {
    this.publish('bridge/state', { state: 'online' }, { retain: true });
    this.publishBridgeInfo();
    this.publishBridgeDevices();
    this.publish('bridge/groups', [], { retain: true });
    this.publish('bridge/extensions', [], { retain: true });
    this.publishBridgeDiscovery();
    this.publishClock();
    for (const dev of this.devices) this.announce(dev);
  }

  publishBridgeInfo() {
    const devices = {};
    for (const d of this.devices) devices[d.ieee] = { friendly_name: d.friendly_name };
    this.publish('bridge/info', {
      version: VERSION,
      commit: 'simulated',
      coordinator: { ieee_address: this.config.coordinator_ieee, type: 'zStack3x0', meta: { simulated: true } },
      network: { channel: 11, pan_id: 6754, extended_pan_id: '0xdddddddddddddddd' },
      log_level: 'info',
      permit_join: this.permitJoin,
      restart_required: false,
      config: {
        mqtt: { base_topic: this.base },
        homeassistant: { enabled: true, discovery_topic: this.config.discovery_prefix, status_topic: `${this.config.discovery_prefix}/status` },
        availability: { enabled: true },
        devices,
        groups: {},
      },
      config_schema: {},
    }, { retain: true });
  }

  publishBridgeDevices() {
    const coordinator = {
      ieee_address: this.config.coordinator_ieee,
      type: 'Coordinator',
      network_address: 0,
      supported: true,
      friendly_name: 'Coordinator',
      disabled: false,
      interview_completed: true,
      interviewing: false,
      interview_state: 'SUCCESSFUL',
      endpoints: {},
    };
    this.publish('bridge/devices', [coordinator, ...this.devices.map(bridgeDeviceEntry)], { retain: true });
  }

  /** Entities of the bridge device: its connection state, plus the simulated clock, sun and weather. */
  bridgeDiscovery() {
    const ieee = this.config.coordinator_ieee;
    const simulation = `${this.base}/bridge/simulation`;
    const entities = [
      ['binary_sensor', 'connection_state', {
        name: 'Connection state', device_class: 'connectivity', entity_category: 'diagnostic',
        state_topic: `${this.base}/bridge/state`, value_template: '{{ value_json.state }}', payload_on: 'online', payload_off: 'offline',
      }],
      ['sensor', 'simulated_time', { name: 'Simulated time', icon: 'mdi:clock-outline', state_topic: simulation, value_template: '{{ value_json.time }}' }],
      ['binary_sensor', 'simulated_sun', {
        name: 'Simulated sun', device_class: 'light', state_topic: simulation, value_template: '{{ value_json.sun }}',
        payload_on: 'above_horizon', payload_off: 'below_horizon',
      }],
      ['sensor', 'simulated_daylight', {
        name: 'Simulated daylight', icon: 'mdi:white-balance-sunny', unit_of_measurement: '%', state_class: 'measurement',
        state_topic: simulation, value_template: '{{ value_json.daylight }}',
      }],
      ['sensor', 'simulated_outdoor_temperature', {
        name: 'Simulated outdoor temperature', device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement',
        state_topic: simulation, value_template: '{{ value_json.outdoor_temperature }}',
      }],
    ];
    return entities.map(([component, object, payload]) => ({
      topic: `${this.config.discovery_prefix}/${component}/sim_bridge_${ieee}/${object}/config`,
      payload: {
        ...payload,
        unique_id: `bridge_${ieee}_${object}_zigbee2mqtt`,
        device: {
          identifiers: [`zigbee2mqtt_bridge_${ieee}`],
          name: 'Zigbee2MQTT Bridge (simulated)',
          manufacturer: 'Zigbee2MQTT',
          model: 'Bridge',
          sw_version: VERSION,
        },
        origin: { name: 'Zigbee2MQTT Simulator', sw: VERSION, url: 'https://www.zigbee2mqtt.io' },
      },
    }));
  }

  publishBridgeDiscovery() {
    for (const { topic, payload } of this.bridgeDiscovery()) this.publishRaw(topic, payload, { retain: true });
  }

  /** The simulated time, sun and weather - for automations that depend on the time of day. */
  publishClock() {
    const { speed, running } = this.clock;
    this.clockPublished = formatTime(this.clock.minutes);
    this.publish('bridge/simulation', { ...environment(this.clock), speed, running }, { retain: true });
  }

  /** Discovery + availability + current state of one device. */
  announce(dev) {
    for (const { topic, payload } of buildDiscovery(dev, this.ctx)) this.publishRaw(topic, payload, { retain: true });
    this.publishAvailability(dev);
    this.publishState(dev);
  }

  publishAvailability(dev) {
    this.publish(`${dev.friendly_name}/availability`, { state: dev.available ? 'online' : 'offline' }, { retain: true });
  }

  publishState(dev, extra = {}) {
    if (!dev.available) return; // an unreachable device does not report
    const linkquality = Math.min(255, Math.max(1, dev.linkquality + Math.round((Math.random() - 0.5) * 12)));
    this.publish(dev.friendly_name, { ...statePayload(dev), ...extra, linkquality });
  }

  /** Removes everything retained for one device from the broker. */
  clearRetained(dev) {
    for (const { topic } of buildDiscovery(dev, this.ctx)) this.publishRaw(topic, '', { retain: true });
    this.publish(`${dev.friendly_name}/availability`, '', { retain: true });
  }

  clearAllRetained() {
    for (const dev of this.devices) this.clearRetained(dev);
    for (const { topic } of this.bridgeDiscovery()) this.publishRaw(topic, '', { retain: true });
    for (const t of ['info', 'devices', 'groups', 'extensions', 'simulation', 'state']) this.publish(`bridge/${t}`, '', { retain: true });
  }

  // ------------------------------------------------------------ incoming MQTT

  onMessage(topic, text) {
    if (topic === `${this.config.discovery_prefix}/status`) {
      this.addLog('in', topic, text);
      if (text === 'online') {
        // Home Assistant (re)started: give it the current state of everything again.
        setTimeout(() => {
          for (const dev of this.devices) { this.publishAvailability(dev); this.publishState(dev); }
        }, 2000);
      }
      return;
    }
    if (!topic.startsWith(this.base + '/')) return;
    const rest = topic.slice(this.base.length + 1);
    if (rest.startsWith('bridge/request/')) {
      this.addLog('in', topic, text);
      this.bridgeRequest(rest.slice('bridge/request/'.length), text);
      return;
    }
    if (rest.startsWith('bridge/')) return;
    const m = /^(.+?)\/(set|get)(?:\/(.+))?$/.exec(rest);
    if (!m) return; // our own state/availability publishes
    const [, name, command, attribute] = m;
    this.addLog('in', topic, text);
    const dev = this.devices.find((d) => d.friendly_name === name || d.ieee === name);
    if (!dev || !dev.available) return;
    if (command === 'get') {
      this.publishState(dev);
      return;
    }
    let values;
    try {
      values = JSON.parse(text);
    } catch {
      values = text;
    }
    if (attribute) values = { [attribute]: values };
    else if (typeof values !== 'object' || values === null) values = { state: values };
    const settable = TYPES[dev.type].settable;
    if (!settable) return; // sensors and buttons do not accept commands
    if (settable !== 'all') values = Object.fromEntries(Object.entries(values).filter(([key]) => settable.includes(key)));
    if (this.apply(dev, values)) {
      this.publishState(dev);
      this.changed();
    }
  }

  bridgeRequest(request, text) {
    let msg = {};
    try {
      msg = JSON.parse(text);
    } catch {
      if (text) msg = { id: text, value: text };
    }
    if (typeof msg !== 'object' || msg === null) msg = { id: msg, value: msg };
    const respond = (data, error) => {
      const res = error ? { data: {}, status: 'error', error } : { data, status: 'ok' };
      if (msg.transaction !== undefined) res.transaction = msg.transaction;
      this.publish(`bridge/response/${request}`, res);
    };
    const findDev = (id) => this.devices.find((d) => d.friendly_name === id || d.ieee === id);
    try {
      switch (request) {
        case 'health_check':
          return respond({ healthy: true });
        case 'permit_join': {
          const time = Number(msg.time ?? (msg.value === true ? 254 : 0)) || 0;
          this.permitJoin = time > 0;
          clearTimeout(this.permitTimer);
          if (this.permitJoin) this.permitTimer = setTimeout(() => { this.permitJoin = false; this.publishBridgeInfo(); }, time * 1000);
          this.publishBridgeInfo();
          return respond({ time });
        }
        case 'restart':
          respond({});
          return void setTimeout(() => this.publishAll(), 500);
        case 'device/rename': {
          const dev = findDev(msg.from);
          if (!dev) return respond(null, `Device '${msg.from}' does not exist`);
          this.updateDevice(dev.id, { friendly_name: msg.to });
          return respond({ from: msg.from, to: dev.friendly_name, homeassistant_rename: false });
        }
        case 'device/remove': {
          const dev = findDev(msg.id);
          if (!dev) return respond(null, `Device '${msg.id}' does not exist`);
          this.removeDevice(dev.id);
          return respond({ id: msg.id, block: false, force: false });
        }
        case 'device/ota_update/check': {
          const dev = findDev(msg.id);
          if (!dev) return respond(null, `Device '${msg.id}' does not exist`);
          return respond({ id: msg.id, update_available: otaOf(dev).state === 'available' });
        }
        case 'device/ota_update/update': {
          const dev = findDev(msg.id);
          if (!dev) return respond(null, `Device '${msg.id}' does not exist`);
          // answered when the update has finished
          return void this.startUpdate(dev, (from, to) => respond({ id: msg.id, from: { software_build_id: String(from) }, to: { software_build_id: String(to) } }));
        }
        default:
          return respond(null, `Request '${request}' is not supported by the simulator`);
      }
    } catch (err) {
      respond(null, err.message);
    }
  }

  // ------------------------------------------------------------ device management (used by the web UI)

  getDevice(id) {
    const dev = this.devices.find((d) => d.id === id);
    if (!dev) throw fail('Device not found', 404);
    return dev;
  }

  validateName(name, exceptId, { unique = true } = {}) {
    name = String(name ?? '').trim();
    if (!name) throw fail('A name is required');
    if (/[#+]/.test(name) || name.startsWith('/') || name.endsWith('/')) throw fail('The name must not contain # or + or start/end with /');
    if (/(^|\/)(set|get)(\/|$)/.test(name) || name === 'bridge' || name.startsWith('bridge/')) throw fail('The name must not use the reserved words bridge, set or get as a topic level');
    if (unique && this.devices.some((d) => d.id !== exceptId && d.friendly_name === name)) throw fail(`A device named '${name}' already exists`);
    return name;
  }

  /** `saved` (import only) brings back the address, values and settings of an exported device. */
  addDevice({ type, friendly_name, room }, saved = {}) {
    const t = TYPES[type];
    if (!t) throw fail('Unknown device type');
    const reuse = /^0x[0-9a-f]{16}$/.test(saved.ieee ?? '') && !this.devices.some((d) => d.ieee === saved.ieee);
    const ieee = reuse ? saved.ieee : randomIeee(type === 'light' ? '00178801' : '00158d00');
    // Only values of the kind the device type knows are taken over.
    const restore = (defaults, given) => {
      for (const [key, value] of Object.entries(defaults)) {
        const v = given?.[key];
        if (v === null || typeof v !== typeof value) continue;
        if (typeof value === 'number' && !Number.isFinite(v)) continue;
        if (typeof value === 'object' && !Object.keys(value).every((k) => Number.isFinite(v[k]))) continue;
        defaults[key] = v;
      }
      return defaults;
    };
    const dev = {
      id: ieee,
      ieee,
      type,
      friendly_name: this.validateName(friendly_name),
      room: String(room ?? '').trim(),
      available: saved.available !== false,
      network_address: crypto.randomInt(1, 65000),
      linkquality: crypto.randomInt(70, 200),
      state: restore(t.defaults(), saved.state),
      sim: restore(t.sim ? t.sim() : {}, saved.sim),
    };
    if (Number.isInteger(saved.firmware) && saved.firmware > 0) dev.ota = { installed: saved.firmware, latest: saved.firmware, state: 'idle' };
    applyValues(dev, {}); // settles what follows from the values
    this.devices.push(dev);
    this.publish('bridge/event', { type: 'device_joined', data: { friendly_name: dev.friendly_name, ieee_address: ieee } });
    this.publish('bridge/event', {
      type: 'device_interview',
      data: { friendly_name: dev.friendly_name, ieee_address: ieee, status: 'successful', supported: true, definition: bridgeDeviceEntry(dev).definition },
    });
    this.publishBridgeDevices();
    this.publishBridgeInfo();
    this.announce(dev);
    this.changed();
    return dev;
  }

  updateDevice(id, patch) {
    const dev = this.getDevice(id);
    if (patch.friendly_name !== undefined && patch.friendly_name !== dev.friendly_name) {
      const name = this.validateName(patch.friendly_name, id);
      this.publish(`${dev.friendly_name}/availability`, '', { retain: true });
      dev.friendly_name = name;
      this.publishBridgeDevices();
      this.publishBridgeInfo();
      this.announce(dev);
    }
    if (patch.room !== undefined) dev.room = String(patch.room).trim();
    if (patch.available !== undefined && !!patch.available !== dev.available) {
      dev.available = !!patch.available;
      this.publishAvailability(dev);
      this.publishState(dev);
    }
    const simFields = TYPES[dev.type].simFields;
    if (patch.sim && simFields) {
      for (const [key, range] of Object.entries(simFields)) {
        const value = patch.sim[key];
        if (value === undefined) continue;
        if (range === 'bool') dev.sim[key] = !!value;
        else if (Number.isFinite(Number(value))) dev.sim[key] = Math.min(range[1], Math.max(range[0], Number(value)));
      }
      if (dev.type === 'sensor' && patch.sim.auto !== undefined) {
        dev.sim.base = { temperature: dev.state.temperature, humidity: dev.state.humidity };
      }
      this.nextReport.delete(id);
    }
    if (patch.state) this.setValues(id, patch.state);
    this.changed();
    return dev;
  }

  /** Applies values to a device, including the behaviour that takes time (a blind moving, motion clearing). */
  apply(dev, values) {
    let changed = false;
    if (dev.type === 'cover') {
      changed = this.coverCommand(dev, values);
      const { state, position, ...rest } = values;
      values = rest;
    }
    changed = applyValues(dev, values) || changed;
    if (dev.type === 'motion' && 'occupancy' in values) {
      if (dev.state.occupancy && dev.sim.timeout > 0) this.clearAt.set(dev.id, Date.now() + dev.sim.timeout * 1000);
      else this.clearAt.delete(dev.id);
    }
    if (dev.type === 'siren' && ('alarm' in values || 'duration' in values)) {
      // a siren stops by itself after its duration
      if (dev.state.alarm) this.clearAt.set(dev.id, Date.now() + dev.state.duration * 1000);
      else this.clearAt.delete(dev.id);
    }
    if (dev.type === 'trv' && 'window_detection' in values) {
      // set by hand or by Home Assistant: the thermostat no longer ends it by itself
      this.autoWindow.delete(dev.id);
      this.trails.delete(dev.id);
    }
    return changed;
  }

  /** A blind does not jump: commands only set where the motor is heading (see tick). */
  coverCommand(dev, values) {
    let target;
    if (values.state !== undefined) {
      const command = String(values.state).toUpperCase();
      if (command === 'OPEN') target = 100;
      else if (command === 'CLOSE') target = 0;
      else if (command === 'STOP') return this.moving.delete(dev.id) || true;
    }
    const position = Number(values.position);
    if (values.position !== undefined && values.position !== '' && values.position !== null && Number.isFinite(position)) {
      target = Math.min(100, Math.max(0, Math.round(position)));
    }
    if (target === undefined) return false;
    if (target === dev.state.position) this.moving.delete(dev.id);
    else this.moving.set(dev.id, target);
    return true;
  }

  /** A change coming from the "physical world" (web UI or scenario), e.g. the temperature rises. */
  setValues(id, values) {
    const dev = this.getDevice(id);
    if (!values || typeof values !== 'object' || !this.apply(dev, values)) return false;
    if (dev.type === 'sensor') dev.sim.base = { temperature: dev.state.temperature, humidity: dev.state.humidity };
    const room = this.physicsRoom(dev);
    if (room) {
      // Setting what a device measures means: the room itself is now that warm / humid.
      if (dev.type === 'sensor' && 'temperature' in values) room.temperature = dev.state.temperature;
      if (dev.type === 'sensor' && 'humidity' in values) room.humidity = dev.state.humidity;
      if ((dev.type === 'thermostat' || dev.type === 'trv') && 'local_temperature' in values) room.temperature = dev.state.local_temperature;
      if (dev.type === 'air') {
        for (const key of ['temperature', 'humidity', 'co2']) if (key in values) room[key] = dev.state[key];
      }
    }
    this.publishState(dev);
    this.changed();
    return true;
  }

  pressButton(id, action) {
    const dev = this.getDevice(id);
    const t = TYPES[dev.type];
    if (!t.actions) throw fail('This device is not a remote');
    if (!t.actions.includes(action)) throw fail(`Unknown action '${action}'`);
    if (!dev.available) throw fail('The device is offline');
    this.publishState(dev, { action, ...t.actionExtra?.(action) });
    this.publish(`${dev.friendly_name}/action`, action);
    dev.last_action = { action, ts: Date.now() };
    this.changed();
  }

  removeDevice(id) {
    const dev = this.getDevice(id);
    this.clearRetained(dev);
    this.devices = this.devices.filter((d) => d.id !== id);
    this.nextReport.delete(id);
    this.moving.delete(id);
    this.clearAt.delete(id);
    this.trails.delete(id);
    this.autoWindow.delete(id);
    this.updating.delete(id);
    this.publish('bridge/event', { type: 'device_leave', data: { ieee_address: dev.ieee, friendly_name: dev.friendly_name } });
    this.publishBridgeDevices();
    this.publishBridgeInfo();
    this.changed();
  }

  async setConfig(patch) {
    const next = { ...this.config };
    for (const key of ['mqtt_url', 'username', 'base_topic', 'discovery_prefix']) {
      if (patch[key] !== undefined) next[key] = String(patch[key]).trim();
    }
    if (patch.password !== undefined) next.password = String(patch.password);
    if (!/^(mqtts?|wss?|tcp|tls):\/\/.+/.test(next.mqtt_url)) throw fail('The broker URL must look like mqtt://host:1883');
    for (const key of ['base_topic', 'discovery_prefix']) {
      if (!next[key] || /[#+]/.test(next[key]) || next[key].startsWith('/') || next[key].endsWith('/')) throw fail(`Invalid ${key.replace('_', ' ')}`);
    }
    // Topics may change: take everything retained off the broker before moving.
    await this.disconnect({ clearRetained: true });
    this.config = next;
    this.saveNow();
    this.connect();
    this.emit('change');
  }

  // ------------------------------------------------------------ simulated clock, sun and weather

  advanceClock() {
    const now = Date.now();
    const elapsed = now - this.clockAt;
    this.clockAt = now;
    if (!this.clock.running) return;
    const before = formatTime(this.clock.minutes);
    this.clock.minutes = (this.clock.minutes + (elapsed * this.clock.speed) / 60000) % DAY;
    if (formatTime(this.clock.minutes) !== before) this.emit('change');
  }

  setClock(patch) {
    const next = { ...this.clock };
    if (patch.time !== undefined) {
      const minutes = parseTime(patch.time);
      if (minutes === undefined) throw fail('The time must look like 07:30');
      next.minutes = minutes;
    }
    if (patch.minutes !== undefined) {
      const minutes = Number(patch.minutes);
      if (!(minutes >= 0 && minutes < DAY)) throw fail('minutes must be between 0 and 1439');
      next.minutes = minutes;
    }
    if (patch.speed !== undefined) {
      if (!SPEEDS.includes(Number(patch.speed))) throw fail(`The speed must be one of ${SPEEDS.join(', ')}`);
      next.speed = Number(patch.speed);
    }
    if (patch.running !== undefined) next.running = !!patch.running;
    for (const key of ['sunrise', 'sunset']) {
      if (patch[key] === undefined) continue;
      const minutes = typeof patch[key] === 'number' ? patch[key] : parseTime(patch[key]);
      if (!(minutes >= 0 && minutes < DAY)) throw fail(`${key} must look like 06:30`);
      next[key] = minutes;
    }
    for (const key of ['temp_min', 'temp_max']) {
      if (patch[key] === undefined) continue;
      const value = Number(patch[key]);
      if (!(value >= -40 && value <= 50)) throw fail(`${key} must be between -40 and 50`);
      next[key] = value;
    }
    if (next.sunset - next.sunrise < 60) throw fail('The sun must set at least an hour after it rises');
    if (next.temp_max < next.temp_min) throw fail('The warmest temperature must not be below the coldest');
    this.clock = next;
    this.clockAt = Date.now();
    this.publishClock();
    this.followClock();
    this.changed();
    return this.clockView();
  }

  clockView() {
    return { ...this.clock, ...environment(this.clock) };
  }

  /** Devices that follow the sun or the weather take their values from the clock. */
  followClock() {
    const env = environment(this.clock);
    for (const dev of this.devices) {
      let values;
      if (this.physicsRoom(dev)) continue; // the room decides (see roomPhysics)
      if (dev.type === 'motion' && dev.sim.sun) {
        const illuminance = Math.round((env.daylight / 100) * (dev.sim.peak ?? DEFAULT_PEAK));
        if (illuminance !== dev.state.illuminance) values = { illuminance };
      }
      if (dev.type === 'sensor' && dev.sim.outdoor) {
        // with "auto drift" the periodic report wanders around this instead
        dev.sim.base = { temperature: env.outdoor_temperature, humidity: env.outdoor_humidity };
        const s = dev.state;
        if (!dev.sim.auto && (s.temperature !== env.outdoor_temperature || s.humidity !== env.outdoor_humidity)) values = dev.sim.base;
      }
      if (!values || !dev.available) continue;
      applyValues(dev, values);
      this.publishState(dev);
      this.changed();
    }
  }

  // ------------------------------------------------------------ firmware updates (OTA)

  /** offer: a newer firmware appears; install: what Home Assistant's "Install" does; withdraw: the offer disappears. */
  firmware(id, action) {
    const dev = this.getDevice(id);
    const ota = otaOf(dev);
    if (action === 'install') return void this.startUpdate(dev);
    if (ota.state === 'updating') throw fail('The update is being installed');
    if (action === 'offer') Object.assign(ota, { latest: ota.installed + 1, state: 'available' });
    else if (action === 'withdraw') Object.assign(ota, { latest: ota.installed, state: 'idle' });
    else throw fail(`Unknown firmware action '${action}'`);
    this.publishState(dev);
    this.changed();
  }

  startUpdate(dev, respond) {
    const ota = otaOf(dev);
    if (ota.state === 'updating') throw fail(`Update of '${dev.friendly_name}' is already in progress`);
    if (ota.state !== 'available') throw fail(`No update available for '${dev.friendly_name}'`);
    if (!dev.available) throw fail(`Device '${dev.friendly_name}' is offline`);
    Object.assign(ota, { state: 'updating', progress: 0, remaining: OTA_SECONDS });
    this.updating.set(dev.id, { started: Date.now(), respond });
    this.publishState(dev);
    this.changed();
  }

  /** Moves running updates forward; called once per second. */
  advanceUpdates(now) {
    for (const [id, { started, respond }] of this.updating) {
      const dev = this.devices.find((d) => d.id === id);
      if (!dev) continue;
      const ota = otaOf(dev);
      const elapsed = (now - started) / 1000;
      if (elapsed < OTA_SECONDS) {
        Object.assign(ota, { progress: Math.round((elapsed / OTA_SECONDS) * 100), remaining: Math.ceil(OTA_SECONDS - elapsed) });
      } else {
        const from = ota.installed;
        dev.ota = { installed: ota.latest, latest: ota.latest, state: 'idle' };
        this.updating.delete(id);
        this.publishBridgeDevices(); // the new firmware version shows up there
        respond?.(from, dev.ota.installed);
      }
      this.publishState(dev);
      this.changed();
    }
  }

  /** A thermostat with window detection pauses heating when the temperature suddenly drops. */
  detectWindow(dev, now) {
    const s = dev.state;
    const trail = (this.trails.get(dev.id) ?? []).filter((p) => now - p.at <= WINDOW_SPAN * 1000);
    trail.push({ at: now, temperature: s.local_temperature });
    this.trails.set(dev.id, trail);
    if (!dev.sim.detect) return;
    let next;
    if (s.window_detection === 'OFF') {
      if (Math.max(...trail.map((p) => p.temperature)) - s.local_temperature >= WINDOW_DROP) next = 'ON';
    } else if (this.autoWindow.has(dev.id)) {
      // back to normal once the temperature has stopped falling for ten seconds
      const recent = trail.filter((p) => now - p.at <= 10500);
      if (recent.length >= 10 && recent[0].temperature - s.local_temperature < 0.2) next = 'OFF';
    }
    if (!next) return;
    applyValues(dev, { window_detection: next });
    if (next === 'ON') this.autoWindow.add(dev.id);
    else this.autoWindow.delete(dev.id);
    this.trails.set(dev.id, [{ at: now, temperature: s.local_temperature }]);
    this.publishState(dev);
    this.changed();
  }

  // ------------------------------------------------------------ room physics

  /** The room of a device, if that room simulates its climate and light. An outdoor sensor is not in the room. */
  physicsRoom(dev) {
    const room = dev.room ? this.rooms[dev.room] : null;
    return room?.physics && !(dev.type === 'sensor' && dev.sim.outdoor) ? room : null;
  }

  setRoom({ name, physics, temperature, humidity }) {
    name = String(name ?? '');
    const devices = this.devices.filter((d) => d.room === name);
    if (!name || !devices.length) throw fail('Room not found', 404);
    const room = (this.rooms[name] ??= { physics: false });
    if (physics !== undefined) room.physics = !!physics;
    if (room.physics && room.temperature === undefined) {
      // start from what the devices in the room show right now
      const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : undefined);
      const sensors = devices.filter((d) => d.type === 'sensor' && !d.sim.outdoor);
      room.temperature = average(sensors.map((d) => d.state.temperature))
        ?? average(devices.filter((d) => d.type === 'thermostat').map((d) => d.state.local_temperature)) ?? 21;
      room.humidity = average(sensors.map((d) => d.state.humidity)) ?? REST_HUMIDITY;
    }
    if (room.physics && room.co2 === undefined) room.co2 = devices.find((d) => d.type === 'air')?.state.co2 ?? 600;
    for (const [key, value, min, max] of [['temperature', temperature, -40, 80], ['humidity', humidity, 0, 100]]) {
      if (value === undefined) continue;
      if (!(Number(value) >= min && Number(value) <= max)) throw fail(`${key} must be between ${min} and ${max}`);
      room[key] = Number(value);
    }
    this.roomPhysics(0);
    this.changed();
    return room;
  }

  /**
   * Links the devices of a room: open windows let the outdoor air in, heating radiators warm
   * the room, blinds and lamps decide how bright it is. Sensors and thermostats report the result.
   */
  roomPhysics(seconds = 1) {
    const env = environment(this.clock);
    const tenth = (v) => Math.round(v * 10) / 10;
    for (const [name, room] of Object.entries(this.rooms)) {
      if (!room.physics) continue;
      const devices = this.devices.filter((d) => d.room === name && this.physicsRoom(d));
      if (!devices.length) continue;
      const of = (type) => devices.filter((d) => d.type === type);

      const open = of('window').filter((d) => d.state.contact === false).length;
      // a plain thermostat is open or shut, one with a valve position heats in proportion to it
      const heating = of('thermostat').filter((d) => d.state.running_state === 'heat').length
        + of('trv').reduce((sum, d) => sum + d.state.pi_heating_demand / 100, 0);
      // A room without a radiator keeps its temperature while closed: nothing could warm it up again.
      const leak = of('thermostat').length + of('trv').length ? LEAK_RATE : 0;
      const exchange = Math.min(1, (leak + open * AIRING_RATE) * seconds);
      room.temperature += heating * HEAT_RATE * seconds + (env.outdoor_temperature - room.temperature) * exchange;
      room.humidity += open
        ? (env.outdoor_humidity - room.humidity) * Math.min(1, open * AIRING_RATE * seconds)
        : (REST_HUMIDITY - room.humidity) * SETTLE_RATE * seconds;

      // people breathe: every sensor that sees somebody counts as one person
      const people = of('presence').filter((d) => d.state.presence).length + of('motion').filter((d) => d.state.occupancy).length;
      room.co2 ??= 600;
      room.co2 += people * CO2_PER_PERSON * seconds
        + (CO2_OUTDOORS - room.co2) * Math.min(1, (CO2_SETTLE_RATE + open * AIRING_RATE) * seconds);
      room.co2 = Math.min(5000, Math.max(350, room.co2));

      const blinds = of('cover');
      const openness = blinds.length ? blinds.reduce((sum, d) => sum + d.state.position, 0) / blinds.length / 100 : 1;
      const lamps = of('light').filter((d) => d.state.state === 'ON').reduce((sum, d) => sum + (d.state.brightness / 254) * LAMP_LUX, 0);

      const temperature = tenth(room.temperature);
      const humidity = tenth(room.humidity);
      for (const dev of devices) {
        const s = dev.state;
        let values;
        if (dev.type === 'sensor') {
          // with "auto drift" the periodic report wanders around this instead
          dev.sim.base = { temperature, humidity };
          if (!dev.sim.auto && (s.temperature !== temperature || s.humidity !== humidity)) values = dev.sim.base;
        }
        if ((dev.type === 'thermostat' || dev.type === 'trv') && s.local_temperature !== temperature) values = { local_temperature: temperature };
        if (dev.type === 'air') {
          const co2 = Math.round(room.co2 / 5) * 5; // reported in steps of 5 ppm
          if (s.temperature !== temperature || s.humidity !== humidity || s.co2 !== co2) values = { temperature, humidity, co2 };
        }
        if (dev.type === 'motion') {
          const illuminance = Math.round((env.daylight / 100) * (dev.sim.peak ?? DEFAULT_PEAK) * openness + lamps);
          if (illuminance !== s.illuminance) values = { illuminance };
        }
        if (!values || !dev.available) continue;
        applyValues(dev, values);
        this.publishState(dev);
        this.changed();
      }
    }
  }

  // ------------------------------------------------------------ things that happen over time

  tick() {
    const now = Date.now();
    if (this.clockPublished !== formatTime(this.clock.minutes)) this.publishClock();
    this.followClock();
    this.roomPhysics();
    this.advanceUpdates(now);
    for (const dev of this.devices) {
      if (!dev.available) continue;
      const s = dev.state;
      const physics = !!this.physicsRoom(dev);

      if (dev.type === 'cover' && this.moving.has(dev.id)) {
        const target = this.moving.get(dev.id);
        s.position = s.position < target ? Math.min(target, s.position + COVER_SPEED) : Math.max(target, s.position - COVER_SPEED);
        s.state = s.position > 0 ? 'OPEN' : 'CLOSE';
        if (s.position === target) this.moving.delete(dev.id);
        this.publishState(dev);
        this.changed();
        continue;
      }
      if (dev.type === 'trv') this.detectWindow(dev, now);
      if (dev.type === 'siren' && now >= (this.clearAt.get(dev.id) ?? Infinity)) {
        this.clearAt.delete(dev.id);
        if (s.alarm) {
          s.alarm = false;
          this.publishState(dev);
          this.changed();
        }
        continue;
      }
      if (dev.type === 'motion' && now >= (this.clearAt.get(dev.id) ?? Infinity)) {
        this.clearAt.delete(dev.id);
        if (s.occupancy) {
          s.occupancy = false;
          this.publishState(dev);
          this.changed();
        }
        continue;
      }
      if (dev.type === 'plug') s.energy += s.power / 3.6e6; // one second of consumption in kWh

      // Periodic reports
      const interval =
        dev.type === 'sensor' && dev.sim.auto ? dev.sim.interval
        : dev.type === 'thermostat' && dev.sim.auto && !physics ? REPORT_INTERVAL
        : dev.type === 'plug' && s.power > 0 ? REPORT_INTERVAL
        : 0;
      if (!interval) {
        this.nextReport.delete(dev.id);
        continue;
      }
      const due = this.nextReport.get(dev.id);
      if (due === undefined) this.nextReport.set(dev.id, now + interval * 1000);
      if (due === undefined || now < due) continue;
      this.nextReport.set(dev.id, now + interval * 1000);

      if (dev.type === 'sensor') {
        // wander around the value that was set by hand
        const base = dev.sim.base || s;
        const pull = dev.sim.outdoor || physics ? 1 : 0.2; // keeps up with the weather / the room
        applyValues(dev, {
          temperature: s.temperature + (base.temperature - s.temperature) * pull + (Math.random() - 0.5) * 0.4,
          humidity: s.humidity + (base.humidity - s.humidity) * pull + (Math.random() - 0.5) * 1.6,
        });
      }
      if (dev.type === 'thermostat') {
        // the room warms up while the valve is open and cools down towards the ambient temperature otherwise
        const gap = dev.sim.ambient - s.local_temperature;
        if (s.running_state !== 'heat' && Math.abs(gap) < 0.1) continue;
        applyValues(dev, { local_temperature: s.local_temperature + (s.running_state === 'heat' ? 0.2 : Math.sign(gap) * 0.1) });
      }
      this.publishState(dev);
      this.changed();
    }
  }

  // ------------------------------------------------------------ view for the web UI

  snapshot() {
    const { password, ...config } = this.config;
    const types = {};
    for (const [key, t] of Object.entries(TYPES)) {
      types[key] = { label: t.label, vendor: t.vendor, model: t.model, description: t.description, props: t.props, observe: observables(key), actions: t.actions || [], simFields: Object.keys(t.simFields || {}), battery: t.powerSource === 'Battery' };
    }
    return {
      version: VERSION,
      config: { ...config, has_password: !!password },
      mqtt: { connected: this.connected, error: this.mqttError },
      types,
      devices: this.devices.map((d) => ({
        ...d,
        ota: otaOf(d),
        ui: d.type === 'light' ? { hex: lightHex(d.state) } : d.type === 'cover' ? { target: this.moving.get(d.id) ?? null } : {},
      })),
      scenarios: this.scenarios,
      clock: { ...this.clockView(), speeds: SPEEDS },
      rooms: Object.fromEntries([...new Set(this.devices.map((d) => d.room).filter(Boolean))].map((name) => {
        const room = this.rooms[name];
        return [name, room?.physics
          ? { physics: true, temperature: Math.round(room.temperature * 10) / 10, humidity: Math.round(room.humidity), co2: Math.round(room.co2 ?? 600) }
          : { physics: false }];
      })),
    };
  }

  async shutdown() {
    clearInterval(this.ticker);
    clearInterval(this.clockTicker);
    this.saveNow();
    await this.disconnect();
  }
}
