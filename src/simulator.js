// The simulated Zigbee2MQTT instance: owns the virtual devices, talks MQTT like the real
// bridge (bridge/* topics, device state, /set + /get, availability, HA discovery).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { TYPES, applyValues, bridgeDeviceEntry, buildDiscovery, lightHex, observables, statePayload } from './devices.js';

export const VERSION = '2.6.3-sim';
const LOG_SIZE = 300;
const COVER_SPEED = 10; // percent per second
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
    this.log = [];
    this.client = null;
    this.connected = false;
    this.mqttError = null;
    this.permitJoin = false;
    this.nextReport = new Map();
    this.moving = new Map(); // cover id -> target position
    this.clearAt = new Map(); // motion sensor id -> time at which occupancy clears
    this.load();
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  // ------------------------------------------------------------ persistence

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.assign(this.config, data.config);
      this.devices = (data.devices || []).filter((d) => TYPES[d.type]);
      this.scenarios = data.scenarios || [];
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
    const data = { config: this.config, devices: this.devices, scenarios: this.scenarios };
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

  bridgeDiscoveryTopic() {
    return `${this.config.discovery_prefix}/binary_sensor/sim_bridge_${this.config.coordinator_ieee}/connection_state/config`;
  }

  publishBridgeDiscovery() {
    this.publishRaw(this.bridgeDiscoveryTopic(), {
      name: 'Connection state',
      device_class: 'connectivity',
      entity_category: 'diagnostic',
      state_topic: `${this.base}/bridge/state`,
      value_template: '{{ value_json.state }}',
      payload_on: 'online',
      payload_off: 'offline',
      unique_id: `bridge_${this.config.coordinator_ieee}_connection_state_zigbee2mqtt`,
      device: {
        identifiers: [`zigbee2mqtt_bridge_${this.config.coordinator_ieee}`],
        name: 'Zigbee2MQTT Bridge (simulated)',
        manufacturer: 'Zigbee2MQTT',
        model: 'Bridge',
        sw_version: VERSION,
      },
      origin: { name: 'Zigbee2MQTT Simulator', sw: VERSION, url: 'https://www.zigbee2mqtt.io' },
    }, { retain: true });
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
    this.publishRaw(this.bridgeDiscoveryTopic(), '', { retain: true });
    for (const t of ['info', 'devices', 'groups', 'extensions', 'state']) this.publish(`bridge/${t}`, '', { retain: true });
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

  validateName(name, exceptId) {
    name = String(name ?? '').trim();
    if (!name) throw fail('A name is required');
    if (/[#+]/.test(name) || name.startsWith('/') || name.endsWith('/')) throw fail('The name must not contain # or + or start/end with /');
    if (/(^|\/)(set|get)(\/|$)/.test(name) || name === 'bridge' || name.startsWith('bridge/')) throw fail('The name must not use the reserved words bridge, set or get as a topic level');
    if (this.devices.some((d) => d.id !== exceptId && d.friendly_name === name)) throw fail(`A device named '${name}' already exists`);
    return name;
  }

  addDevice({ type, friendly_name, room }) {
    const t = TYPES[type];
    if (!t) throw fail('Unknown device type');
    const ieee = randomIeee(type === 'light' ? '00178801' : '00158d00');
    const dev = {
      id: ieee,
      ieee,
      type,
      friendly_name: this.validateName(friendly_name),
      room: String(room ?? '').trim(),
      available: true,
      network_address: crypto.randomInt(1, 65000),
      linkquality: crypto.randomInt(70, 200),
      state: t.defaults(),
      sim: t.sim ? t.sim() : {},
    };
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
    this.publishState(dev);
    this.changed();
    return true;
  }

  pressButton(id, action) {
    const dev = this.getDevice(id);
    if (dev.type !== 'button') throw fail('This device is not a button');
    if (!TYPES.button.actions.includes(action)) throw fail(`Unknown action '${action}'`);
    if (!dev.available) throw fail('The device is offline');
    this.publishState(dev, { action });
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

  // ------------------------------------------------------------ things that happen over time

  tick() {
    const now = Date.now();
    for (const dev of this.devices) {
      if (!dev.available) continue;
      const s = dev.state;

      if (dev.type === 'cover' && this.moving.has(dev.id)) {
        const target = this.moving.get(dev.id);
        s.position = s.position < target ? Math.min(target, s.position + COVER_SPEED) : Math.max(target, s.position - COVER_SPEED);
        s.state = s.position > 0 ? 'OPEN' : 'CLOSE';
        if (s.position === target) this.moving.delete(dev.id);
        this.publishState(dev);
        this.changed();
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
        : dev.type === 'thermostat' && dev.sim.auto ? REPORT_INTERVAL
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
        applyValues(dev, {
          temperature: s.temperature + (base.temperature - s.temperature) * 0.2 + (Math.random() - 0.5) * 0.4,
          humidity: s.humidity + (base.humidity - s.humidity) * 0.2 + (Math.random() - 0.5) * 1.6,
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
      types[key] = { label: t.label, vendor: t.vendor, model: t.model, description: t.description, props: t.props, observe: observables(key), actions: t.actions || [], battery: t.powerSource === 'Battery' };
    }
    return {
      version: VERSION,
      config: { ...config, has_password: !!password },
      mqtt: { connected: this.connected, error: this.mqttError },
      types,
      devices: this.devices.map((d) => ({
        ...d,
        ui: d.type === 'light' ? { hex: lightHex(d.state) } : d.type === 'cover' ? { target: this.moving.get(d.id) ?? null } : {},
      })),
      scenarios: this.scenarios,
    };
  }

  async shutdown() {
    clearInterval(this.ticker);
    this.saveNow();
    await this.disconnect();
  }
}
