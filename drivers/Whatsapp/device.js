const Homey = require('homey');
const { parsePhoneNumber } = require('libphonenumber-js')

module.exports = class Whatsapp extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to WhatsApp`);

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setWhatsappClient();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
        }
    }

    async onAdded() {
        await this.syncTempDbToStore();

        if (this.driver.onReadyInterval) {
            this.homey.clearInterval(this.driver.onReadyInterval);
        }
    }

    async onDeleted() {
        await this.removeWhatsappClient();
    }

    async synchronousStart() {
        const driverData = this.driver;
        const driverDevices = driverData.getDevices();
        const deviceObject = this.getData();

        const sleepIndex = driverDevices.findIndex((device) => {
            const driverDeviceObject = device.getData();
            return deviceObject.id === driverDeviceObject.id;
        });

        await sleep(sleepIndex * 7500);

        this.homey.app.log('[Device] - init - after sleep =>', sleepIndex, this.getName());
    }

    async syncTempDbToStore() {
        const deviceObject = this.getData();
        const clientId = deviceObject.id.split('_')[1];
        if (this.driver.tempDB[clientId]) {
            this.homey.app.log(`[Device] - ${this.getName()} => syncTempDbToStore - found tempDB - syncing with store`);
            for (let i = 0; i < Object.keys(this.driver.tempDB[clientId]).length; i++) {
                const key = Object.keys(this.driver.tempDB[clientId])[i];
                const value = this.driver.tempDB[clientId][key];

                await this.setStoreValue(key, value);
            }

            this.driver.tempDB = {};
            this.homey.app.log(`[Device] - ${this.getName()} => syncTempDbToStore - tempDB cleared`, this.driver.tempDB);
        }
    }

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const deviceObject = this.getData();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = this.driver.WhatsappClients[deviceObject.id];

            const result = await this.WhatsappClient.startup();

            if(result) {
                this.setAvailable();
            } else {
                this.setUnavailable('Oops something went wrong. Please try to repair the device.');
            }
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient - error =>`, error);
        }
    }

    async removeWhatsappClient() {
        if (this.driver.WhatsappClients[deviceObject.id]) {
            this.driver.WhatsappClients[deviceObject.id].removeAllListeners();
            this.driver.WhatsappClients[deviceObject.id] = null;
            this.WhatsappClient = null;
        }
    }

    async onCapability_SendMessage(params, type) {
        this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`);

        const message = params.message && params.message.length ? params.message : '‎';
        const isGroup = validateUrl(params.recipient);
        const recipient = await this.getRecipient(params.recipient, isGroup);

        if (recipient && recipient !== params.recipient) {
            const data = await this.sendMessage(recipient, message, type, params);

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, Object.keys(data).length);

            return !!Object.keys(data).length;
        }

        return false;
    }

    async getRecipient(recipient, isGroup) {
        if (!isGroup) {
            const phoneNumber = parsePhoneNumber(recipient);
            if(!phoneNumber.isValid()) {
                throw new Error('Invalid mobile number (Make sure to include the country code (e.g. +31))');
            }

            recipient = phoneNumber.number;
            recipient = recipient.replace('+', '');
            recipient = recipient.replace(' ', '');
            recipient = `${recipient}@s.whatsapp.net`;
        } else if (isGroup) {
            recipient = recipient.replace(' ', '');
            recipient = recipient.replace(' ', '');
            recipient = recipient.replace(' ', '');

            const groupJid = recipient.replace(' ', '').split('/').pop();
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID`, groupJid);

            recipient = (await this.getStoreValue(groupJid)) || null;
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from store: `, recipient);

            if (!recipient) {
                recipient = (await this.WhatsappClient.getGroupWithInvite(groupJid)) || null;
                this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from WhatsappClient`, recipient);

                if (recipient) {
                    recipient = recipient.id;

                    await this.setStoreValue(groupJid, recipient);
                    this.homey.app.log(`[Device] ${this.getName()} - getRecipient - saved group JID to Store`, recipient);
                } else {
                    throw new Error('Could not get group ID. Is the group link correct?');
                }
            }
        }

        return recipient;
    }

    async sendMessage(recipient, message, msgType, params = null) {
        let data = {};

        if (recipient && message && !msgType) {
            this.homey.app.log(`[Device] ${this.getName()} - sendMessage - sendText`, { recipient, message, msgType });

            data = await this.WhatsappClient.sendText(recipient, message);
        } else if (recipient && msgType) {
            let fileUrl = params.droptoken || params.file || null;
            if (!!fileUrl && !!fileUrl.localUrl) {
                fileUrl = fileUrl.localUrl;
            }

            this.homey.app.log(`[Device] ${this.getName()} - sendMessage - send${msgType}`, { ...params, recipient, message, fileUrl, msgType, device: 'LOG' });

            if (msgType === 'video' || msgType === 'image') {
                data = await this.WhatsappClient.sendMedia(recipient, fileUrl, message, msgType);
            } else if (msgType === 'audio') {
                throw new Error('Audio is not supported yet');
            } else if (msgType === 'document') {
                data = await this.WhatsappClient.sendFile(recipient, fileUrl);
            } else if (msgType === 'location') {
                const { lat } = params;

                const splittedParam = lat.split(',');

                if (splittedParam.length > 1) {
                    data = await this.WhatsappClient.sendLocation(recipient, splittedParam[0], splittedParam[1], message);
                } else {
                    throw new Error('Invalid location, use comma separated Latitude,Longitude');
                }
            }
        }

        return data || true;
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
