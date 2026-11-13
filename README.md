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

Click **Create demo home** for 25 devices in 5 rooms plus example scenarios, or **+ Add device**
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

Every device also has an availability switch (simulates a device dropping off the network).

## Scenarios

The **Scenarios** tab holds scripted sequences. A step can

- wait some seconds,
- set a value (open a window, set 19 °C, switch a light at "the wall"),
- change a value gradually (temperature falls to 16 °C over 40 s),
- press a button,
- take a device offline / bring it back.

Scenarios can loop and several can run at once. They only play the *physical world*; reacting
to it (switching the heating off when a window opens ...) is the job of the automations you
are testing.

## MQTT behaviour

With the default base topic `zigbee2mqtt`:

| Topic | Content |
| --- | --- |
| `zigbee2mqtt/bridge/state` | `{"state":"online"}` (retained, `offline` as last will) |
| `zigbee2mqtt/bridge/info`, `bridge/devices`, `bridge/groups` | Bridge information and the device list including `exposes` (retained) |
| `zigbee2mqtt/bridge/event` | `device_joined`, `device_interview`, `device_leave` |
| `zigbee2mqtt/<name>` | Device state as JSON, e.g. `{"temperature":21.5,"humidity":48,"battery":100,"linkquality":120}` |
| `zigbee2mqtt/<name>/availability` | `{"state":"online"}` / `offline` (retained) |
| `zigbee2mqtt/<name>/set` | Commands. Light: `state`, `brightness`, `color_temp`, `color` (`x`/`y`, `hue`/`saturation`, `r`/`g`/`b`, `hex`). Plug: `state`. Thermostat: `occupied_heating_setpoint`, `system_mode`. Blind: `state` (`OPEN`/`CLOSE`/`STOP`), `position` |
| `zigbee2mqtt/<name>/get` | Makes the device publish its state |
| `zigbee2mqtt/<name>/action` | Button action as plain text (used by the HA device triggers) |
| `zigbee2mqtt/bridge/request/...` | Supported: `health_check`, `permit_join`, `restart`, `device/rename`, `device/remove` |
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
POST   /api/devices                {type: light|plug|thermostat|cover|sensor|motion|window|leak|smoke|button, friendly_name, room}
PATCH  /api/devices/:id            {state: {temperature: 19}, available, friendly_name, room, sim: {auto, interval}}
POST   /api/devices/:id/action     {action: "single"}
DELETE /api/devices/:id
POST   /api/scenarios/:id/run      /stop
```
