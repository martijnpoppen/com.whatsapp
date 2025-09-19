import Homey from 'homey';
import flowActions from './lib/flows/actions.mjs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class App extends Homey.App {
    log() {
        console.log.bind(this, '[log]').apply(this, arguments);
    }

    error() {
        console.error.bind(this, '[error]').apply(this, arguments);
    }

    // -------------------- INIT ----------------------

    async onInit() {
        this.widgetInstances = [];
        this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);
        this.log(`${this.homey.manifest.id} Running on Node.js version:`, process.version);

        await flowActions.init(this.homey);

        this.sendNotifications();
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
