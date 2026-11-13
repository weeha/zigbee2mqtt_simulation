# Zigbee2MQTT Simulator

Simulates a Zigbee2MQTT instance on your MQTT broker - without a coordinator stick and
without real devices. A web UI lets you add virtual devices, change their values and replay
scripted smart home scenarios. Home Assistant picks the devices up through MQTT discovery,
exactly as it does with the real Zigbee2MQTT.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:8099>. The simulator connects to `mqtt://localhost:1883` by default;
click the connection pill in the top right corner to change broker URL, credentials or topics.

No broker at hand? `npm run broker` starts a throw-away one on port 1883.

Click **Create demo home** for 33 devices in 6 rooms plus example scenarios, or **+ Add device**
to build your own home.

## Devices

| Type | Simulated model | What you can do in the UI |
| --- | --- | --- |
| Temperature & humidity sensor | SONOFF SNZB-02 | Set temperature / humidity / battery, optional "auto drift" with a report interval |
| Color light | Philips Hue white and color ambiance (9290022166) | On/off, brightness, color temperature, color - and it follows commands from MQTT / Home Assistant |
| Window sensor | Aqara MCCGQ11LM | Open / close, battery |
| Button | Aqara WXKG11LM | Fire `single`, `double`, `triple`, `quadruple`, `hold`, `release` |
| Motion sensor | Aqara RTCGQ11LM | Trigger motion (clears again after a timeout), illuminance, battery |
| Smart plug | Tuya TS011F_plug_1 | On/off - also over MQTT - and the connected load; reports power, current, voltage and a growing energy counter |
| Radiator thermostat | SONOFF TRVZB | Room temperature, setpoint, mode; shows heating / idle. "Simulate room" lets the room warm up while heating and cool down otherwise |
| Roller blind | IKEA FYRTUR (E1757) | Open / stop / close and target position; the blind moves at 10 % per second |
| Water leak sensor | Aqara SJCGQ11LM | Leak / dry, battery |
| Smoke detector | Aqara JTYJ-GD-01LM/BW | Smoke / clear, battery |
| Radiator thermostat with valve position | Bosch BTH-RA | Like the thermostat, plus a valve position (0-100 %, in proportion to how far the room is below the setpoint) and a window open mode that pauses heating. It switches to that mode by itself when the temperature drops by 1.5 °C within 30 s |
| Air quality sensor | Tuya TS0601_air_quality_sensor | CO₂, VOC, temperature, humidity |
| Presence sensor (mmWave) | Aqara FP1 (RTCZCGQ11LM) | Somebody is here / nobody - stays on until you clear it |
| Door lock | Yale YRD226HA2619 | Lock / unlock - also over MQTT |
| Siren | Neo NAS-AB02B2 | Alarm on / off, volume, duration; stops by itself after the duration - also over MQTT |
| Dial remote | Philips Hue Tap dial (8719514440937) | Four buttons (press, hold, release) and a dial that turns left / right in steps, slowly or fast |

Every device also has an availability switch (simulates a device dropping off the network).

### Firmware updates (OTA)

Every card has a firmware line. **Offer update** makes a newer firmware available: the device
reports it in its state (`update.state` = `available`) and Home Assistant shows it on the
device's update entity. Installing it - from Home Assistant, with **Install** on the card or
with `bridge/request/device/ota_update/update` - takes 30 seconds, during which the device
reports `updating` with a progress, and ends with the new version installed.

## Import and export

**Export** downloads the home as one JSON file: devices with their current values and
addresses, rooms, the sun and weather settings and all scenarios. The MQTT connection is
not part of it, so the file contains no broker address or password and can be shared or
kept in a repository. Scenarios refer to devices by name, which keeps the file readable.

**Import** loads such a file and asks how:

- *Add to the current home* skips devices and scenarios whose name already exists.
- *Replace the current home* removes all devices and scenarios first.

Imported devices keep their IEEE address, so Home Assistant recognises them as the same
devices as before.

## Simulated clock, sun and weather

The bar below the header is the simulated time of day. Press play and choose how fast it
runs - from real time up to one hour per second, so a whole day passes in 24 seconds - or
drag the slider to any time. It starts paused at the real time.

From the time the simulator derives the daylight (0 % at night, 100 % at solar noon) and an
outdoor temperature that is coldest at sunrise and warmest in mid-afternoon. Sunrise, sunset
and the temperature range are set under **Sun & weather**. Two kinds of devices can follow it:

- a motion sensor with **Follows the sun**: its illuminance rises and falls with the daylight,
  up to the lx value you give it;
- a temperature sensor with **Outdoor sensor**: it reports the outdoor temperature and humidity.

Home Assistant's own clock and sun cannot be moved, so the simulator publishes its own as
entities of the simulated bridge: *Simulated time*, *Simulated sun* (on while the sun is up),
*Simulated daylight* and *Simulated outdoor temperature*. Use these as triggers in the
automations you want to test instead of `sun.sun` or a time trigger.

Only the environment follows the clock. Devices keep working in real seconds (a blind still
takes 10 s, motion still clears after its timeout), and so do delays inside Home Assistant.

## Room physics

Tick **Room physics** in a room's heading and the devices of that room start to affect each
other. The room then has a temperature and a humidity of its own, shown in the heading:

| What happens | Effect on the room |
| --- | --- |
| A window is open | Temperature and humidity move towards the outdoor values of the simulated weather - about a third of the way in 20 s |
| A thermostat is heating | The room warms up by 0.05 °C per second; one with a valve position heats in proportion to it |
| Somebody is in the room | CO₂ rises by 3 ppm per second for every presence or motion sensor that sees somebody; an open window airs it out towards 420 ppm. An air quality sensor reports it |
| Everything is closed | A room with a thermostat slowly loses heat to the outside, humidity settles at 50 % |
| A blind closes | Less daylight: the illuminance scales with how far the blinds are open |
| A lamp is on | Up to 150 lx more, depending on its brightness |

Temperature sensors and thermostats in the room report the room temperature, motion sensors
the resulting illuminance. So opening a window really makes the thermostat start heating,
and switching a lamp on is visible to a motion sensor - without scripting it in a scenario.

- Setting a sensor's temperature or humidity by hand (or in a scenario) sets the room; the
  physics carries on from there.
- A sensor marked as outdoor sensor is not part of its room.
- A thermostat's own "Simulate room" option is not used in such a room.
- A room without a thermostat keeps its temperature while its windows are closed.
- The rates are chosen so that you can watch things happen, not to be realistic, and they
  run in real seconds whatever the speed of the simulated clock.

"Create demo home" switches room physics on for its indoor rooms.

## Scenarios

The **Scenarios** tab holds scripted sequences. A step can

- wait some seconds,
- set a value (open a window, set 19 °C, switch a light at "the wall"),
- change a value gradually (temperature falls to 16 °C over 40 s),
- press a button,
- take a device offline / bring it back,
- set the simulated clock, or wait until it reaches a time of day ("A day in the life" in the
  demo home plays 17 hours in under two minutes this way),
- expect a value (see below).

Scenarios can loop and several can run at once. They only play the *physical world*; reacting
to it (switching the heating off when a window opens ...) is the job of the automations you
are testing.

### Testing automations

An **Expect** step turns a scenario into a test. It waits until a device reports the expected
value and fails if that does not happen in time:

```text
1. Bedroom Window: contact → open
2. Expect Bedroom Thermostat: setpoint ≤ 12 °C within 20 s
3. Bedroom Window: contact → closed
4. Expect Bedroom Thermostat: setpoint ≥ 20 °C within 20 s
```

- Numbers can be compared with `is`, `is not`, `<`, `≤`, `>`, `≥`; everything else with `is` / `is not`.
  A light's color matches approximately.
- Besides the values you can set, a test can check what a device reports on its own: a plug's
  power and energy, a thermostat's running state, a blind's open / closed state.
- A failed step does not end the scenario, so the steps after it can still tidy up. The
  scenario is marked **passed** or **failed**, with the reason next to the failed step.
- **Run all tests** runs every scenario with an Expect step, one after the other. Looping
  scenarios are skipped.

The same from the command line, against a running simulator - the exit code is 1 if a test fails:

```bash
npm run scenarios                         # http://localhost:8099
npm run scenarios -- http://host:8099     # or SIM_URL=...
```

Results are kept until the simulator restarts or the scenario is edited.

## MQTT behaviour

With the default base topic `zigbee2mqtt`:

| Topic | Content |
| --- | --- |
| `zigbee2mqtt/bridge/state` | `{"state":"online"}` (retained, `offline` as last will) |
| `zigbee2mqtt/bridge/info`, `bridge/devices`, `bridge/groups` | Bridge information and the device list including `exposes` (retained) |
| `zigbee2mqtt/bridge/simulation` | Simulated clock, e.g. `{"time":"18:54","daylight":35,"sun":"above_horizon","outdoor_temperature":19.9,"outdoor_humidity":52,"speed":600,"running":true}` (retained; not part of the real Zigbee2MQTT) |
| `zigbee2mqtt/bridge/event` | `device_joined`, `device_interview`, `device_leave` |
| `zigbee2mqtt/<name>` | Device state as JSON, e.g. `{"temperature":21.5,"humidity":48,"battery":100,"linkquality":120}` |
| `zigbee2mqtt/<name>/availability` | `{"state":"online"}` / `offline` (retained) |
| `zigbee2mqtt/<name>/set` | Commands. Light: `state`, `brightness`, `color_temp`, `color` (`x`/`y`, `hue`/`saturation`, `r`/`g`/`b`, `hex`). Plug: `state`. Thermostat: `occupied_heating_setpoint`, `system_mode`. Blind: `state` (`OPEN`/`CLOSE`/`STOP`), `position`. Thermostat with valve: also `window_detection` (`ON`/`OFF`). Lock: `state` (`LOCK`/`UNLOCK`). Siren: `alarm` (`true`/`false`), `volume`, `duration`, `melody` |
| `zigbee2mqtt/<name>/get` | Makes the device publish its state |
| `zigbee2mqtt/<name>/action` | Button action as plain text (used by the HA device triggers) |
| `zigbee2mqtt/bridge/request/...` | Supported: `health_check`, `permit_join`, `restart`, `device/rename`, `device/remove`, `device/ota_update/check`, `device/ota_update/update` |
| `homeassistant/.../config` | MQTT discovery for every entity (retained) |

When `homeassistant/status` reports `online`, all states are published again.
Removing a device clears its retained messages, so it disappears from Home Assistant too.

> Do not run the simulator with the same base topic as a real Zigbee2MQTT on the same broker.

## Configuration

Settings from the UI are stored in `data/store.json` together with devices and scenarios.
Environment variables provide the initial values:

| Variable | Default |
| --- | --- |
| `MQTT_URL` | `mqtt://localhost:1883` |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | - |
| `BASE_TOPIC` | `zigbee2mqtt` |
| `DISCOVERY_PREFIX` | `homeassistant` |
| `PORT` | `8099` |
| `HOST` | `127.0.0.1` (use `0.0.0.0` to reach the UI from other machines - it has no login) |
| `DATA_DIR` | `./data` |

## REST API

The UI uses a small JSON API which is handy for automated tests as well:

```text
GET    /api/state
POST   /api/devices                {type: light|plug|thermostat|trv|cover|sensor|air|motion|presence|window|leak|smoke|lock|siren|button|dial, friendly_name, room}
PATCH  /api/devices/:id            {state: {temperature: 19}, available, friendly_name, room, sim: {auto, interval, outdoor, sun, peak}}
PUT    /api/rooms                  {name, physics: true|false, temperature, humidity}
PUT    /api/clock                  {time: "07:30"|"now", speed: 1|60|300|600|1800|3600, running, sunrise, sunset, temp_min, temp_max}
POST   /api/devices/:id/action     {action: "single"}
POST   /api/devices/:id/firmware   {action: offer|install|withdraw}
GET    /api/export                 the home as JSON
POST   /api/import                 {home: <exported JSON>, mode: merge|replace}
DELETE /api/devices/:id
POST   /api/scenarios/:id/run      /stop
POST   /api/scenarios/:id/run?wait=1   answers when the scenario has finished: {status: passed|failed|stopped|done, checks, failures}
POST   /api/tests/run              runs all test scenarios and answers {ok, passed, failed, results}
```

An expect step looks like `{type: "expect", device, property, op: eq|ne|lt|le|gt|ge, value, seconds}`,
the clock steps like `{type: "clock", time: "06:00", speed: 600}` (speed 0 keeps the current one) and `{type: "until", time: "07:30"}`.
