'use strict';

import Homey from 'homey';
import flowActions from './lib/flows/actions.mjs';

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

    async getWidgetChatInstance(widgetId) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        const device = devices.find(device => device.getStoreValue(`widget-instance-${widgetId}`));

        if(device) {
            const storeValue = device.getStoreValue(`widget-instance-${widgetId}`);
            device.cleanupWidgetInstanceDuplicates(`widget-instance-${widgetId}`, storeValue)

            return storeValue
        }

        return null;
    }

    async setWidgetChatInstance(widgetId, jid) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        
        devices.forEach(device => {
            device.setStoreValue(`widget-instance-${widgetId}`, jid);
        });
    }

    async getWidgetChats(jid) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        const device = devices.find(device => device.getStoreValue(`widget-chat-${jid}`));

        return device ? device.getStoreValue(`widget-chat-${jid}`) : null;
    }
}
