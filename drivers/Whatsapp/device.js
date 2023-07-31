const Homey = require('homey');
const { BaileysClass } = require('@bot-wa/bot-wa-baileys');
const path = require('path');

const { sleep } = require('../../lib/helpers');

module.exports = class mainDevice extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to ${this.getName()}`);

            await this.checkCapabilities();
            await this.setWhatsappClient();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
        }
    }

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const deviceObject = this.getData();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = new BaileysClass({
                name: deviceObject.id,
                dir: `${path.resolve(__dirname, '../../userdata')}/`,
                plugin: false
            });

            this.listenToWhatsappEvents();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient - error =>`, error);
        }
    }

    async setContacts() {
        try {
            await sleep(2000);
            this.contactsList = this.WhatsappClient.store.contacts;

            console.log(this.contactsList)
            this.contactsList = Object.values(this.contactsList).filter((c) => !!c.name).map(c => ({ name: c.name, id: c.id }));

            this.homey.app.log(`[Device] ${this.getName()} - setContacts`);
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setContacts - error =>`, error);
        }
    }

    setContactsInterval() {
        this.setContacts();

        this.homey.setInterval(() => {
            this.setContacts();
        }, 30000);
    }

    listenToWhatsappEvents() {
        this.WhatsappClient.once('qr', (qr) => {
            this.homey.app.log(`[Device] ${this.getName()} - listenToWhatsappEvents - QR`);

            this.setUnavailable(`Repair device and Scan QR code to connect`);
        });

        this.WhatsappClient.once('ready', () => {
            this.homey.app.log(`[Device] ${this.getName()} - listenToWhatsappEvents - Ready`);

            this.setContactsInterval();
            this.setAvailable();
        });

        this.WhatsappClient.once('auth_failure', (error) => {
            this.homey.app.log(`[Device] ${this.getName()} - listenToWhatsappEvents - auth_failure`);

            this.setUnavailable(error);
        });
    }

    async onCapability_SendMessage(params, type) {
        try {
            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, { ...params, device: 'LOG' });

            const message = params.message.length ? params.message : '‎';
            const recipient = params.recipient && params.recipient.id;

            let fileUrl = params.droptoken || params.file || null;
            const fileType = type;

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - to: `, recipient);

            let data = null;

            if (recipient && message && !fileUrl) {
                this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage sendText`, { recipient, message, fileUrl, fileType });

                data = await this.WhatsappClient.sendText(recipient, message);
            } else if (recipient && fileUrl) {
                if (!!fileUrl && !!fileUrl.cloudUrl) {
                    fileUrl = fileUrl.cloudUrl;
                }

                this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage send${fileType}`, { recipient, message, fileUrl, fileType });

                if (fileType === 'video' || fileType === 'image') {
                    data = await this.WhatsappClient.sendMedia(recipient, fileUrl, message);
                } else if (fileType === 'audio') {
                    throw new Error('Audio is not supported yet');
                } else if (fileType === 'document') {
                    data = await this.WhatsappClient.sendFile(recipient, fileUrl);
                }
            }

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage data`, data);


            await this.coolDown();
            return !!data;
        } catch (error) {
            this.homey.app.log(error);

            return Promise.reject(error);
        }
    }

    async onCapability_setReceiveMessages(enabled) {
        await this.setSettings({ enable_receive_message: enabled });
        await this.checkCapabilities();
    }

    async coolDown() {
        return await sleep(1000);
    }

    // ------------- Capabilities -------------
    async checkCapabilities(overrideSettings = null) {
        const settings = overrideSettings ? overrideSettings : this.getSettings();
        const driverManifest = this.driver.manifest;
        let driverCapabilities = driverManifest.capabilities;

        const deviceCapabilities = this.getCapabilities();

        if (!settings.enable_receive_message) {
            driverCapabilities = driverCapabilities.filter((d) => d !== 'receive_message');
        }

        this.homey.app.log(`[Device] ${this.getName()} - Found capabilities =>`, deviceCapabilities);
        this.homey.app.log(`[Device] ${this.getName()} - Driver capabilities =>`, driverCapabilities);

        await this.updateCapabilities(driverCapabilities, deviceCapabilities);

        return true;
    }

    async updateCapabilities(driverCapabilities, deviceCapabilities) {
        try {
            const newC = driverCapabilities.filter((d) => !deviceCapabilities.includes(d));
            const oldC = deviceCapabilities.filter((d) => !driverCapabilities.includes(d));

            if (oldC.length) {
                this.homey.app.log(`[Device] ${this.getName()} - Got old capabilities =>`, oldC);

                oldC.forEach((c) => {
                    this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Remove `, c);
                    this.removeCapability(c);
                });

                await sleep(2000);
            }

            if (newC.length) {
                this.homey.app.log(`[Device] ${this.getName()} - Got new capabilities =>`, newC);

                newC.forEach((c) => {
                    this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Add `, c);
                    this.addCapability(c);
                });
                await sleep(2000);
            }
        } catch (error) {
            this.homey.app.log(error);
        }
    }
};
