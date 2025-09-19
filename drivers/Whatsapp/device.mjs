import Homey from 'homey';
import { parsePhoneNumber } from 'libphonenumber-js';
import { validateUrl, sleep, getBase64Image, toConsistentId } from '../../lib/helpers/index.mjs';

export default class Whatsapp extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to WhatsApp`);

            this.cleanupWidgetStore();
            this.widgetInstanceHeartbeats();

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setTriggers();
            await this.setConditions();
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

    async setTriggers() {
        this.new_message = this.homey.flow.getDeviceTriggerCard('new_message');
        this.new_image = this.homey.flow.getDeviceTriggerCard('new_image');
        this.new_pairing_code = this.homey.flow.getDeviceTriggerCard('new_pairing_code');
    }

    async setConditions() {
        const text_condition = this.homey.flow.getConditionCard('text_condition');
        text_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [text_condition]`, { ...args, device: 'LOG' });

            const result = state.text && state.text.toLowerCase() === args.text_input.toLowerCase();

            this.homey.app.log(`[Device] ${this.getName()} - [text_condition] - result: `, result);
            return result;
        });

        const text_contains_condition = this.homey.flow.getConditionCard('text_contains_condition');
        text_contains_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [text_contains_condition]`, { ...args, device: 'LOG' });

            const result = state.text && state.text.toLowerCase().includes(args.text_input.toLowerCase());

            this.homey.app.log(`[Device] ${this.getName()} - [text_contains_condition] - result: `, result);
            return result;
        });

        const from_condition = this.homey.flow.getConditionCard('from_condition');
        from_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [from_condition]`, { ...args, device: 'LOG' });
            const result = state.from && state.from.toLowerCase() === args.from_input.toLowerCase();

            this.homey.app.log(`[Device] ${this.getName()} - [from_condition] - result: `, result);
            return result;
        });

        const from_number_condition = this.homey.flow.getConditionCard('from_number_condition');
        from_number_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [from_number_condition]`, { ...args, device: 'LOG' });
            const result = state.fromNumber && state.fromNumber.toLowerCase() === args.from_input.toLowerCase();

            this.homey.app.log(`[Device] ${this.getName()} - [from_number_condition] - result: `, result);
            return result;
        });

        const group_condition = this.homey.flow.getConditionCard('group_condition');
        group_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [group_condition]`, { ...args, device: 'LOG' });
            const result = state.group === true;

            this.homey.app.log(`[Device] ${this.getName()} - [group_condition] - result: `, result);
            return result;
        });

        const group_code_condition = this.homey.flow.getConditionCard('group_code_condition');
        group_code_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [group_code_condition]`, { ...args, device: 'LOG' });
            const parsedInput = this.parseGroupInvite(args.group_code_input);
            this.homey.app.log(`[Device] ${this.getName()} - [group_code_condition] - parsedInput: `, parsedInput);
            this.homey.app.log(`[Device] ${this.getName()} - [group_code_condition] - state.groupCode: `, state.groupCode);
            const result = state.groupCode === parsedInput;

            this.homey.app.log(`[Device] ${this.getName()} - [group_code_condition] - result: `, result);
            return result;
        });

        const image_condition = this.homey.flow.getConditionCard('image_condition');
        image_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [image_condition]`, { ...args, device: 'LOG' });
            const result = state.hasImage === true;

            this.homey.app.log(`[Device] ${this.getName()} - [image_condition] - result: `, result);
            return result;
        });
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
            const settings = await this.getSettings();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = this.driver.WhatsappClients[deviceObject.id];

            const result = await this.WhatsappClient.startup();

            if (result) {
                this.setAvailable();
            } else {
                await this.new_pairing_code.trigger(this);
                await this.setUnavailable('New pairing code is needed. Please try to repair the device.');
                await this.homey.notifications.createNotification({ excerpt: `[WhatsApp] - (${settings.phonenumber}) - New pairing code is needed. Please try to repair the device.` });
            }
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient - error =>`, error);
        }
    }

    async removeWhatsappClient() {
        if (this.WhatsappClient) {
            this.WhatsappClient.deleteDevice();
            this.WhatsappClient = null;
        }
    }

    async onCapability_SendMessage(params, type) {
        this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`);

        const message = params.message && params.message.length ? params.message : '‎';

        const isGroup = validateUrl(params.recipient);
        const recipient = await this.getRecipient(params.recipient, isGroup);

        if (recipient) {
            const data = await this.sendMessage(recipient, message, type, params, isGroup, params.recipient);

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, Object.keys(data).length);

            return !!Object.keys(data).length;
        }

        return false;
    }

    async getRecipient(recipient, isGroup) {
        if (recipient.includes('@g.us') || recipient.includes('@s.whatsapp.net') || recipient.includes('@newsletter')) {
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - already a JID`, recipient);
            return recipient;
        }

        if (!isGroup) {
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - not a group`, recipient);
            const phoneNumber = parsePhoneNumber(recipient);
            if (!phoneNumber.isValid()) {
                throw new Error('Invalid mobile number (Make sure to include the country code (e.g. +31))');
            }

            recipient = phoneNumber.number;
            recipient = recipient.replace('+', '');
            recipient = recipient.replace(' ', '');
            recipient = `${recipient}@s.whatsapp.net`;
        } else if (isGroup) {
            const inviteCode = this.parseGroupInvite(recipient);
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID`, inviteCode);

            recipient = (await this.getStoreValue(inviteCode)) || null;
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from store: `, recipient);

            if (!recipient) {
                recipient = (await this.WhatsappClient.getGroupWithInvite(inviteCode)) || null;
                this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from WhatsappClient`, recipient);

                if (recipient) {
                    recipient = recipient.id;

                    await this.setStoreValue(inviteCode, recipient);
                    this.homey.app.log(`[Device] ${this.getName()} - getRecipient - saved group JID to Store`, recipient);
                } else {
                    throw new Error('Could not get group ID. Is the group link correct?');
                }
            }
        }

        this.homey.app.log(`[Device] ${this.getName()} - getRecipient - final JID`, recipient);

        return recipient;
    }

    async sendMessage(recipient, message, msgType, params = null, isGroup = false, originalRecipient = null) {
        let data = {};
        const options = await this.getOptions(message);

        if (recipient && message && !msgType) {
            this.homey.app.log(`[Device] ${this.getName()} - sendMessage - sendText`, { recipient, message, msgType });

            this.sendToWidget({
                jid: recipient,
                originalRecipient,
                from: '',
                fromMe: true,
                timeStamp: Date.now(),
                text: message,
                group: isGroup,
                hasImage: false,
                imageUrl: null,
                base64Image: null
            });

            data = await this.WhatsappClient.sendText(recipient, message, options);
        } else if (recipient && msgType) {
            let fileUrl = params.droptoken || params.file || null;

            // if (!!fileUrl && !!fileUrl.localUrl && fileUrl.localUrl.length) {
            //     fileUrl = fileUrl.localUrl;
            // } else
            if (!!fileUrl && !!fileUrl.cloudUrl && fileUrl.cloudUrl.length) {
                fileUrl = fileUrl.cloudUrl;
            } else if (fileUrl && !!fileUrl.id && fileUrl.id.length) {
                fileUrl = `${await this.homey.app.getLocalImageAddress()}${fileUrl.id}`;
            }

            this.sendToWidget({
                jid: recipient,
                originalRecipient: originalRecipient,
                from: '',
                fromMe: true,
                timeStamp: Date.now(),
                text: message,
                group: isGroup,
                hasImage: msgType === 'image',
                imageUrl: fileUrl,
                base64Image: null
            });

            this.homey.app.log(`[Device] ${this.getName()} - sendMessage - send${msgType}`, { ...params, recipient, message, fileUrl, msgType, device: 'LOG' });

            if (msgType === 'video' || msgType === 'image') {
                data = await this.WhatsappClient.sendMedia(recipient, fileUrl, message, msgType, options);
            } else if (msgType === 'audio') {
                throw new Error('Audio is not supported yet');
            } else if (msgType === 'document') {
                data = await this.WhatsappClient.sendFile(recipient, fileUrl, options);
            } else if (msgType === 'location') {
                const { lat } = params;

                const splittedParam = lat.split(',');

                if (splittedParam.length > 1) {
                    (data = await this.WhatsappClient.sendLocation(recipient, splittedParam[0], splittedParam[1], message)), options;
                } else {
                    throw new Error('Invalid location, use comma separated Latitude,Longitude');
                }
            } else if (msgType === 'poll') {
                let values = [];
                const { option1, option2, option3, option4, option5, option6, option7, option8, selectableCount } = params;
                if (option1) values.push(option1);
                if (option2) values.push(option2);
                if (option3) values.push(option3);
                if (option4) values.push(option4);
                if (option5) values.push(option5);
                if (option6) values.push(option6);
                if (option7) values.push(option7);
                if (option8) values.push(option8);

                if (values.length < 2) {
                    throw new Error('Please provide at least 2 poll values');
                }

                data = await this.WhatsappClient.sendPoll(recipient, message, values, selectableCount || 1);
            }
        }

        return data || true;
    }

    async getOptions(message) {
        try {
            this.homey.app.log(`[Device] ${this.getName()} - getOptions`, { message });
            const regex = /@(\S+)/g;
            const matches = [...message.matchAll(regex)];
            const mentions = [];

            for (const match of matches) {
                if (/^\d+$/.test(match[1])) {
                    // check if only numbers

                    this.homey.app.log(`[Device] ${this.getName()} - getOptions - found mention`, match[1]);

                    const pn = await this.WhatsappClient.getPNForLID(`${match[1]}@lid`);
                    const parsedPn = pn ? this.getParsedPhoneNumber(pn) : undefined;
                    const phoneNumber = parsedPn ? parsePhoneNumber(parsedPn) : parsePhoneNumber(`+${match[1]}`);

                    if (phoneNumber.isValid() && parsedPn) {
                        mentions.push(`${match[1]}@lid`);
                    } else if (phoneNumber.isValid()) {
                        mentions.push(`${match[1]}@s.whatsapp.net`);
                    }
                }
            }

            this.homey.app.log(`[Device] ${this.getName()} - getOptions`, { mentions });

            return { mentions };
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - getOptions`, error);
            return {};
        }
    }

    getParsedPhoneNumber(pn) {
        if (pn && pn.includes(':')) {
            return `+${pn.split(':')[0]}`;
        } else if (pn && pn.includes('@')) {
            return `+${pn.split('@')[0]}`;
        } else {
            return `+${pn}`;
        }
    }

    parseGroupInvite(inviteLink) {
        let inviteCode = inviteLink.replace(/\s+/g, '');
        inviteCode = inviteCode.split('/').pop();
        inviteCode = inviteCode.includes('?') ? inviteCode.split('?')[0] : inviteCode;

        return inviteCode;
    }

    async coolDown() {
        return await sleep(1000);
    }

    // ------------- Triggers -------------
    async messageHelper(msg) {
        try {
            const settings = await this.getSettings();

            msg.messages.forEach(async (m) => {
                console.log(m);

                let newDate = new Date();
                newDate.setTime(m.messageTimestamp * 1000);
                let dateString = newDate.toUTCString();

                const jid = m.key && m.key.remoteJid;
                const group = m.key && m.key.participant ? true : false;
                const groupCode = group && (await this.WhatsappClient.getGroupInviteById(jid));

                const from = m.pushName;

                const fromJid = m.key.participant || jid;
                const pn = await this.WhatsappClient.getPNForLID(fromJid);
                const fromNumber = (pn && this.getParsedPhoneNumber(pn)) || `+${fromJid.split('@')[0]}`;

                const fromMe = m.key && m.key.fromMe;
                const triggerAllowed = (fromMe && settings.trigger_own_message) || !fromMe;
                const hasImage = m.message && m.message.imageMessage ? true : false;
                const isPollUpdate = m.message && m.message.pollUpdateMessage ? true : false;

                if (isPollUpdate) {
                    console.log('Ignoring poll update message', m.message.pollUpdateMessage);
                    return false;
                }

                let text = m.message && m.message.conversation;

                if (!text) {
                    text = (m.message && m.message.extendedTextMessage && m.message.extendedTextMessage.text) || '';
                }

                if (hasImage) {
                    text = (m.message && m.message.imageMessage && m.message.imageMessage.caption) || '';
                }

                const tokens = { replyTo: jid, fromNumber, groupCode, from: from ? from : '', text, time: dateString, group, hasImage };
                const state = tokens;

                console.log('tokens', tokens);

                triggerAllowed && this.new_message.trigger(this, tokens, state);

                this.sendToWidget({ jid, from: from, fromMe, timeStamp: m.messageTimestamp * 1000, text, group, hasImage, imgUrl: null, base64Image: null, m, originalRecipient: `https://chat.whatsapp.com/${groupCode}` || fromNumber });
            });

            return true;
        } catch (error) {
            console.log('Error in message', error);
        }
    }

    // ------------- Capabilities -------------
    async checkCapabilities() {
        const driverManifest = this.driver.manifest;
        let driverCapabilities = driverManifest.capabilities;

        const deviceCapabilities = this.getCapabilities();

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

    // Widgets
    async sendToWidget(data) {
        const doesWidgetExist = await this.getWidgetInstance(data.originalRecipient, false, true);
        if (!doesWidgetExist) {
            this.homey.app.log(`[Device] ${this.getName()} - sendToWidget - no widget instance for originalRecipient`, data.originalRecipient);
            return false;
        }
        // When image is sent from Homey
        if (data.imageUrl) {
            const base64Image = await getBase64Image(data.imageUrl);
            data.base64Image = `data:image/jpeg;base64,${base64Image}`;
        }

        // When image is received from Whatsapp
        if (data.m && data.hasImage) {
            const imageBuffer = await this.WhatsappClient.downloadMediaMsg(data.m);
            const base64Image = imageBuffer ? imageBuffer.toString('base64') : null;
            data.base64Image = base64Image ? `data:image/jpeg;base64,${base64Image}` : null;
        }

        const { text, from, fromMe, timeStamp, hasImage, base64Image } = data;
        const saveData = {
            text,
            from,
            ...(fromMe && { fromMe }),
            timeStamp,
            ...(hasImage && { hasImage }),
            ...(base64Image && { base64Image }),
            deviceId: this.getId()
        };

        this.homey.api.realtime(`${this.getId()}-chat`, saveData);
        this.setWidgetInstance(null, data.originalRecipient, saveData);
    }

    async cleanupWidgetStore() {
        this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore`);

        const storeData = await this.getStore();
        const clientId = this.getData().id;

        const latestPreKeyId = Math.max(...Object.keys(storeData).map((k) => (k.match(/pre-key-(\d+)/) ? parseInt(k.split('-').pop(), 10) : 0)));

        for await (const storeKey of Object.keys(storeData)) {
            if (storeKey.startsWith(`${clientId}:pre-key-`)) {
                const num = parseInt(storeKey.split('-').pop(), 10);
                if (num < latestPreKeyId - 50) {
                    this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore - removing old pre-key`, storeKey);
                    await this.unsetStoreValue(storeKey);
                }
            }

            if (storeKey.startsWith('widget-chat-')) {
                this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore - removing key: ${storeKey}`);
                await this.unsetStoreValue(storeKey);
            }

            if (storeKey.startsWith('widget-instance-')) {
                this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore - removing key`, storeKey);
                await this.unsetStoreValue(storeKey);
            }
        }
    }

    async getWidgetInstance(dataId, getData = true, convertJid = false) {
        this.homey.app.log(`[Device] ${this.getName()} - getWidgetInstance`, dataId);

        const storeKey = `widgetInstance-${toConsistentId(dataId)}`;
        const instance = await this.getStoreValue(storeKey);

        this.homey.app.log(`[Device] ${this.getName()} - getWidgetInstance instance exists:`, !!instance);

        if (getData) {
            return instance?.data || null;
        }

        return !!instance;
    }

    async setWidgetInstance(widgetId, dataId, dataOverride = null) {
        try {
            this.homey.app.log(`[Device] ${this.getName()} - setWidgetInstance`, widgetId, dataId, dataOverride);

            const storeKey = `widgetInstance-${toConsistentId(dataId)}`;

            // there can be multiple widgets for one dataId, but we want to make a list of widgets
            // check if storeKey already exists
            const instance = (await this.getStoreValue(storeKey)) || { data: [], widgets: [] };
            let widgets = instance.widgets;
            let data = instance.data;

            if (!widgets.includes(`${widgetId}`) && widgetId && widgetId.length) {
                widgets.push(`${widgetId}`);
            }

            if (dataOverride) {
                data = [...data, dataOverride];
            }

            if (data.length > 15) {
                data = data.slice(data.length - 15);
            }

            this.homey.app.log(`[Device] ${this.getName()} - setWidgetInstance - ${!!instance ? 'Updating' : 'Creating'} store item`, { storeKey, dataId, widgets, data: data.length });

            await this.setStoreValue(storeKey, { dataId, lastSeen: Date.now(), data, widgets });

            return true;
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWidgetInstance - error`, error);
            return false;
        }
    }

    async widgetInstanceHeartbeats() {
        const now = Date.now();
        const timeout = 1; //120 * 60 * 1000; // 2 hours without heartbeat = removed/closed

        const storeData = await this.getStore();
        const widgetInstances = Object.entries(storeData).filter(([k]) => k.startsWith('widgetInstance-'));

        for (const [dataId, { lastSeen }] of widgetInstances) {
            if (now - lastSeen > timeout) {
                this.homey.app.log(`[widgetInstanceHeartbeats] Widget ${dataId} is gone (last seen ${new Date(lastSeen)})`);
                await this.unsetStoreValue(dataId);
            }
        }

        // Run this function again in 30 minutes
        this.homey.setTimeout(() => this.widgetInstanceHeartbeats(), 30 * 60 * 1000);
    }
}
