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
const TYPE_ORDER = ['light', 'sensor', 'window', 'button'];

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
    body.append(
      h('div', { class: 'readouts' }, temp, hum),
      tSlider.el,
      hSlider.el,
      h('div', { class: 'row between' },
        h('label', { class: 'check', title: 'Let the values wander around the set point and report periodically' }, auto, 'Auto drift'),
        h('span', { class: 'row' }, 'every', interval.el, 's')),
    );
    updaters.push((d) => {
      temp.replaceChildren(d.state.temperature.toFixed(1), h('small', {}, '°C'));
      hum.replaceChildren(d.state.humidity.toFixed(1), h('small', {}, '%'));
      tSlider.set(d.state.temperature);
      hSlider.set(d.state.humidity);
      auto.checked = !!d.sim.auto;
      interval.set(d.sim.interval);
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

  if (dev.type === 'window') {
    const title = h('b');
    const iconSlot = h('span');
    let contact = true;
    const btn = h('button', { class: 'contact', title: 'Click to open / close the window', onclick: () => setState({ contact: !contact }) },
      iconSlot, h('div', {}, title, h('span', {}, 'Click to toggle')));
    body.append(btn);
    updaters.push((d) => {
      if (contact === d.state.contact && title.textContent) return;
      contact = d.state.contact;
      title.textContent = contact ? 'Closed' : 'Open';
      btn.classList.toggle('open', !contact);
      iconSlot.replaceChildren(icon(contact ? 'window' : 'windowOpen', 34));
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
    list.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.friendly_name.localeCompare(b.friendly_name));
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
      root.append(h('h2', {}, room || 'No room', h('small', {}, `${list.length} device${list.length === 1 ? '' : 's'}`)), grid);
    }
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
  const types = !dev && h('div', { class: 'types' }, TYPE_ORDER.map((key) =>
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
  if (confirm('Create a demo home with 15 devices in 5 rooms and a few example scenarios?')) run('POST', '/api/demo');
}

// ---------------------------------------------------------------- scenarios

const STEP_TYPES = [['wait', 'Wait'], ['set', 'Set value'], ['ramp', 'Change gradually'], ['press', 'Press button'], ['availability', 'Go offline / online']];
const propsOf = (dev) => S.types[dev.type].props;
const propOf = (dev, name) => propsOf(dev).find((p) => p.name === name);

function describeStep(step) {
  if (step.type === 'wait') return { text: `Wait ${step.seconds} s` };
  const dev = byId(step.device);
  if (!dev) return { text: `${step.type}: device no longer exists`, missing: true };
  const name = dev.friendly_name;
  if (step.type === 'press') return { text: `${name}: press "${step.action}"` };
  if (step.type === 'availability') return { text: `${name}: goes ${step.available ? 'online' : 'offline'}` };
  const p = propOf(dev, step.property);
  const label = p?.label.toLowerCase() || step.property;
  const unit = p?.unit ? ` ${p.unit}` : '';
  if (step.type === 'ramp') return { text: `${name}: ${label} → ${step.to}${unit} over ${step.seconds} s` };
  const value = p?.kind === 'bool' ? p.labels[String(step.value)] : `${step.value}${unit}`;
  return { text: `${name}: ${label} → ${value}` };
}

let scenarioSignature = '';
function renderScenarios() {
  const names = S.devices.map((d) => [d.id, d.friendly_name]);
  const signature = JSON.stringify([S.scenarios, S.running, names]);
  if (signature === scenarioSignature) return;
  scenarioSignature = signature;
  const list = $('#scenario-list');
  if (!S.scenarios.length) {
    list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'No scenarios yet'),
      'Create one, or use "Create demo home" to get a few examples.'));
    return;
  }
  list.replaceChildren(...S.scenarios.map((sc) => {
    const running = sc.id in S.running;
    return h('div', { class: 'scenario' + (running ? ' running' : '') },
      h('header', {},
        h('div', {}, h('b', {}, sc.name), sc.loop && h('span', { class: 'badge' }, 'loops'), running && h('span', { class: 'badge' }, 'running')),
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
        return h('li', { class: (running && S.running[sc.id] === i ? 'now ' : '') + (d.missing ? 'missing' : '') }, d.text);
      })));
  }));
}

function defaultValue(prop, dev) {
  if (prop.kind === 'number') return dev.state[prop.name] ?? prop.min;
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
          draft.steps[i] = { type, seconds: 5, device: step.device || '', action: 'single', available: false };
          fixStep(draft.steps[i]);
          renderSteps();
        }));
      if (step.type === 'wait') {
        row.append(num(step, 'seconds', { min: 0 }), h('span', {}, 'seconds'));
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
      if (draft.steps.some((s) => s.type !== 'wait' && !byId(s.device))) throw new Error('Every step needs a device - choose one or remove the step.');
      const body = { name: name.value, loop: loop.checked, steps: draft.steps };
      return scenario ? api('PUT', `/api/scenarios/${scenario.id}`, body) : api('POST', '/api/scenarios', body);
    },
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
