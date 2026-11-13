// Tiny MQTT broker for trying the simulator without Mosquitto: `npm run broker`.
// Not meant for anything but local testing (no authentication, nothing persisted).

import net from 'node:net';
import Aedes from 'aedes';

const port = Number(process.env.BROKER_PORT) || 1883;
const aedes = new Aedes();
net.createServer(aedes.handle).listen(port, () => console.log(`Test MQTT broker listening on mqtt://localhost:${port}`));
