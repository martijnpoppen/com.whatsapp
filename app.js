'use strict';

const Homey = require('homey');
const flowActions = require('./lib/flows/actions');
const notificationHelper = require('./lib/helpers/notification.helper');

class App extends Homey.App {
    log() {
        console.log.bind(this, '[log]').apply(this, arguments);
    }

    error() {
        console.error.bind(this, '[error]').apply(this, arguments);
    }

    // -------------------- INIT ----------------------

    async onInit() {
        this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);

        this.deviceList = [];

        this.setNotificationHelper();

        await flowActions.init(this.homey);
    }

    async setNotificationHelper() {
        const homeyId = await this.homey.cloud.getHomeyId();
        const id = Homey.env.WEBHOOK_ID;
        const secret = Homey.env.WEBHOOK_SECRET;
        const data = {
            deviceId: homeyId
        };

        const webhook = await this.homey.cloud.createWebhook(id, secret, data);

        this.notificationHelper = new notificationHelper(this.homey, webhook);
    }

    async setDevice(device) {
        this.deviceList = [...this.deviceList, device];

        await this.notificationHelper.setDevices(this.deviceList);
    }

    async setDevices(devices) {
        this.deviceList = [...this.deviceList, ...devices];
    }

    async removeDevice(id) {
        try {
            this.homey.app.log('removeDevice', id);

            const filteredList = this.deviceList.filter((dl) => {
                const data = dl.getData();
                return data.id !== id;
            });

            this.deviceList = filteredList;
        } catch (error) {
            this.error(error);
        }
    }
}

module.exports = App;