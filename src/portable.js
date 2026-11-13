// Export / import of a home: devices, rooms, the sun & weather settings and the scenarios
// as one JSON document. The MQTT connection is deliberately not part of it.

import { TYPES, otaOf } from './devices.js';

const FORMAT = 'zigbee2mqtt-simulator-home';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function exportHome(sim) {
  const nameOf = (id) => sim.devices.find((d) => d.id === id)?.friendly_name ?? '';
  const { sunrise, sunset, temp_min, temp_max, speed } = sim.clock;
  return {
    format: FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    devices: sim.devices.map((d) => {
      const { base, ...settings } = d.sim; // "base" is working data of the auto drift
      return { type: d.type, friendly_name: d.friendly_name, room: d.room, ieee: d.ieee, available: d.available, firmware: otaOf(d).installed, state: d.state, sim: settings };
    }),
    rooms: Object.fromEntries(Object.entries(sim.rooms).filter(([name]) => sim.devices.some((d) => d.room === name))),
    clock: { sunrise, sunset, temp_min, temp_max, speed },
    // scenarios refer to devices by name, so that the file can be read and edited
    scenarios: sim.scenarios.map(({ name, loop, steps }) => ({
      name,
      loop,
      steps: steps.map((step) => ('device' in step ? { ...step, device: nameOf(step.device) } : step)),
    })),
  };
}

/**
 * mode "replace": the current home is removed first.
 * mode "merge":   devices and scenarios whose name already exists are left alone.
 */
export function importHome(sim, runner, home, mode = 'merge') {
  if (!home || home.format !== FORMAT || !Array.isArray(home.devices)) throw fail('This is not a home exported from the simulator');
  if (home.version !== 1) throw fail(`Unsupported file version ${home.version}`);
  if (mode !== 'merge' && mode !== 'replace') throw fail("mode must be 'merge' or 'replace'");
  // Check everything that could fail before the current home is touched.
  const entries = home.devices.filter((d) => d && TYPES[d.type] && typeof d.friendly_name === 'string');
  if (mode === 'replace') {
    for (const d of entries) sim.validateName(d.friendly_name, null, { unique: false }); // they replace the current devices
    if (new Set(entries.map((d) => d.friendly_name.trim())).size !== entries.length) throw fail('The file contains two devices with the same name');
    runner.stopAll();
    for (const dev of [...sim.devices]) sim.removeDevice(dev.id);
    sim.scenarios = [];
    sim.rooms = {};
    runner.results.clear();
  }

  const report = { devices: 0, scenarios: 0, skipped: [] };
  report.skipped.push(...home.devices.filter((d) => !entries.includes(d)).map((d) => `device '${d?.friendly_name ?? '?'}': unknown type`));
  for (const d of entries) {
    if (sim.devices.some((x) => x.friendly_name === d.friendly_name.trim())) {
      report.skipped.push(`device '${d.friendly_name}': already exists`);
      continue;
    }
    try {
      sim.addDevice({ type: d.type, friendly_name: d.friendly_name, room: d.room }, d);
      report.devices++;
    } catch (err) {
      report.skipped.push(`device '${d.friendly_name}': ${err.message}`);
    }
  }

  for (const [name, room] of Object.entries(home.rooms ?? {})) {
    if (sim.rooms[name] || !sim.devices.some((d) => d.room === name)) continue;
    const number = (v) => (Number.isFinite(v) ? v : undefined);
    try {
      sim.setRoom({ name, physics: !!room?.physics, temperature: number(room?.temperature), humidity: number(room?.humidity) });
      if (number(room?.co2)) sim.rooms[name].co2 = room.co2;
    } catch (err) {
      report.skipped.push(`room '${name}': ${err.message}`);
    }
  }

  if (mode === 'replace' && home.clock && typeof home.clock === 'object') {
    const { sunrise, sunset, temp_min, temp_max, speed } = home.clock;
    try {
      sim.setClock({ sunrise, sunset, temp_min, temp_max, speed });
    } catch (err) {
      report.skipped.push(`sun & weather: ${err.message}`);
    }
  }

  const idOf = (name) => sim.devices.find((d) => d.friendly_name === name)?.id ?? '';
  for (const sc of Array.isArray(home.scenarios) ? home.scenarios : []) {
    if (sim.scenarios.some((x) => x.name === sc?.name)) {
      report.skipped.push(`scenario '${sc.name}': already exists`);
      continue;
    }
    try {
      const steps = (sc.steps ?? []).map((step) => (step && 'device' in step ? { ...step, device: idOf(step.device) } : step));
      runner.save(null, { name: sc.name, loop: sc.loop, steps });
      report.scenarios++;
    } catch (err) {
      report.skipped.push(`scenario '${sc?.name ?? '?'}': ${err.message}`);
    }
  }
  sim.changed();
  return report;
}
