// Scenarios: scripted sequences of "things happening in the house"
// (a window opens, the temperature falls, somebody presses a button ...).

// An "expect" step turns a scenario into a test: it waits until a device reports
// the expected value - typically because an automation reacted - or fails.

import crypto from 'node:crypto';
import { DAY, SPEEDS, formatTime, parseTime } from './clock.js';
import { observables, observe } from './devices.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const STEP_TYPES = ['wait', 'set', 'ramp', 'press', 'availability', 'expect', 'clock', 'until'];
const OPS = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥' };
const COLOR_TOLERANCE = 48; // colours survive the trip through x/y only approximately
const MAX_FAILURES = 50;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));

/** Does the value a device reports satisfy an expectation? */
function holds(kind, actual, op, expected) {
  if (kind === 'color') {
    const [a, b] = [rgb(actual), rgb(expected)];
    const near = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= COLOR_TOLERANCE;
    return op === 'ne' ? !near : near;
  }
  if (kind === 'number') {
    const [a, b] = [Number(actual), Number(expected)];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const same = Math.abs(a - b) < 1e-9;
    return { eq: same, ne: !same, lt: a < b && !same, le: a < b || same, gt: a > b && !same, ge: a > b || same }[op];
  }
  const same = String(actual).toLowerCase() === String(expected).toLowerCase();
  return op === 'ne' ? !same : op === 'eq' && same; // texts and booleans have no order
}

function cleanStep(step) {
  if (!step || !STEP_TYPES.includes(step.type)) throw fail('Invalid scenario step');
  const seconds = Math.min(86400, Math.max(0, Number(step.seconds) || 0));
  switch (step.type) {
    case 'wait':
      return { type: 'wait', seconds };
    case 'set':
      return { type: 'set', device: String(step.device || ''), property: String(step.property || ''), value: step.value };
    case 'ramp':
      return { type: 'ramp', device: String(step.device || ''), property: String(step.property || ''), to: Number(step.to) || 0, seconds };
    case 'press':
      return { type: 'press', device: String(step.device || ''), action: String(step.action || 'single') };
    case 'availability':
      return { type: 'availability', device: String(step.device || ''), available: !!step.available };
    case 'clock': {
      // speed 0 = leave the speed as it is
      const speed = Number(step.speed) || 0;
      if (parseTime(step.time) === undefined) throw fail('The time must look like 07:30');
      if (speed && !SPEEDS.includes(speed)) throw fail(`The speed must be one of ${SPEEDS.join(', ')}`);
      return { type: 'clock', time: formatTime(parseTime(step.time)), speed };
    }
    case 'until':
      if (parseTime(step.time) === undefined) throw fail('The time must look like 07:30');
      return { type: 'until', time: formatTime(parseTime(step.time)) };
    case 'expect':
      if (!(step.op in OPS)) throw fail(`Unknown comparison '${step.op}'`);
      return { type: 'expect', device: String(step.device || ''), property: String(step.property || ''), op: step.op, value: step.value, seconds };
  }
}

const isTest = (scenario) => scenario.steps.some((s) => s.type === 'expect');

export class ScenarioRunner {
  constructor(sim) {
    this.sim = sim;
    this.running = new Map(); // scenario id -> { abort, step, wake }
    this.results = new Map(); // scenario id -> result of the current / last run (not persisted)
    this.suite = false; // "run all tests" in progress
  }

  resultsView() {
    return Object.fromEntries(this.results);
  }

  status() {
    const out = {};
    for (const [id, ctl] of this.running) out[id] = ctl.step;
    return out;
  }

  get(id) {
    const scenario = this.sim.scenarios.find((s) => s.id === id);
    if (!scenario) throw fail('Scenario not found', 404);
    return scenario;
  }

  save(id, body) {
    const name = String(body.name ?? '').trim();
    if (!name) throw fail('A name is required');
    if (!Array.isArray(body.steps)) throw fail('steps must be a list');
    const data = { name, loop: !!body.loop, steps: body.steps.map(cleanStep) };
    let scenario;
    if (id) {
      scenario = Object.assign(this.get(id), data);
      if (!this.running.has(id)) this.results.delete(id); // the old result belongs to the old steps
    } else {
      scenario = { id: crypto.randomBytes(6).toString('hex'), ...data };
      this.sim.scenarios.push(scenario);
    }
    this.sim.changed();
    return scenario;
  }

  remove(id) {
    this.get(id);
    this.stop(id);
    this.results.delete(id);
    this.sim.scenarios =this.sim.scenarios.filter((s) => s.id !== id);
    this.sim.changed();
  }

  stop(id) {
    const ctl = this.running.get(id);
    if (!ctl) return;
    ctl.abort = true;
    ctl.wake?.();
  }

  stopAll() {
    for (const id of this.running.keys()) this.stop(id);
  }

  sleep(ctl, ms) {
    if (ctl.abort || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      ctl.wake = () => { clearTimeout(timer); resolve(); };
    });
  }

  async run(id) {
    const scenario = this.get(id);
    if (this.running.has(id)) return null;
    const ctl = { abort: false, step: 0 };
    // steps: outcome per step of the current pass; checks: expectations met so far.
    const result = { status: 'running', started: Date.now(), checks: 0, failures: [], steps: {} };
    this.running.set(id, ctl);
    this.results.set(id, result);
    try {
      do {
        const started = Date.now();
        const steps = [...scenario.steps];
        result.steps = {};
        for (let i = 0; i < steps.length && !ctl.abort; i++) {
          ctl.step = i;
          this.sim.emit('change');
          try {
            await this.exec(steps[i], ctl);
            if (steps[i].type === 'expect' && !ctl.abort) {
              result.checks++;
              result.steps[i] = 'passed';
            }
          } catch (err) {
            // A failed step does not end the scenario: the steps after it often tidy up.
            console.warn(`Scenario '${scenario.name}', step ${i + 1}: ${err.message}`);
            result.steps[i] = 'failed';
            if (result.failures.length < MAX_FAILURES) result.failures.push({ step: i, message: err.message });
          }
        }
        // A looping scenario without any waiting would spin forever.
        if (scenario.loop && Date.now() - started < 500) await this.sleep(ctl, 500);
      } while (scenario.loop && !ctl.abort && this.sim.scenarios.includes(scenario));
    } finally {
      result.finished = Date.now();
      result.status = result.failures.length ? 'failed' : ctl.abort ? 'stopped' : result.checks ? 'passed' : 'done';
      this.running.delete(id);
      this.sim.emit('change');
    }
    return result;
  }

  /** Runs every scenario that contains expectations, one after the other. */
  async runTests() {
    if (this.suite) throw fail('The tests are already running', 409);
    const tests = this.sim.scenarios.filter((s) => isTest(s) && !s.loop);
    if (!tests.length) throw fail('No scenario contains an "Expect" step yet');
    this.suite = true;
    const results = [];
    try {
      for (const scenario of tests) {
        if (!this.sim.scenarios.includes(scenario)) continue; // deleted meanwhile
        const result = await this.run(scenario.id);
        if (!result) continue; // already running on its own
        results.push({ id: scenario.id, name: scenario.name, status: result.status, seconds: (result.finished - result.started) / 1000, failures: result.failures });
        if (result.status === 'stopped') break;
      }
    } finally {
      this.suite = false;
    }
    const count = (status) => results.filter((r) => r.status === status).length;
    return { ok: results.length > 0 && results.every((r) => r.status === 'passed'), passed: count('passed'), failed: count('failed'), stopped: count('stopped'), results };
  }

  /** Waits until the simulated clock reaches a time of day. */
  async until(step, ctl) {
    const sim = this.sim;
    const target = parseTime(step.time);
    const togo = () => (target - sim.clock.minutes + DAY) % DAY;
    if (!sim.clock.running) throw fail(`Cannot wait until ${step.time}: the simulated clock is paused`);
    let left = togo();
    while (!ctl.abort) {
      await this.sleep(ctl, 100);
      const now = togo();
      // The distance only jumps up when the clock has passed the time (or was set past it).
      if (now > left + DAY / 2 || now < 0.01) return;
      left = now;
    }
  }

  async expect(step, ctl) {
    const sim = this.sim;
    const deadline = Date.now() + step.seconds * 1000;
    for (;;) {
      const dev = sim.getDevice(step.device);
      const prop = observables(dev.type).find((p) => p.name === step.property);
      if (!prop) throw fail(`${dev.friendly_name} has no '${step.property}' to check`);
      const actual = observe(dev, step.property);
      if (holds(prop.kind, actual, step.op, step.value)) return;
      if (ctl.abort) return;
      const left = deadline - Date.now();
      if (left <= 0) {
        const unit = prop.unit ? ` ${prop.unit}` : '';
        throw fail(`${dev.friendly_name}: expected ${prop.label.toLowerCase()} ${OPS[step.op]} ${step.value}${unit}${step.seconds ? ` within ${step.seconds} s` : ''}, but it was ${actual}${unit}`);
      }
      await this.sleep(ctl, Math.min(100, left));
    }
  }

  async exec(step, ctl) {
    const sim = this.sim;
    switch (step.type) {
      case 'wait':
        return this.sleep(ctl, step.seconds * 1000);
      case 'set':
        return void sim.setValues(step.device, { [step.property]: step.value });
      case 'press':
        return sim.pressButton(step.device, step.action);
      case 'availability':
        return void sim.updateDevice(step.device, { available: step.available });
      case 'expect':
        return this.expect(step, ctl);
      case 'clock':
        return void sim.setClock({ time: step.time, running: true, ...(step.speed ? { speed: step.speed } : {}) });
      case 'until':
        return this.until(step, ctl);
      case 'ramp': {
        const dev = sim.getDevice(step.device);
        const from = Number(dev.state[step.property] ?? dev.sim[step.property]);
        if (!Number.isFinite(from)) throw fail(`'${step.property}' cannot be ramped`);
        const tick = Math.min(1, Math.max(0.25, step.seconds / 20));
        const count = Math.max(1, Math.round(step.seconds / tick));
        for (let i = 1; i <= count && !ctl.abort; i++) {
          await this.sleep(ctl, (step.seconds * 1000) / count);
          if (ctl.abort) return;
          sim.setValues(step.device, { [step.property]: from + ((step.to - from) * i) / count });
        }
      }
    }
  }

  /** Creates a small demo home plus a few scenarios (skips whatever already exists). */
  createDemo() {
    const sim = this.sim;
    const home = [
      ['Living Room', 'light', 'Living Room Lamp'],
      ['Living Room', 'sensor', 'Living Room Climate'],
      ['Living Room', 'window', 'Living Room Window'],
      ['Living Room', 'button', 'Living Room Switch'],
      ['Bedroom', 'light', 'Bedroom Lamp'],
      ['Bedroom', 'sensor', 'Bedroom Climate'],
      ['Bedroom', 'window', 'Bedroom Window'],
      ['Bedroom', 'button', 'Bedside Button'],
      ['Kitchen', 'light', 'Kitchen Light'],
      ['Kitchen', 'sensor', 'Kitchen Climate'],
      ['Kitchen', 'window', 'Kitchen Window'],
      ['Bathroom', 'sensor', 'Bathroom Climate'],
      ['Bathroom', 'window', 'Bathroom Window'],
      ['Hallway', 'light', 'Hallway Light'],
      ['Hallway', 'button', 'Hallway Button'],
      ['Hallway', 'motion', 'Hallway Motion'],
      ['Living Room', 'motion', 'Living Room Motion'],
      ['Living Room', 'cover', 'Living Room Blind'],
      ['Living Room', 'thermostat', 'Living Room Thermostat'],
      ['Bedroom', 'cover', 'Bedroom Blind'],
      ['Bedroom', 'thermostat', 'Bedroom Thermostat'],
      ['Kitchen', 'plug', 'Coffee Machine'],
      ['Kitchen', 'smoke', 'Kitchen Smoke Detector'],
      ['Bathroom', 'plug', 'Washing Machine'],
      ['Bathroom', 'leak', 'Bathroom Leak Sensor'],
      ['Outside', 'sensor', 'Outdoor Climate', { outdoor: true }],
      ['Outside', 'motion', 'Terrace Motion', { sun: true, peak: 8000 }],
    ];
    const id = {};
    for (const [room, type, friendly_name, follow] of home) {
      const existing = sim.devices.find((d) => d.friendly_name === friendly_name);
      id[friendly_name] = (existing || sim.addDevice({ type, friendly_name, room })).id;
      if (!existing && follow) sim.updateDevice(id[friendly_name], { sim: follow });
    }
    const scenarios = [
      {
        name: 'Airing the bedroom',
        steps: [
          { type: 'set', device: id['Bedroom Window'], property: 'contact', value: false },
          { type: 'ramp', device: id['Bedroom Climate'], property: 'temperature', to: 16, seconds: 40 },
          { type: 'ramp', device: id['Bedroom Climate'], property: 'humidity', to: 38, seconds: 10 },
          { type: 'set', device: id['Bedroom Window'], property: 'contact', value: true },
          { type: 'ramp', device: id['Bedroom Climate'], property: 'temperature', to: 21, seconds: 60 },
        ],
      },
      {
        name: 'Taking a shower',
        steps: [
          { type: 'ramp', device: id['Bathroom Climate'], property: 'humidity', to: 88, seconds: 30 },
          { type: 'ramp', device: id['Bathroom Climate'], property: 'temperature', to: 25, seconds: 10 },
          { type: 'wait', seconds: 15 },
          { type: 'set', device: id['Bathroom Window'], property: 'contact', value: false },
          { type: 'ramp', device: id['Bathroom Climate'], property: 'humidity', to: 50, seconds: 45 },
          { type: 'set', device: id['Bathroom Window'], property: 'contact', value: true },
        ],
      },
      {
        name: 'Coming home',
        steps: [
          { type: 'press', device: id['Hallway Button'], action: 'single' },
          { type: 'wait', seconds: 5 },
          { type: 'press', device: id['Living Room Switch'], action: 'single' },
          { type: 'wait', seconds: 20 },
          { type: 'ramp', device: id['Living Room Climate'], property: 'temperature', to: 23, seconds: 60 },
        ],
      },
      {
        name: 'Good night',
        steps: [
          { type: 'press', device: id['Living Room Switch'], action: 'double' },
          { type: 'wait', seconds: 10 },
          { type: 'press', device: id['Bedside Button'], action: 'hold' },
          { type: 'wait', seconds: 2 },
          { type: 'press', device: id['Bedside Button'], action: 'release' },
        ],
      },
      {
        name: 'Walking through the house',
        steps: [
          { type: 'set', device: id['Hallway Motion'], property: 'occupancy', value: true },
          { type: 'wait', seconds: 6 },
          { type: 'set', device: id['Living Room Motion'], property: 'occupancy', value: true },
          { type: 'wait', seconds: 4 },
          { type: 'set', device: id['Hallway Motion'], property: 'occupancy', value: false },
          { type: 'wait', seconds: 30 },
          { type: 'set', device: id['Living Room Motion'], property: 'occupancy', value: false },
        ],
      },
      {
        name: 'Washing machine cycle',
        steps: [
          { type: 'set', device: id['Washing Machine'], property: 'state', value: 'ON' },
          { type: 'set', device: id['Washing Machine'], property: 'load', value: 2000 },
          { type: 'wait', seconds: 30 },
          { type: 'set', device: id['Washing Machine'], property: 'load', value: 150 },
          { type: 'wait', seconds: 30 },
          { type: 'set', device: id['Washing Machine'], property: 'load', value: 500 },
          { type: 'wait', seconds: 20 },
          { type: 'set', device: id['Washing Machine'], property: 'load', value: 2 },
        ],
      },
      {
        name: 'Sunset: it gets dark and the blinds go down',
        steps: [
          { type: 'ramp', device: id['Living Room Motion'], property: 'illuminance', to: 5, seconds: 30 },
          { type: 'set', device: id['Living Room Blind'], property: 'state', value: 'CLOSE' },
          { type: 'set', device: id['Bedroom Blind'], property: 'position', value: 20 },
        ],
      },
      {
        name: 'Water leak in the bathroom',
        steps: [
          { type: 'set', device: id['Bathroom Leak Sensor'], property: 'water_leak', value: true },
          { type: 'wait', seconds: 30 },
          { type: 'set', device: id['Bathroom Leak Sensor'], property: 'water_leak', value: false },
        ],
      },
      {
        name: 'A day in the life (runs on the simulated clock)',
        steps: [
          { type: 'clock', time: '06:00', speed: 600 },
          { type: 'until', time: '06:30' },
          { type: 'press', device: id['Bedside Button'], action: 'single' },
          { type: 'until', time: '06:45' },
          { type: 'set', device: id['Hallway Motion'], property: 'occupancy', value: true },
          { type: 'set', device: id['Coffee Machine'], property: 'state', value: 'ON' },
          { type: 'set', device: id['Coffee Machine'], property: 'load', value: 1200 },
          { type: 'until', time: '07:15' },
          { type: 'set', device: id['Coffee Machine'], property: 'state', value: 'OFF' },
          { type: 'until', time: '08:00' },
          { type: 'set', device: id['Hallway Motion'], property: 'occupancy', value: true },
          { type: 'press', device: id['Hallway Button'], action: 'double' },
          { type: 'until', time: '13:00' },
          { type: 'set', device: id['Washing Machine'], property: 'state', value: 'ON' },
          { type: 'set', device: id['Washing Machine'], property: 'load', value: 2000 },
          { type: 'until', time: '14:30' },
          { type: 'set', device: id['Washing Machine'], property: 'load', value: 2 },
          { type: 'until', time: '17:30' },
          { type: 'set', device: id['Hallway Motion'], property: 'occupancy', value: true },
          { type: 'press', device: id['Hallway Button'], action: 'single' },
          { type: 'until', time: '18:00' },
          { type: 'set', device: id['Living Room Motion'], property: 'occupancy', value: true },
          { type: 'until', time: '22:30' },
          { type: 'press', device: id['Living Room Switch'], action: 'double' },
          { type: 'press', device: id['Bedside Button'], action: 'hold' },
          { type: 'until', time: '23:00' },
        ],
      },
      {
        name: 'Test: the bedroom blind closes and opens again',
        steps: [
          { type: 'set', device: id['Bedroom Blind'], property: 'state', value: 'CLOSE' },
          { type: 'expect', device: id['Bedroom Blind'], property: 'position', op: 'eq', value: 0, seconds: 15 },
          { type: 'set', device: id['Bedroom Blind'], property: 'state', value: 'OPEN' },
          { type: 'expect', device: id['Bedroom Blind'], property: 'position', op: 'eq', value: 100, seconds: 15 },
        ],
      },
      {
        name: 'Test: heating goes down while the bedroom window is open (needs your automation)',
        steps: [
          { type: 'set', device: id['Bedroom Thermostat'], property: 'occupied_heating_setpoint', value: 21 },
          { type: 'set', device: id['Bedroom Window'], property: 'contact', value: false },
          { type: 'expect', device: id['Bedroom Thermostat'], property: 'occupied_heating_setpoint', op: 'le', value: 12, seconds: 20 },
          { type: 'set', device: id['Bedroom Window'], property: 'contact', value: true },
          { type: 'expect', device: id['Bedroom Thermostat'], property: 'occupied_heating_setpoint', op: 'ge', value: 20, seconds: 20 },
        ],
      },
      {
        name: 'Sensor drops off the network',
        steps: [
          { type: 'availability', device: id['Kitchen Climate'], available: false },
          { type: 'wait', seconds: 30 },
          { type: 'availability', device: id['Kitchen Climate'], available: true },
        ],
      },
    ];
    for (const s of scenarios) {
      if (!sim.scenarios.some((x) => x.name === s.name)) this.save(null, { ...s, loop: false });
    }
  }
}
