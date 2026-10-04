import Homey from 'homey';
import flowActions from './lib/flows/actions.mjs';
import flowConditions from './lib/flows/conditions.mjs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// libsignal logs whole SessionEntry objects through raw console.*, bypassing
// Baileys' pino logger entirely (node_modules/libsignal/src/session_record.js).
// Each one is ~1.3-1.8KB of util.inspect output and they fire on every session
// open, close and eviction — continuous on an account with many correspondents.
// Keep the event, drop the payload.
const LIBSIGNAL_OBJECT_DUMPS = [
    'Removing old closed session:',
    'Closing session:',
    'Opening session:',
    'Session already closed',
    'Session already open'
];

export default class App extends Homey.App {
    log() {
        console.log.bind(this, '[log]').apply(this, arguments);
    }

    error() {
        console.error.bind(this, '[error]').apply(this, arguments);
    }

    // -------------------- INIT ----------------------

    async onInit() {
        this.filterLibsignalNoise();

        this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);
        this.log(`${this.homey.manifest.id} Running on Node.js version:`, process.version);

        await flowActions.init(this.homey);
        await flowConditions.init(this.homey);

        this.sendNotifications();
    }

    // Replace libsignal's object dumps with a one-line marker. We keep the
    // message so session churn is still visible in a diagnostics report, and
    // drop the SessionEntry argument that makes it expensive.
    filterLibsignalNoise() {
        if (globalThis.__whatsappConsoleFiltered) return;
        globalThis.__whatsappConsoleFiltered = true;

        for (const level of ['info', 'warn', 'log']) {
            const passthrough = console[level].bind(console);

            console[level] = (...args) => {
                if (typeof args[0] === 'string') {
                    const match = LIBSIGNAL_OBJECT_DUMPS.find((prefix) => args[0].startsWith(prefix));
                    if (match) return passthrough(`[libsignal] ${match}`);
                }

                return passthrough(...args);
            };
        }
    }

    async sendNotifications() {
        try {
            // const ntfy2023100401 = `[Whatsapp] (1/2) - Good news. This app version doesn't require the cloud server anymore`;
            // const ntfy2023100402 = `[Whatsapp] (2/2) - The complete connection is now running natevely on your Homey.`;
            // await this.homey.notifications.createNotification({
            //     excerpt: ntfy2023100402
            // });
            // await this.homey.notifications.createNotification({
            //     excerpt: ntfy2023100401
            // });
        } catch (error) {
            this.log('sendNotifications - error', console.error());
        }
    }

    async getLocalImageAddress() {
        this.log(`getLocalImageAddress`);

        const host = await this.homey.cloud.getLocalAddress();
        const replaceHost = host.split(':')[0];
        const hypenedHost = replaceHost.replace(/\./g, '-');
        const address = `https://${hypenedHost}.homey.homeylocal.com/api/image/`;

        this.log(`getLocalImageAddress`, address);

        return address;
    }

    getDataPath() {
        const dataPath = path.resolve(__dirname, '/userdata/');

        this.homey.app.log(`getDataPath`, dataPath);

        return dataPath;
    }

    getDeviceById(deviceId) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        if (!driver) {
            this.error(`getDeviceById - Driver not found`);
            throw new Error('Driver not found');
        }

        const devices = driver.getDevices();
        if (!devices || devices.length === 0) {
            this.error(`getDeviceById - No devices found for driver`);
            throw new Error('No devices found for driver');
        }

        const device = devices.find((d) => d.getId() === deviceId);

        if (device) {
            return device;
        }

        return null;
    }
}
