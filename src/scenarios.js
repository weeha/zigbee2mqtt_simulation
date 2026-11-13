// Scenarios: scripted sequences of "things happening in the house"
// (a window opens, the temperature falls, somebody presses a button ...).

import crypto from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const STEP_TYPES = ['wait', 'set', 'ramp', 'press', 'availability'];

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
  }
}

export class ScenarioRunner {
  constructor(sim) {
    this.sim = sim;
    this.running = new Map(); // scenario id -> { abort, step, wake }
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
    this.sim.scenarios = this.sim.scenarios.filter((s) => s.id !== id);
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
    if (this.running.has(id)) return;
    const ctl = { abort: false, step: 0 };
    this.running.set(id, ctl);
    try {
      do {
        const started = Date.now();
        const steps = [...scenario.steps];
        for (let i = 0; i < steps.length && !ctl.abort; i++) {
          ctl.step = i;
          this.sim.emit('change');
          try {
            await this.exec(steps[i], ctl);
          } catch (err) {
            console.warn(`Scenario '${scenario.name}', step ${i + 1}: ${err.message}`);
          }
        }
        // A looping scenario without any waiting would spin forever.
        if (scenario.loop && Date.now() - started < 500) await this.sleep(ctl, 500);
      } while (scenario.loop && !ctl.abort && this.sim.scenarios.includes(scenario));
    } finally {
      this.running.delete(id);
      this.sim.emit('change');
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
    ];
    const id = {};
    for (const [room, type, friendly_name] of home) {
      const existing = sim.devices.find((d) => d.friendly_name === friendly_name);
      id[friendly_name] = (existing || sim.addDevice({ type, friendly_name, room })).id;
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
