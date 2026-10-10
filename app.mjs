import Homey from 'homey';
import flowActions from './lib/flows/actions.mjs';
import flowConditions from './lib/flows/conditions.mjs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// libsignal logs whole SessionEntry objects through raw console.* — it never goes near
// Baileys' pino logger, so no logging configuration in this app reaches it
// (node_modules/libsignal/src/session_record.js). Each one is ~1.3-1.8KB of util.inspect
// output and they fire on every session open, close and eviction, which is continuous on an
// account with many correspondents. Keep the event, drop the payload.
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
        this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);
        this.log(`${this.homey.manifest.id} Running on Node.js version:`, process.version);

        // Deliberately after the lines above: an earlier version of this ran first and, had it
        // thrown, would have left no log at all to diagnose from.
        this.filterLibsignalNoise();

        await flowActions.init(this.homey);
        await flowConditions.init(this.homey);

        // Every crash report so far has been a snapshot taken after the fact, with no idea
        // what memory was doing beforehand — which is why "steady leak or spike on send?" has
        // stayed unanswerable. One line every five minutes makes the climb visible in the
        // next report, and logMemory() around a media send makes the cost of one send a number.
        this.logMemory('startup');
        this._memoryInterval = this.homey.setInterval(() => this.logMemory('periodic'), 5 * 60 * 1000);

        this.sendNotifications();
    }

    // Replace libsignal's object dumps with a one-line marker.
    //
    // Guarded throughout, because the first version of this was not: it did
    // console[level].bind(console) and then reassigned, which throws on a console with no
    // .info, with getter-only methods, or frozen — in a strict-mode ES module, which this is.
    // Homey's console is none of those, so it worked, but it ran ahead of every log line with
    // no try/catch, so a change to the console shim would have taken the app down silently.
    // Reducing log noise must never be able to stop the app from starting.
    filterLibsignalNoise() {
        try {
            if (globalThis.__whatsappConsoleFiltered) return;

            for (const level of ['info', 'warn', 'log']) {
                const original = console[level];
                if (typeof original !== 'function') continue;

                // A non-writable data property or an accessor with no setter cannot be replaced.
                const descriptor = Object.getOwnPropertyDescriptor(console, level);
                if (descriptor && descriptor.set === undefined && descriptor.writable !== true) continue;

                const passthrough = original.bind(console);
                const filtered = (...args) => {
                    if (typeof args[0] === 'string') {
                        const match = LIBSIGNAL_OBJECT_DUMPS.find((prefix) => args[0].startsWith(prefix));
                        if (match) return passthrough(`[libsignal] ${match}`);
                    }

                    return passthrough(...args);
                };

                console[level] = filtered;

                // A Proxy or an inherited accessor can swallow the assignment without throwing.
                if (console[level] !== filtered) {
                    this.log(`[libsignal] could not patch console.${level}, left as-is`);
                }
            }

            globalThis.__whatsappConsoleFiltered = true;
        } catch (error) {
            this.error('[libsignal] log filter not installed', error);
        }
    }

    // rss and arrayBuffers matter as much as heapUsed here: Buffers live outside the JS heap,
    // so an image being downloaded and encrypted shows up in arrayBuffers/external, not in
    // heapUsed. Never allowed to throw — this is diagnostics, not function.
    memorySnapshot() {
        try {
            const m = process.memoryUsage();
            const mb = (bytes) => Math.round(bytes / 1048576);

            return `rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ` +
                `ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB`;
        } catch (error) {
            return 'rss=?';
        }
    }

    logMemory(label) {
        try {
            this.log(`[memory] ${label} ${this.memorySnapshot()}`);
        } catch (error) {
            /* diagnostics only */
        }
    }

    async onUninit() {
        if (this._memoryInterval) {
            this.homey.clearInterval(this._memoryInterval);
            this._memoryInterval = null;
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
