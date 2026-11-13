// Web UI of the Zigbee2MQTT simulator. Plain DOM, no build step.
// The server pushes a full snapshot over server-sent events whenever something changes.

let S = null; // latest snapshot from the server

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const ICONS = {
  sensor: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v8"/>',
  light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  window: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M12 3v18M4 12h16"/>',
  windowOpen: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M4 3l7 3v12l-7 3"/>',
  button: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/>',
  motion: '<circle cx="13" cy="4.5" r="1.8"/><path d="M13 8l-3 2v4M13 8l3 3 3 1M13 8v6l3 3v4M13 14l-3 3-2 4"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  thermostat: '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l3.5-3.5M7.5 16.5h9"/>',
  cover: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M4 7h16M4 11h16M4 15h16"/>',
  leak: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  smoke: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M12 5.5V7M12 17v1.5M5.5 12H7M17 12h1.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
};
function icon(name, size = 18) {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return wrap.firstChild;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
/** Fire-and-forget API call: errors end up in a toast. */
const run = (...args) => api(...args).catch((err) => toast(err.message));

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

/** Calls fn at most every `ms`, always delivering the last value. */
function throttle(fn, ms = 90) {
  let timer = null;
  let last = null;
  return (...args) => {
    last = args;
    timer ??= setTimeout(() => { timer = null; fn(...last); }, ms);
  };
}

function select(options, value, onchange) {
  const el = h('select', { onchange: () => onchange(el.value) }, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value ?? '';
  return el;
}

const byId = (id) => S.devices.find((d) => d.id === id);
/** Does the room of this device simulate its climate and light? (An outdoor sensor is not in the room.) */
const inPhysicsRoom = (d) => !!S.rooms[d.room]?.physics && !(d.type === 'sensor' && d.sim.outdoor);
const typeOrder = () => Object.keys(S.types); // the server lists the types in display order

/** Devices that are just one on/off fact. `alarm` is the value that is worth highlighting. */
const BINARY = {
  window: { prop: 'contact', alarm: false, alarmText: 'Open', okText: 'Closed', alarmIcon: 'windowOpen', okIcon: 'window' },
  leak: { prop: 'water_leak', alarm: true, alarmText: 'Leak detected', okText: 'Dry', alarmIcon: 'leak', okIcon: 'leak' },
  smoke: { prop: 'smoke', alarm: true, alarmText: 'Smoke detected', okText: 'Clear', alarmIcon: 'smoke', okIcon: 'smoke' },
};

// ---------------------------------------------------------------- reusable controls

/** A labelled slider that does not jump around while the user is dragging it. */
function slider(label, { min, max, step }, format, onSend) {
  const out = h('output');
  const input = h('input', { type: 'range', min, max, step });
  const send = throttle(onSend);
  let busyTimer;
  input.addEventListener('input', () => {
    input._busy = true;
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => (input._busy = false), 700);
    out.textContent = format(Number(input.value));
    send(Number(input.value));
  });
  return {
    el: h('div', { class: 'field' }, h('label', {}, label), out, input),
    set(value) {
      if (input._busy) return;
      input.value = value;
      out.textContent = format(Number(value));
    },
  };
}

function toggle(onChange, title) {
  const input = h('input', { type: 'checkbox', title, onchange: () => onChange(input.checked) });
  return { el: h('span', { class: 'switch', title }, input, h('i')), set: (v) => (input.checked = !!v) };
}

function numberBox(attrs, onChange) {
  const input = h('input', { type: 'number', ...attrs, onchange: () => input.value !== '' && onChange(Number(input.value)) });
  return { el: input, set: (v) => { if (document.activeElement !== input) input.value = v; } };
}

// ---------------------------------------------------------------- device cards

function createCard(dev) {
  const id = dev.id;
  const type = S.types[dev.type];
  const patch = (body) => run('PATCH', `/api/devices/${id}`, body);
  const setState = (values) => patch({ state: values });
  const updaters = [];
  const body = h('div', { class: 'body' });

  if (dev.type === 'sensor') {
    const temp = h('div', { class: 'big' });
    const hum = h('div', { class: 'big' });
    const tSlider = slider('Temperature', { min: -10, max: 40, step: 0.1 }, (v) => `${v.toFixed(1)} °C`, (v) => setState({ temperature: v }));
    const hSlider = slider('Humidity', { min: 0, max: 100, step: 0.5 }, (v) => `${v.toFixed(1)} %`, (v) => setState({ humidity: v }));
    const auto = h('input', { type: 'checkbox', onchange: () => patch({ sim: { auto: auto.checked } }) });
    const interval = numberBox({ min: 1, max: 3600, title: 'Report interval in seconds' }, (v) => patch({ sim: { interval: v } }));
    const outdoor = h('input', { type: 'checkbox', onchange: () => patch({ sim: { outdoor: outdoor.checked } }) });
    body.append(
      h('div', { class: 'readouts' }, temp, hum),
      tSlider.el,
      hSlider.el,
      h('div', { class: 'row between' },
        h('label', { class: 'check', title: 'Let the values wander around the set point and report periodically' }, auto, 'Auto drift'),
        h('span', { class: 'row' }, 'every', interval.el, 's')),
      h('label', { class: 'check', title: 'Temperature and humidity follow the simulated weather (see the clock bar)' }, outdoor, 'Outdoor sensor: follows the weather'),
    );
    updaters.push((d) => {
      temp.replaceChildren(d.state.temperature.toFixed(1), h('small', {}, '°C'));
      hum.replaceChildren(d.state.humidity.toFixed(1), h('small', {}, '%'));
      tSlider.set(d.state.temperature);
      hSlider.set(d.state.humidity);
      auto.checked = !!d.sim.auto;
      interval.set(d.sim.interval);
      outdoor.checked = !!d.sim.outdoor;
      tSlider.el.classList.toggle('follows', !!d.sim.outdoor);
      hSlider.el.classList.toggle('follows', !!d.sim.outdoor);
    });
  }

  if (dev.type === 'light') {
    const bulb = h('div', { class: 'bulb' });
    const label = h('div', { class: 'big' });
    const power = toggle((on) => setState({ state: on ? 'ON' : 'OFF' }), 'Switch the light');
    const bri = slider('Brightness', { min: 1, max: 254, step: 1 }, (v) => `${Math.round((v / 254) * 100)} %`, (v) => setState({ brightness: v }));
    const ct = slider('Color temperature', { min: 153, max: 500, step: 1 }, (v) => `${Math.round(1e6 / v)} K`, (v) => setState({ color_temp: v }));
    ct.el.classList.add('ct');
    ct.el.append(h('div', { class: 'ct-track' }));
    const sendColor = throttle((hex) => setState({ color: { hex } }));
    let colorTimer;
    const color = h('input', {
      type: 'color',
      title: 'Color',
      oninput: () => {
        color._busy = true;
        clearTimeout(colorTimer);
        colorTimer = setTimeout(() => (color._busy = false), 700);
        sendColor(color.value);
      },
    });
    const mode = h('span', { class: 'hint' });
    body.append(
      h('div', { class: 'row between' }, h('div', { class: 'row' }, bulb, label), power.el),
      bri.el,
      ct.el,
      h('div', { class: 'row between' }, h('span', { class: 'row' }, color, 'Color'), mode),
    );
    updaters.push((d) => {
      const on = d.state.state === 'ON';
      label.textContent = on ? 'On' : 'Off';
      power.set(on);
      bri.set(d.state.brightness);
      ct.set(d.state.color_temp);
      if (!color._busy) color.value = d.ui.hex;
      mode.textContent = d.state.color_mode === 'xy' ? 'mode: color' : 'mode: white';
      bulb.style.background = on ? d.ui.hex : '';
      bulb.style.opacity = on ? 0.35 + (0.65 * d.state.brightness) / 254 : '';
      bulb.style.boxShadow = on ? `0 0 ${4 + d.state.brightness / 12}px ${d.ui.hex}` : '';
    });
  }

  if (BINARY[dev.type]) {
    const b = BINARY[dev.type];
    const title = h('b');
    const iconSlot = h('span');
    let value = null;
    const btn = h('button', { class: 'contact', title: 'Click to toggle', onclick: () => setState({ [b.prop]: !value }) },
      iconSlot, h('div', {}, title, h('span', {}, 'Click to toggle')));
    body.append(btn);
    updaters.push((d) => {
      if (value === d.state[b.prop]) return;
      value = d.state[b.prop];
      const alarm = value === b.alarm;
      title.textContent = alarm ? b.alarmText : b.okText;
      btn.classList.toggle('open', alarm);
      iconSlot.replaceChildren(icon(alarm ? b.alarmIcon : b.okIcon, 34));
    });
  }

  if (dev.type === 'motion') {
    const status = h('div', { class: 'big' });
    const trigger = h('button', { title: 'Somebody walks past the sensor', onclick: () => setState({ occupancy: true }) }, 'Trigger motion');
    const clear = h('button', { class: 'ghost', onclick: () => setState({ occupancy: false }) }, 'Clear');
    const lux = slider('Illuminance', { min: 0, max: 1000, step: 1 }, (v) => `${v} lx`, (v) => setState({ illuminance: v }));
    const timeout = numberBox({ min: 0, max: 3600, title: 'Seconds without motion until occupancy clears (0 = never)' }, (v) => patch({ sim: { timeout: v } }));
    const sun = h('input', { type: 'checkbox', onchange: () => patch({ sim: { sun: sun.checked } }) });
    const peak = numberBox({ min: 0, max: 10000, title: 'Illuminance at noon' }, (v) => patch({ sim: { peak: v } }));
    body.append(
      status,
      h('div', { class: 'row' }, trigger, clear),
      lux.el,
      h('div', { class: 'row' }, 'Clears after', timeout.el, 's'),
      h('div', { class: 'row between' },
        h('label', { class: 'check', title: 'The illuminance follows the simulated daylight (see the clock bar)' }, sun, 'Follows the sun'),
        h('span', { class: 'row' }, 'up to', peak.el, 'lx')),
    );
    updaters.push((d) => {
      status.textContent = d.state.occupancy ? 'Motion' : 'Clear';
      status.style.color = d.state.occupancy ? 'var(--warn)' : '';
      clear.disabled = !d.state.occupancy;
      lux.set(d.state.illuminance);
      timeout.set(d.sim.timeout);
      const physics = inPhysicsRoom(d);
      sun.checked = !!d.sim.sun || physics;
      sun.disabled = physics;
      sun.parentNode.title = physics
        ? 'Room physics: the illuminance comes from the daylight, the blinds and the lamps of this room'
        : 'The illuminance follows the simulated daylight (see the clock bar)';
      peak.set(d.sim.peak ?? 400);
      lux.el.classList.toggle('follows', !!d.sim.sun || physics);
    });
  }

  if (dev.type === 'plug') {
    const power = h('div', { class: 'big' });
    const details = h('span', { class: 'hint' });
    const sw = toggle((on) => setState({ state: on ? 'ON' : 'OFF' }), 'Switch the plug');
    const load = slider('Connected load (drawn while on)', { min: 0, max: 3000, step: 5 }, (v) => `${v} W`, (v) => setState({ load: v }));
    body.append(h('div', { class: 'row between' }, power, sw.el), load.el, details);
    updaters.push((d) => {
      power.replaceChildren(String(d.state.power), h('small', {}, 'W'));
      sw.set(d.state.state === 'ON');
      load.set(d.sim.load);
      details.textContent = `${d.state.energy.toFixed(3)} kWh · ${d.state.current} A · ${d.state.voltage} V`;
    });
  }

  if (dev.type === 'thermostat') {
    const temp = h('div', { class: 'big' });
    const running = h('span', { class: 'badge' });
    const mode = select([['off', 'Off'], ['auto', 'Auto'], ['heat', 'Heat']], dev.state.system_mode, (v) => setState({ system_mode: v }));
    const room = slider('Room temperature', { min: 5, max: 35, step: 0.1 }, (v) => `${v.toFixed(1)} °C`, (v) => setState({ local_temperature: v }));
    const setpoint = slider('Setpoint', { min: 4, max: 35, step: 0.5 }, (v) => `${v.toFixed(1)} °C`, (v) => setState({ occupied_heating_setpoint: v }));
    const auto = h('input', { type: 'checkbox', onchange: () => patch({ sim: { auto: auto.checked } }) });
    const ambient = numberBox({ min: -20, max: 40, title: 'Temperature the room cools down to while not heating' }, (v) => patch({ sim: { ambient: v } }));
    const simRow = h('div', { class: 'row between' },
      h('label', { class: 'check', title: 'The room warms up while heating and cools down towards the ambient temperature otherwise' }, auto, 'Simulate room'),
      h('span', { class: 'row' }, 'ambient', ambient.el, '°C'));
    body.append(
      h('div', { class: 'row between' }, h('div', { class: 'row' }, temp, running), mode),
      room.el,
      setpoint.el,
      simRow,
    );
    updaters.push((d) => {
      const heating = d.state.running_state === 'heat';
      simRow.classList.toggle('follows', inPhysicsRoom(d)); // room physics takes over
      simRow.title = inPhysicsRoom(d) ? 'Not used: room physics simulates this room' : '';
      temp.replaceChildren(d.state.local_temperature.toFixed(1), h('small', {}, '°C'));
      running.textContent = heating ? 'heating' : 'idle';
      running.style.color = heating ? 'var(--accent)' : '';
      if (document.activeElement !== mode) mode.value = d.state.system_mode;
      room.set(d.state.local_temperature);
      setpoint.set(d.state.occupied_heating_setpoint);
      auto.checked = !!d.sim.auto;
      ambient.set(d.sim.ambient);
    });
  }

  if (dev.type === 'cover') {
    const position = h('div', { class: 'big' });
    const status = h('span', { class: 'hint' });
    const command = (state) => h('button', { onclick: () => setState({ state }) }, state === 'CLOSE' ? 'Close' : state === 'OPEN' ? 'Open' : 'Stop');
    const target = slider('Target position', { min: 0, max: 100, step: 1 }, (v) => `${v} %`, (v) => setState({ position: v }));
    body.append(
      h('div', { class: 'row between' }, position, status),
      h('div', { class: 'press' }, command('OPEN'), command('STOP'), command('CLOSE')),
      target.el,
    );
    updaters.push((d) => {
      const pos = d.state.position;
      position.replaceChildren(String(pos), h('small', {}, '% open'));
      status.textContent = d.ui.target == null ? (pos === 0 ? 'closed' : pos === 100 ? 'open' : 'stopped') : d.ui.target > pos ? 'opening…' : 'closing…';
      target.set(d.ui.target ?? pos);
    });
  }

  if (dev.type === 'button') {
    const last = h('div', { class: 'last' });
    body.append(
      h('div', { class: 'press' }, type.actions.map((action) =>
        h('button', { onclick: () => run('POST', `/api/devices/${id}/action`, { action }) }, action))),
      last,
    );
    updaters.push((d) => {
      last.textContent = d.last_action
        ? `Last: ${d.last_action.action} at ${new Date(d.last_action.ts).toLocaleTimeString()}`
        : 'Not pressed yet';
    });
  }

  const name = h('b');
  const sub = h('span');
  const online = toggle((v) => patch({ available: v }), 'Reachable on the Zigbee network (availability)');
  const topic = h('code');
  const footRight = h('div', { class: 'foot-right' });
  if (type.battery) {
    const battery = numberBox({ min: 0, max: 100, title: 'Battery level in %' }, (v) => setState({ battery: v }));
    footRight.append(h('label', { class: 'check' }, 'Battery', battery.el, '%'));
    updaters.push((d) => battery.set(d.state.battery));
  }

  const card = h('article', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'type-icon' }, icon(dev.type, 20)),
      h('div', { class: 'card-title' }, name, sub),
      online.el,
      h('button', { class: 'icon', title: 'Rename / move', onclick: () => deviceDialog(byId(id)) }, icon('edit', 16)),
      h('button', { class: 'icon', title: 'Remove device', onclick: () => {
        if (confirm(`Remove '${byId(id).friendly_name}'?`)) run('DELETE', `/api/devices/${id}`);
      } }, icon('trash', 16)),
    ),
    body,
    h('div', { class: 'card-foot' }, topic, footRight),
  );
  card._update = (d) => {
    name.textContent = d.friendly_name;
    name.title = d.friendly_name;
    sub.textContent = `${type.vendor} ${type.model}`;
    topic.textContent = `${S.config.base_topic}/${d.friendly_name}`;
    topic.title = `${topic.textContent}  (${d.ieee})`;
    online.set(d.available);
    card.classList.toggle('offline', !d.available);
    for (const update of updaters) update(d);
  };
  return card;
}

const cards = new Map();
let layoutSignature = '';

const roomHeads = new Map(); // room name -> the controls in its heading
function renderDevices() {
  const root = $('#tab-devices');
  if (!S.devices.length) {
    layoutSignature = '';
    cards.clear();
    root.replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, 'No devices yet'),
      'Add your first virtual Zigbee device, or start with a complete demo home.',
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => deviceDialog() }, '+ Add device'),
        h('button', { onclick: createDemo }, 'Create demo home'))));
    return;
  }
  const rooms = new Map();
  for (const d of S.devices) {
    if (!rooms.has(d.room)) rooms.set(d.room, []);
    rooms.get(d.room).push(d);
  }
  const sorted = [...rooms.entries()].sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b));
  for (const [, list] of sorted) {
    const order = typeOrder();
    list.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.friendly_name.localeCompare(b.friendly_name));
  }
  // Only touch the layout when devices were added/removed/moved, so that dragging a slider is never interrupted.
  const signature = JSON.stringify(sorted.map(([room, list]) => [room, list.map((d) => d.id)]));
  if (signature !== layoutSignature) {
    layoutSignature = signature;
    const alive = new Set(S.devices.map((d) => d.id));
    for (const id of cards.keys()) if (!alive.has(id)) cards.delete(id);
    root.replaceChildren();
    for (const [room, list] of sorted) {
      const grid = h('div', { class: 'grid' });
      for (const d of list) {
        if (!cards.has(d.id)) cards.set(d.id, createCard(d));
        grid.append(cards.get(d.id));
      }
      const head = h('h2', {}, h('span', {}, room || 'No room', h('small', {}, `${list.length} device${list.length === 1 ? '' : 's'}`)));
      if (room) {
        const physics = h('input', { type: 'checkbox', onchange: () => run('PUT', '/api/rooms', { name: room, physics: physics.checked }) });
        const climate = h('span', { class: 'room-climate' });
        head.append(climate, h('label', {
          class: 'check',
          title: 'Links the devices of this room: open windows let the outdoor air in, heating thermostats warm the room, '
            + 'blinds and lamps change the illuminance. Sensors and thermostats report the room temperature.',
        }, physics, 'Room physics'));
        roomHeads.set(room, { physics, climate });
      }
      root.append(head, grid);
    }
  }
  for (const [room, head] of roomHeads) {
    const r = S.rooms[room];
    if (!r) { roomHeads.delete(room); continue; }
    head.physics.checked = r.physics;
    head.climate.textContent = r.physics ? `${r.temperature.toFixed(1)} °C · ${r.humidity} %` : '';
  }
  for (const d of S.devices) cards.get(d.id)._update(d);
}

// ---------------------------------------------------------------- dialogs

function openDialog({ title, body, submit = 'Save', wide = false, onSubmit }) {
  const dlg = $('#dialog');
  const error = h('p', { class: 'note', style: 'color: var(--bad)', hidden: true });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await onSubmit();
        dlg.close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    },
  },
    h('h3', {}, title),
    body,
    error,
    h('div', { class: 'buttons' },
      h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, submit)));
  dlg.className = wide ? 'wide' : '';
  dlg.replaceChildren(form);
  dlg.showModal();
}

const field = (label, input) => h('label', { class: 'f' }, label, input);

function roomInput(value) {
  const rooms = [...new Set(S.devices.map((d) => d.room).filter(Boolean))].sort();
  return [
    h('input', { type: 'text', value: value || '', placeholder: 'e.g. Living Room', list: 'rooms' }),
    h('datalist', { id: 'rooms' }, rooms.map((r) => h('option', { value: r }))),
  ];
}

/** Add a new device, or rename / move an existing one. */
function deviceDialog(dev) {
  const name = h('input', { type: 'text', required: true, value: dev?.friendly_name || '', placeholder: 'e.g. Living Room Lamp' });
  const [room, datalist] = roomInput(dev?.room);
  let type = 'light';
  const types = !dev && h('div', { class: 'types' }, typeOrder().map((key) =>
    h('label', {},
      h('input', { type: 'radio', name: 'type', checked: key === type, onchange: () => (type = key) }),
      icon(key, 22),
      h('div', {}, h('b', {}, S.types[key].label), h('span', {}, `${S.types[key].vendor} ${S.types[key].model}`)))));
  openDialog({
    title: dev ? `Edit ${dev.friendly_name}` : 'Add device',
    submit: dev ? 'Save' : 'Add device',
    body: [
      types,
      h('div', { class: 'two' }, field('Friendly name', name), field('Room (only used in this UI)', room)),
      datalist,
      h('p', { class: 'note' }, dev
        ? 'Renaming changes the MQTT topic. Home Assistant keeps the device, because its IEEE address stays the same.'
        : 'The device is announced on MQTT right away and shows up in Home Assistant through MQTT discovery.'),
    ],
    onSubmit: () => dev
      ? api('PATCH', `/api/devices/${dev.id}`, { friendly_name: name.value, room: room.value })
      : api('POST', '/api/devices', { type, friendly_name: name.value, room: room.value }),
  });
  name.focus();
}

function settingsDialog() {
  const c = S.config;
  const url = h('input', { type: 'text', required: true, value: c.mqtt_url, placeholder: 'mqtt://localhost:1883' });
  const user = h('input', { type: 'text', value: c.username, autocomplete: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.has_password ? '(unchanged)' : '' });
  const base = h('input', { type: 'text', required: true, value: c.base_topic });
  const disc = h('input', { type: 'text', required: true, value: c.discovery_prefix });
  openDialog({
    title: 'MQTT connection',
    submit: 'Save & reconnect',
    body: [
      S.mqtt.error && h('p', { class: 'note', style: 'color: var(--bad)' }, `Last error: ${S.mqtt.error}`),
      field('Broker URL', url),
      h('div', { class: 'two' }, field('Username', user), field('Password', pass)),
      h('div', { class: 'two' }, field('Base topic', base), field('Home Assistant discovery prefix', disc)),
      h('p', { class: 'note' }, 'Do not point the simulator at a base topic that a real Zigbee2MQTT instance is using on the same broker.'),
    ],
    onSubmit: () => api('PUT', '/api/config', {
      mqtt_url: url.value,
      username: user.value,
      base_topic: base.value,
      discovery_prefix: disc.value,
      ...(pass.value || !user.value ? { password: pass.value } : {}),
    }),
  });
}

function createDemo() {
  if (confirm('Create a demo home (27 devices in 6 rooms) with example scenarios? Devices that already exist are kept.')) run('POST', '/api/demo');
}

// ---------------------------------------------------------------- scenarios

const STEP_TYPES = [['wait', 'Wait'], ['set', 'Set value'], ['ramp', 'Change gradually'], ['press', 'Press button'], ['availability', 'Go offline / online'], ['expect', 'Expect (test)'], ['clock', 'Set clock'], ['until', 'Wait until (clock)']];
const NO_DEVICE = ['wait', 'clock', 'until']; // steps that are not about a device
const OPS = { eq: 'is', ne: 'is not', lt: '<', le: '≤', gt: '>', ge: '≥' };
const propsOf = (dev) => S.types[dev.type].props;
const propOf = (dev, name) => propsOf(dev).find((p) => p.name === name);
/** What an "expect" step can check: the values a device reports. */
const observeOf = (dev) => S.types[dev.type].observe;
const obsOf = (dev, name) => observeOf(dev).find((p) => p.name === name);
const opsFor = (prop) => Object.keys(OPS).filter((op) => prop.kind === 'number' || op === 'eq' || op === 'ne');
const isTest = (sc) => sc.steps.some((s) => s.type === 'expect');

function describeStep(step) {
  if (step.type === 'wait') return { text: `Wait ${step.seconds} s` };
  if (step.type === 'clock') return { text: `Set the clock to ${step.time}${step.speed ? ` at ${speedLabel(step.speed)}` : ''}` };
  if (step.type === 'until') return { text: `Wait until ${step.time} on the clock` };
  const dev = byId(step.device);
  if (!dev) return { text: `${step.type}: device no longer exists`, missing: true };
  const name = dev.friendly_name;
  if (step.type === 'press') return { text: `${name}: press "${step.action}"` };
  if (step.type === 'availability') return { text: `${name}: goes ${step.available ? 'online' : 'offline'}` };
  const p = step.type === 'expect' ? obsOf(dev, step.property) : propOf(dev, step.property);
  const label = p?.label.toLowerCase() || step.property;
  const unit = p?.unit ? ` ${p.unit}` : '';
  if (step.type === 'expect') {
    const expected = p?.kind === 'bool' ? p.labels[String(step.value)] : `${step.value}${unit}`;
    return { text: `Expect ${name}: ${label} ${OPS[step.op]} ${expected}${step.seconds ? ` within ${step.seconds} s` : ''}` };
  }
  if (step.type === 'ramp') return { text: `${name}: ${label} → ${step.to}${unit} over ${step.seconds} s` };
  const value = p?.kind === 'bool' ? p.labels[String(step.value)] : `${step.value}${unit}`;
  return { text: `${name}: ${label} → ${value}` };
}

let scenarioSignature = '';
function renderScenarios() {
  const names = S.devices.map((d) => [d.id, d.friendly_name]);
  const signature = JSON.stringify([S.scenarios, S.running, S.results, names]);
  if (signature === scenarioSignature) return;
  scenarioSignature = signature;
  const list = $('#scenario-list');
  const tests = S.scenarios.filter((sc) => isTest(sc) && !sc.loop);
  const count = (status) => tests.filter((sc) => S.results[sc.id]?.status === status).length;
  $('#btn-tests').disabled = !tests.length || tests.some((sc) => sc.id in S.running);
  $('#test-summary').textContent = !tests.length ? ''
    : `${tests.length} test${tests.length === 1 ? '' : 's'}` + (count('passed') || count('failed') ? ` · ${count('passed')} passed · ${count('failed')} failed` : '');
  $('#test-summary').className = 'summary' + (count('failed') ? ' failed' : count('passed') === tests.length && tests.length ? ' passed' : '');
  if (!S.scenarios.length) {
    list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'No scenarios yet'),
      'Create one, or use "Create demo home" to get a few examples.'));
    return;
  }
  list.replaceChildren(...S.scenarios.map((sc) => {
    const running = sc.id in S.running;
    const result = S.results[sc.id];
    const verdict = !running && result && ['passed', 'failed', 'stopped'].includes(result.status) && result.status;
    return h('div', { class: 'scenario' + (running ? ' running' : '') },
      h('header', {},
        h('div', {}, h('b', {}, sc.name), isTest(sc) && h('span', { class: 'badge' }, 'test'), sc.loop && h('span', { class: 'badge' }, 'loops'), running && h('span', { class: 'badge' }, 'running'),
          verdict && h('span', { class: `badge ${verdict}`, title: new Date(result.finished).toLocaleTimeString() }, verdict)),
        h('div', { class: 'actions' },
          running
            ? h('button', { onclick: () => run('POST', `/api/scenarios/${sc.id}/stop`) }, '■ Stop')
            : h('button', { class: 'primary', disabled: !sc.steps.length, onclick: () => run('POST', `/api/scenarios/${sc.id}/run`) }, '▶ Run'),
          h('button', { class: 'icon', title: 'Edit', onclick: () => scenarioDialog(sc) }, icon('edit', 16)),
          h('button', { class: 'icon', title: 'Delete', onclick: () => {
            if (confirm(`Delete scenario '${sc.name}'?`)) run('DELETE', `/api/scenarios/${sc.id}`);
          } }, icon('trash', 16)))),
      h('ol', {}, sc.steps.map((step, i) => {
        const d = describeStep(step);
        const outcome = result?.steps[i];
        const failure = outcome === 'failed' && result.failures.findLast((f) => f.step === i);
        return h('li', { class: [running && S.running[sc.id] === i && 'now', d.missing && 'missing', outcome].filter(Boolean).join(' ') },
          d.text, outcome === 'passed' && h('span', { class: 'mark' }, ' ✓'), failure && h('div', { class: 'why' }, `✗ ${failure.message}`));
      })));
  }));
}

function defaultValue(prop, dev) {
  if (prop.kind === 'number') return dev.state[prop.name] ?? dev.sim?.[prop.name] ?? prop.min;
  if (prop.kind === 'enum') return prop.values[0];
  if (prop.kind === 'bool') return false;
  return dev.ui.hex || '#ff8800';
}

/** Makes sure a step only references things its device actually has. */
function fixStep(step) {
  const dev = byId(step.device);
  if (!dev) return;
  if (step.type === 'set' && !propOf(dev, step.property)) {
    const p = propsOf(dev)[0];
    step.property = p.name;
    step.value = defaultValue(p, dev);
  }
  if (step.type === 'expect') {
    let p = obsOf(dev, step.property);
    if (!p) {
      p = observeOf(dev)[0];
      step.property = p.name;
      step.value = defaultValue(p, dev);
    }
    if (!opsFor(p).includes(step.op)) step.op = 'eq';
  }
  if (step.type === 'ramp' && propOf(dev, step.property)?.kind !== 'number') {
    const p = propsOf(dev).find((x) => x.kind === 'number');
    step.property = p.name;
    step.to = defaultValue(p, dev);
  }
}

function scenarioDialog(scenario) {
  const draft = structuredClone(scenario || { name: '', loop: false, steps: [{ type: 'wait', seconds: 5 }] });
  const name = h('input', { type: 'text', required: true, value: draft.name, placeholder: 'e.g. Airing the bedroom' });
  const loop = h('input', { type: 'checkbox', checked: draft.loop });
  const steps = h('div', { class: 'steps' });
  const num = (step, key, attrs) => h('input', { type: 'number', step: 'any', ...attrs, value: step[key], oninput: (e) => (step[key] = Number(e.target.value)) });

  const valueInput = (step, prop) => {
    if (prop.kind === 'number') return num(step, 'value', { min: prop.min, max: prop.max });
    if (prop.kind === 'enum') return select(prop.values.map((v) => [v, v]), step.value, (v) => (step.value = v));
    if (prop.kind === 'bool') return select([['false', prop.labels.false], ['true', prop.labels.true]], String(step.value), (v) => (step.value = v === 'true'));
    return h('input', { type: 'color', value: step.value, oninput: (e) => (step.value = e.target.value) });
  };

  const renderSteps = () => {
    steps.replaceChildren(...draft.steps.map((step, i) => {
      const row = h('div', { class: 'step' },
        select(STEP_TYPES, step.type, (type) => {
          draft.steps[i] = { type, seconds: type === 'expect' ? 30 : 5, device: step.device || '', action: 'single', available: false, op: 'eq', time: type === 'clock' ? '06:00' : '07:00', speed: 0 };
          fixStep(draft.steps[i]);
          renderSteps();
        }));
      if (step.type === 'wait') {
        row.append(num(step, 'seconds', { min: 0 }), h('span', {}, 'seconds'));
      } else if (step.type === 'clock' || step.type === 'until') {
        row.append(h('input', { type: 'time', required: true, value: step.time, oninput: (e) => (step.time = e.target.value) }));
        if (step.type === 'clock') {
          row.append(h('span', {}, 'and run at'),
            select([[0, 'the current speed'], ...S.clock.speeds.map((v) => [v, speedLabel(v)])], step.speed, (v) => (step.speed = Number(v))));
        } else {
          row.append(h('span', {}, 'simulated time - the clock has to be running'));
        }
      } else {
        const candidates = S.devices.filter((d) =>
          step.type === 'press' ? d.type === 'button' : step.type === 'ramp' ? propsOf(d).some((p) => p.kind === 'number') : true);
        if (!candidates.some((d) => d.id === step.device)) step.device = '';
        row.append(select([['', '— choose device —'], ...candidates.map((d) => [d.id, d.friendly_name])], step.device, (id) => {
          step.device = id;
          fixStep(step);
          renderSteps();
        }));
        const dev = candidates.find((d) => d.id === step.device);
        if (dev && (step.type === 'set' || step.type === 'ramp')) {
          const props = propsOf(dev).filter((p) => step.type === 'set' || p.kind === 'number');
          row.append(select(props.map((p) => [p.name, p.label]), step.property, (property) => {
            step.property = property;
            step[step.type === 'set' ? 'value' : 'to'] = defaultValue(propOf(dev, property), dev);
            renderSteps();
          }));
          const prop = propOf(dev, step.property);
          if (step.type === 'set') row.append(h('span', {}, '→'), valueInput(step, prop), prop.unit ? h('span', {}, prop.unit) : '');
          else row.append(h('span', {}, 'to'), num(step, 'to', { min: prop.min, max: prop.max }), h('span', {}, `${prop.unit || ''} over`), num(step, 'seconds', { min: 0 }), h('span', {}, 's'));
        }
        if (dev && step.type === 'expect') {
          row.append(select(observeOf(dev).map((p) => [p.name, p.label]), step.property, (property) => {
            step.property = property;
            step.value = defaultValue(obsOf(dev, property), dev);
            fixStep(step);
            renderSteps();
          }));
          const prop = obsOf(dev, step.property);
          row.append(
            select(opsFor(prop).map((op) => [op, OPS[op]]), step.op, (op) => (step.op = op)),
            valueInput(step, prop), prop.unit ? h('span', {}, prop.unit) : '',
            h('span', { title: 'How long the automation under test may take. 0 = it must be true right now.' }, 'within'), num(step, 'seconds', { min: 0 }), h('span', {}, 's'));
        }
        if (dev && step.type === 'press') row.append(select(S.types.button.actions.map((a) => [a, a]), step.action, (a) => (step.action = a)));
        if (dev && step.type === 'availability') row.append(select([['false', 'goes offline'], ['true', 'comes back online']], String(!!step.available), (v) => (step.available = v === 'true')));
      }
      const move = (delta) => {
        const j = i + delta;
        if (j < 0 || j >= draft.steps.length) return;
        [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
        renderSteps();
      };
      row.append(
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }, '▲'),
        h('button', { type: 'button', class: 'icon', title: 'Move down', disabled: i === draft.steps.length - 1, onclick: () => move(1) }, '▼'),
        h('button', { type: 'button', class: 'icon', title: 'Remove step', onclick: () => { draft.steps.splice(i, 1); renderSteps(); } }, icon('trash', 15)));
      return row;
    }));
  };
  renderSteps();

  openDialog({
    title: scenario ? 'Edit scenario' : 'New scenario',
    wide: true,
    body: [
      h('div', { class: 'two' }, field('Name', name), h('label', { class: 'check', style: 'align-self: end; padding-bottom: 7px' }, loop, 'Repeat until stopped')),
      steps,
      h('div', {}, h('button', { type: 'button', onclick: () => { draft.steps.push({ type: 'wait', seconds: 5 }); renderSteps(); } }, '+ Add step')),
    ],
    onSubmit: () => {
      if (draft.steps.some((s) => !NO_DEVICE.includes(s.type) && !byId(s.device))) throw new Error('Every step needs a device - choose one or remove the step.');
      const body = { name: name.value, loop: loop.checked, steps: draft.steps };
      return scenario ? api('PUT', `/api/scenarios/${scenario.id}`, body) : api('POST', '/api/scenarios', body);
    },
  });
}

// ---------------------------------------------------------------- simulated clock

const speedLabel = (speed) => speed === 1 ? 'real time' : speed < 3600 ? `${speed / 60} min per second` : `${speed / 3600} h per second`;
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
const setClock = (body) => run('PUT', '/api/clock', body);
let clockBusyTimer;

function renderClock() {
  const c = S.clock;
  const speed = $('#clock-speed');
  if (!speed.options.length) speed.append(...c.speeds.map((v) => h('option', { value: v }, speedLabel(v))));
  if (document.activeElement !== speed) speed.value = c.speed;
  $('.clock').classList.toggle('paused', !c.running);
  $('#clock-play').textContent = c.running ? '❚❚' : '▶';
  const slider = $('#clock-slider');
  if (!slider._busy) {
    slider.value = Math.floor(c.minutes);
    $('#clock-time').textContent = c.time;
  }
  const pct = (minutes) => `${((minutes / 1440) * 100).toFixed(1)}%`;
  $('#clock-track').style.background = `linear-gradient(90deg, #2b3a67 ${pct(c.sunrise - 40)}, #f6c453 ${pct(c.sunrise + 40)}, #f6c453 ${pct(c.sunset - 40)}, #2b3a67 ${pct(c.sunset + 40)})`;
  $('#clock-env').textContent = `${c.daylight > 0 ? `☀ ${c.daylight} % daylight` : '☾ night'} · ${c.outdoor_temperature.toFixed(1)} °C outside`;
}

function clockDialog() {
  const c = S.clock;
  const time = (minutes) => h('input', { type: 'time', required: true, value: hhmm(minutes) });
  const temp = (value) => h('input', { type: 'number', required: true, min: -40, max: 50, step: 0.5, value });
  const [sunrise, sunset, min, max] = [time(c.sunrise), time(c.sunset), temp(c.temp_min), temp(c.temp_max)];
  openDialog({
    title: 'Sun and weather',
    body: [
      h('div', { class: 'two' }, field('Sunrise', sunrise), field('Sunset', sunset)),
      h('div', { class: 'two' }, field('Coldest outdoor temperature (at sunrise), °C', min), field('Warmest (mid-afternoon), °C', max)),
      h('p', { class: 'note' }, 'Motion sensors set to "Follows the sun" and sensors set to "Outdoor sensor" take their values from this. '
        + 'Home Assistant gets the simulated time, sun, daylight and outdoor temperature as entities of the simulated bridge.'),
    ],
    onSubmit: () => api('PUT', '/api/clock', { sunrise: sunrise.value, sunset: sunset.value, temp_min: Number(min.value), temp_max: Number(max.value) }),
  });
}

// ---------------------------------------------------------------- MQTT log

const LOG_MAX = 500;
let logEntries = [];

function logRow(e) {
  return h('tr', { class: e.dir },
    h('td', {}, new Date(e.ts).toLocaleTimeString()),
    h('td', { title: e.dir === 'in' ? 'received' : 'published' }, e.dir === 'in' ? '← in' : 'out →'),
    h('td', {}, e.topic, e.retain && h('span', { class: 'retain' }, 'retained')),
    h('td', {}, e.payload === '' ? '(empty - clears retained message)' : e.payload.length > 600 ? e.payload.slice(0, 600) + ' …' : e.payload));
}
const logMatches = (e) => {
  const filter = $('#log-filter').value.trim().toLowerCase();
  return !filter || e.topic.toLowerCase().includes(filter) || e.payload.toLowerCase().includes(filter);
};
function renderLog() {
  $('#log-body').replaceChildren(...logEntries.filter(logMatches).reverse().map(logRow));
}
function addLog(entries) {
  logEntries = logEntries.concat(entries).slice(-LOG_MAX);
  if ($('#log-pause').checked) return;
  if (entries.length > 5) return renderLog();
  const body = $('#log-body');
  for (const e of entries) if (logMatches(e)) body.prepend(logRow(e));
  while (body.children.length > LOG_MAX) body.lastChild.remove();
}

// ---------------------------------------------------------------- page

function render() {
  const pill = $('#mqtt-status');
  pill.className = 'pill ' + (S.mqtt.connected ? 'ok' : S.mqtt.error ? 'bad' : '');
  $('#mqtt-text').textContent = S.mqtt.connected
    ? `connected · ${S.config.mqtt_url}`
    : S.mqtt.error ? `not connected · ${S.mqtt.error}` : `connecting to ${S.config.mqtt_url}…`;
  const n = S.devices.length;
  $('#summary').textContent = `${n} device${n === 1 ? '' : 's'} · base topic "${S.config.base_topic}" · v${S.version}`;
  renderClock();
  renderDevices();
  renderScenarios();
}

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) {
      const active = other === tab;
      other.setAttribute('aria-selected', active);
      $(`#tab-${other.dataset.tab}`).hidden = !active;
    }
  });
}
$('#btn-add').addEventListener('click', () => deviceDialog());
$('#btn-demo').addEventListener('click', createDemo);
$('#btn-scenario').addEventListener('click', () => scenarioDialog());
$('#clock-play').addEventListener('click', () => setClock({ running: !S.clock.running }));
$('#clock-speed').addEventListener('change', (e) => setClock({ speed: Number(e.target.value) }));
$('#clock-now').addEventListener('click', () => setClock({ time: 'now' }));
$('#clock-settings').addEventListener('click', clockDialog);
const sendClockTime = throttle((minutes) => setClock({ minutes }), 150);
$('#clock-slider').addEventListener('input', (e) => {
  e.target._busy = true;
  clearTimeout(clockBusyTimer);
  clockBusyTimer = setTimeout(() => (e.target._busy = false), 700);
  $('#clock-time').textContent = hhmm(Number(e.target.value));
  sendClockTime(Number(e.target.value));
});
$('#btn-tests').addEventListener('click', () => run('POST', '/api/tests/run'));
$('#mqtt-status').addEventListener('click', settingsDialog);
$('#log-filter').addEventListener('input', renderLog);
$('#log-pause').addEventListener('change', renderLog);
$('#log-clear').addEventListener('click', () => { logEntries = []; renderLog(); });

const events = new EventSource('/api/events');
let firstLog = true;
events.addEventListener('state', (e) => { S = JSON.parse(e.data); render(); });
events.addEventListener('log', (e) => {
  const entries = JSON.parse(e.data);
  if (firstLog) logEntries = []; // a reconnect replays the server's history
  firstLog = false;
  addLog(entries);
});
events.addEventListener('error', () => { firstLog = true; });
