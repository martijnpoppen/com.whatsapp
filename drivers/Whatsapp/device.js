const Homey = require('homey');

const { sleep, validateUrl } = require('../../lib/helpers');

module.exports = class mainDevice extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to ${this.getName()}`);

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setWhatsappClient();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
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

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const deviceObject = this.getData();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = this.driver.WhatsappClients[deviceObject.id]
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
        this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, { ...params, device: 'LOG' });

        const message = params.message && params.message.length ? params.message : '‎';
        const isGroup = validateUrl(params.recipient);
        const recipient = await this.getRecipient(params.recipient, isGroup);

        if(recipient && recipient !== params.recipient) {
            await this.isTyping(recipient);
            const data = await this.sendMessage(recipient, message, type, params);

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage data`, Object.keys(data).length);

            await this.coolDown();
            return Object.keys(data).length;
        }

        return false;
    }

    async getRecipient(recipient, isGroup) {
        if (!validateMobile(recipient) && !validateUrl(recipient)) {
            throw new Error('Invalid mobile number OR Invalid group invite link');
        } else if (recipient && validateMobile(recipient)) {
            recipient = recipient.replace('+', '');
            recipient = `${recipient}@s.whatsapp.net`;
        } else if (isGroup) {
            const groupJid = recipient.replace(' ', '').split('/').pop();
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID`, groupJid);

            recipient = await this.getStoreValue(groupJid) || null;
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from store: `, recipient);

            if (!recipient) {
                recipient = await this.WhatsappClient.getGroupWithInvite(groupJid) || null;
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

    async isTyping(recipient) {
        this.homey.app.log(`[Device] ${this.getName()} - isTyping`, recipient);
        await this.WhatsappClient.sendPresenceUpdate(recipient, 'composing');
        await sleep(2000);
        await this.WhatsappClient.sendPresenceUpdate(recipient, 'paused');
    }

    async sendMessage(recipient, message, msgType, params = null) {
        let data = {};

        if (recipient && message && !msgType) {
            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage sendText`, { recipient, message, msgType });

            data = await this.WhatsappClient.sendText(recipient, message);

            //   data = await this.WhatsappClient.sendText(recipient, message);

            //   data = await this.WhatsappClient.sendPoll(recipient, message, {
            //     options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'],
            //     multiselect: false
            // });
        } else if (recipient && msgType) {
            let fileUrl = params.droptoken || params.file || null;
            if (!!fileUrl && !!fileUrl.cloudUrl) {
                fileUrl = fileUrl.cloudUrl;
            }

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage send${msgType}`, { ...params, recipient, message, fileUrl, msgType, device: 'LOG' });

            if (msgType === 'video' || msgType === 'image') {
                data = await this.WhatsappClient.sendMedia(recipient, fileUrl, message);
            } else if (msgType === 'audio') {
                throw new Error('Audio is not supported yet');
            } else if (msgType === 'document') {
                data = await this.WhatsappClient.sendFile(recipient, fileUrl);
            } else if (msgType === 'location') {
                const {lat, lon} = params;
                data = await this.WhatsappClient.sendLocation(recipient, lat, lon, message);
            }
        }

        return data;
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
