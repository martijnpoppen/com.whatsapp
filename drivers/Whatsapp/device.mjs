import Homey from 'homey';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { validateUrl, sleep, getBase64Image, toConsistentId } from '../../lib/helpers/index.mjs';
import path from 'path';
import fs from 'fs/promises';

// v1/v2 kept the whole Baileys auth state in the Homey device store, keyed
// `<clientId>:...`. v3 keeps it on the filesystem, so after copyFromStoreToFileSystem
// those entries are dead weight — but a long-running v1 install carries tens of
// thousands of them (pre-keys were never pruned back then), and every
// unsetStoreValue rewrites and persists the device's entire store record. Wiping
// them in one pass is O(n^2) work that pins the app until Homey kills it, and
// since nothing recorded progress the next boot started over from zero: a
// permanent crash loop with no way out for the user.
//
// So drain a bounded slice per app start and remember when we're finished. A
// store that takes a few days to fully drain costs some memory; one that takes
// the app down costs the user their WhatsApp connection.
const MIGRATION_MARKER_KEY = '_migrated_to_fs_v1';
const STORE_CLEANUP_DONE_KEY = '_store_cleanup_done_v1';
const STORE_CLEANUP_START_DELAY_MS = 60 * 1000;
const STORE_CLEANUP_BUDGET_MS = 5 * 60 * 1000;
const STORE_CLEANUP_RETRY_MS = 30 * 60 * 1000;
const STORE_CLEANUP_PAUSE_MS = 60;

export default class Whatsapp extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to WhatsApp`);

            await this.copyFromStoreToFileSystem();

            // One snapshot for all three. getStoreKeys() materialises the full
            // key list, which on a store migrated from v1.39 is a very large
            // array — taking it four separate times during boot is four times
            // the peak allocation for no benefit.
            const storeKeys = await this.getStoreKeys();
            await this.cleanupWidgetStore(storeKeys);
            await this.widgetInstanceHeartbeats(storeKeys);
            await this.logStoreKeys(storeKeys);

            // Deliberately not awaited: draining the legacy store must never
            // sit between the user and a working connection.
            this.scheduleLegacyStoreCleanup();

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setTriggers();
            await this.setConditions();
            await this.setWhatsappClient();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
        }
    }

    async onDeleted() {
        this.clearBackgroundTimers();
        await this.cleanupWidgetStore();
        await this.removeWhatsappClient();
    }

    async onUninit() {
        this.clearBackgroundTimers();
    }

    clearBackgroundTimers() {
        if (this._heartbeatTimeout) {
            this.homey.clearTimeout(this._heartbeatTimeout);
            this._heartbeatTimeout = null;
        }
        if (this._cleanupTimeout) {
            this.homey.clearTimeout(this._cleanupTimeout);
            this._cleanupTimeout = null;
        }
    }

    async setTriggers() {
        this.new_message = this.homey.flow.getDeviceTriggerCard('new_message');
        this.new_image = this.homey.flow.getDeviceTriggerCard('new_image');
        this.new_pairing_code = this.homey.flow.getDeviceTriggerCard('new_pairing_code');
    }

    async setConditions() {
        const normalize = (str) => str?.trim().toLowerCase();

        const text_condition = this.homey.flow.getConditionCard('text_condition');
        text_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [text_condition]`, { ...args, device: 'LOG' });

            const result = state.text && normalize(state.text) === normalize(args.text_input);

            this.homey.app.log(`[Device] ${this.getName()} - [text_condition] - result: `, result);
            return result;
        });

        const text_contains_condition = this.homey.flow.getConditionCard('text_contains_condition');
        text_contains_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [text_contains_condition]`, { ...args, device: 'LOG' });

            const result = state.text && normalize(state.text).includes(normalize(args.text_input));

            this.homey.app.log(`[Device] ${this.getName()} - [text_contains_condition] - result: `, result);
            return result;
        });

        const text_starts_with_condition = this.homey.flow.getConditionCard('text_starts_with_condition');
        text_starts_with_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [text_starts_with_condition]`, { ...args, device: 'LOG' });

            const result = state.text && normalize(state.text).startsWith(normalize(args.text_input));

            this.homey.app.log(`[Device] ${this.getName()} - [text_starts_with_condition] - result: `, result);
            return result;
        });

        const from_condition = this.homey.flow.getConditionCard('from_condition');
        from_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [from_condition]`, { ...args, device: 'LOG' });
            const result = state.from && normalize(state.from) === normalize(args.from_input);

            this.homey.app.log(`[Device] ${this.getName()} - [from_condition] - result: `, result);
            return result;
        });

        const from_number_condition = this.homey.flow.getConditionCard('from_number_condition');
        from_number_condition.registerRunListener(async (args, state) => {
            this.homey.app.log(`[Device] ${this.getName()} - [from_number_condition]`, { ...args, device: 'LOG' });
            const result = state.fromNumber && normalize(state.fromNumber) === normalize(args.from_input);

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

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const deviceObject = this.getData();
            const settings = await this.getSettings();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = this.driver.WhatsappClients[deviceObject.id];

            const result = await this.WhatsappClient.startup();

            if (result) {
                await sleep(2000);
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
        this.setUnavailable(`Repairing...`);

        // Stop the background timers so they don't compete with the repair for
        // store IO (and don't get duplicated when onInit runs again).
        this.clearBackgroundTimers();

        if (this.WhatsappClient) {
            await this.WhatsappClient.deleteDevice();
            this.WhatsappClient = null;
        }

        // No store wipe here any more. This used to walk the ENTIRE device store
        // and unset every key one by one, unpaced and with a log line each. On an
        // install migrated from v1.39 that store still holds tens of thousands of
        // legacy auth entries, so hitting "Repair" — exactly what a user does when
        // the migration left them broken — took the app down before the pairing
        // view ever appeared.
        //
        // It also wasn't doing what it was meant to any more: since v3 the auth
        // state lives in /userdata/auth/<clientId> and the store holds nothing the
        // repair needs to reset. The client wipes that folder itself on the next
        // pair attempt (forceNewSession), and the leftover legacy keys are drained
        // in the background by scheduleLegacyStoreCleanup().

        await sleep(3000);

        this.homey.app.log(`[Device] ${this.getName()} - removeWhatsappClient - done`);
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
            const phoneNumber = parsePhoneNumberWithError(recipient);
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
                    ((data = await this.WhatsappClient.sendLocation(recipient, splittedParam[0], splittedParam[1], message)), options);
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
                    const phoneNumber = parsedPn ? parsePhoneNumberWithError(parsedPn) : parsePhoneNumberWithError(`+${match[1]}`);

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
    // Replace lines 394-451 (messageHelper) in drivers/Whatsapp/device.mjs

    // ------------- Triggers -------------
    async messageHelper(msg) {
        try {
            if (!this.getAvailable()) return false;

            const settings = await this.getSettings();

            // Sequential instead of forEach(async) — prevents fanout of unhandled
            // rejections that have caused OOMs in the past.
            for (const m of msg.messages) {
                try {
                    await this.processMessage(m, settings);
                } catch (e) {
                    this.homey.app.error(`[messageHelper] processMessage failed`, e);
                }
            }

            return true;
        } catch (error) {
            this.homey.app.error(`[messageHelper] error`, error);
        }
    }

    async processMessage(m, settings) {
        // Skip envelopes with no usable content. Failed decryptions and
        // protocol messages (receipts, status updates, etc.) have either
        // m.message === null or a stub type. Flow cards can't do anything
        // useful with them and triggering on them caused the OOM-via-
        // unhandled-rejection storm.
        if (!m?.message || m.messageStubType) {
            this.homey.app.log(`[messageHelper] skipping envelope (no message body or stub type)`, { stubType: m?.messageStubType, fromMe: m?.key?.fromMe });
            return;
        }

        // remoteJid is the chat (group JID or 1:1 JID). This is the correct
        // value for "replyTo" — i.e. where to send a reply.
        const jid = m.key && m.key.remoteJid;
        if (!jid || typeof jid !== 'string') {
            this.homey.app.log(`[messageHelper] skipping message with no remoteJid`);
            return;
        }

        const newDate = new Date();
        newDate.setTime(m.messageTimestamp * 1000);
        const dateString = newDate.toUTCString();

        const group = !!(m.key && m.key.participant);
        const groupCode = group ? await this.WhatsappClient.getGroupInviteById(jid).catch(() => null) : null;

        const from = m.pushName;
        const fromJid = m.key.participant || jid;

        // Resolve the sender's phone number. May be unavailable (LID without
        // mapping yet). That's fine — fromNumber falls back to the raw JID
        // identifier.
        const pn = (await this.WhatsappClient.getPNForLID(fromJid).catch(() => null)) || m.key.participantPn;
        const fromNumber = (pn && this.getParsedPhoneNumber(pn)) || `+${fromJid.split('@')[0]}`;

        const fromMe = m.key && m.key.fromMe;
        const triggerAllowed = (fromMe && settings.trigger_own_message) || !fromMe;
        const hasImage = !!(m.message && m.message.imageMessage);
        const isPollUpdate = !!(m.message && m.message.pollUpdateMessage);

        if (isPollUpdate) {
            this.homey.app.log(`[messageHelper] ignoring poll update`);
            return;
        }

        let text = (m.message && m.message.conversation) || '';
        if (!text) {
            text = (m.message && m.message.extendedTextMessage && m.message.extendedTextMessage.text) || '';
        }
        if (hasImage) {
            text = (m.message && m.message.imageMessage && m.message.imageMessage.caption) || '';
        }

        const tokens = {
            replyTo: jid,
            fromNumber,
            groupCode: groupCode || '',
            from: from || '',
            text,
            time: dateString,
            group,
            hasImage
        };
        const state = tokens;

        if (triggerAllowed) {
            // AWAIT and CATCH — was fire-and-forget which caused unhandled
            // rejection accumulation → OOM.
            try {
                await this.new_message.trigger(this, tokens, state);
            } catch (e) {
                this.homey.app.error(`[messageHelper] new_message.trigger failed`, e, { tokens });
            }
        }

        try {
            await this.sendToWidget({
                jid,
                from,
                fromMe,
                timeStamp: m.messageTimestamp * 1000,
                text,
                group,
                hasImage,
                imgUrl: null,
                base64Image: null,
                m,
                originalRecipient: groupCode ? `https://chat.whatsapp.com/${groupCode}` : fromNumber
            });
        } catch (e) {
            this.homey.app.error(`[messageHelper] sendToWidget failed`, e);
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
            deviceId: this.getId(),
            dataId: data.originalRecipient
        };

        this.homey.api.realtime(`${this.getId()}-chat`, saveData);
        this.setWidgetInstance(null, data.originalRecipient, saveData);
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

    async widgetInstanceHeartbeats(knownStoreKeys = null) {
        const now = Date.now();
        const timeout = 36 * 60 * 60 * 1000; // 36 hours without heartbeat = removed/closed

        const storeKeys = knownStoreKeys || (await this.getStoreKeys());
        const filteredKeys = storeKeys.filter((key) => key.startsWith('widgetInstance-'));

        for (const dataId of filteredKeys) {
            const instance = await this.getStoreValue(dataId);
            const lastSeen = instance?.lastSeen;

            if (lastSeen && now - lastSeen > timeout) {
                this.homey.app.log(`[widgetInstanceHeartbeats] Widget ${dataId} is gone (last seen ${new Date(lastSeen)})`);
                await this.unsetStoreValue(dataId);
            }
        }

        // Run this function again in 30 minutes
        this._heartbeatTimeout = this.homey.setTimeout(() => this.widgetInstanceHeartbeats(), 30 * 60 * 1000);
    }

    async cleanupWidgetStore(knownStoreKeys = null) {
        this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore`);

        const storeKeys = knownStoreKeys || (await this.getStoreKeys());
        const filteredKeys = storeKeys.filter((key) => key.startsWith('widget-chat-') || key.startsWith('widget-instance-'));

        for (const storeKey of filteredKeys) {
            this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore - removing key: ${storeKey}`);
            await this.unsetStoreValue(storeKey);
        }
    }

    async copyFromStoreToFileSystem() {
        const clientId = this.getData().id;
        const migrationMarkerKey = MIGRATION_MARKER_KEY;

        // Already done?
        if (await this.getStoreValue(migrationMarkerKey)) {
            this.homey.app.log(`[Device] ${this.getName()} - copyFromStoreToFileSystem - migration already completed, skipping`);
            return;
        }

        this.homey.app.log(`[Device] ${this.getName()} - copyFromStoreToFileSystem - starting migration`);

        const authFolder = path.join(this.homey.app.getDataPath(), 'auth', clientId);

        // Make sure the destination exists
        try {
            await fs.mkdir(authFolder, { recursive: true });
        } catch (e) {
            this.homey.app.error(`[Device] ${this.getName()} - copyFromStoreToFileSystem - mkdir failed`, e);
            return; // Bail; we'll retry next start
        }

        const sessionPrefix = `${clientId}:`;
        const preKeyPrefix = `${clientId}:pre-key-`;

        let storeKeys;
        try {
            storeKeys = await this.getStoreKeys();
        } catch (e) {
            this.homey.app.error(`[Device] ${this.getName()} - copyFromStoreToFileSystem - getStoreKeys failed`, e);
            return;
        }

        // Migrate everything for this session EXCEPT pre-keys. Baileys
        // regenerates pre-keys on next connect — no point copying potentially
        // hundreds of thousands of them. Other categories (creds, session,
        // sender-key, app-state-sync-*) are small and important.
        const keysToMigrate = storeKeys.filter((k) => k.startsWith(sessionPrefix) && !k.startsWith(preKeyPrefix));

        this.homey.app.log(`[Device] ${this.getName()} - copyFromStoreToFileSystem - ${keysToMigrate.length} keys to migrate ` + `(pre-keys skipped)`);

        let copied = 0;
        let failed = 0;

        for (const storeKey of keysToMigrate) {
            try {
                const raw = await this.getStoreValue(storeKey);
                if (!raw) {
                    continue;
                }

                // Strip the `${sessionKey}:` prefix to get the file name
                // useMultiFileAuthState expects.
                let fileName = storeKey.slice(sessionPrefix.length);

                // Match useMultiFileAuthState's sanitization: WhatsApp's key
                // identifiers are base64 and can contain '/' which filesystems
                // interpret as path separators. Baileys' built-in auth state
                // replaces '/' with '__' and ':' with '-'.
                fileName = fileName.replace(/\//g, '__').replace(/:/g, '-');

                const filePath = path.join(authFolder, `${fileName}.json`);

                // Write atomically: write to .tmp then rename.
                const tmp = `${filePath}.tmp`;
                await fs.writeFile(tmp, raw);
                await fs.rename(tmp, filePath);

                copied++;
            } catch (e) {
                this.homey.app.error(`[Device] ${this.getName()} - copyFromStoreToFileSystem - failed to migrate ${storeKey}`, e);
                failed++;
            }

            // Yield between writes so the CPU watchdog stays happy.
            // Each store read is ~470ms, so we're already paced; a small extra
            // sleep just keeps things smooth.
            await new Promise((r) => setTimeout(r, 20));
        }

        if (failed > 0) {
            this.homey.app.error(`[Device] ${this.getName()} - copyFromStoreToFileSystem - ${failed} keys failed; ` + `not marking migration complete, will retry next start`);
            return;
        }

        // All good — mark migration done so we never run it again.
        await this.setStoreValue(migrationMarkerKey, true);

        this.homey.app.log(`[Device] ${this.getName()} - copyFromStoreToFileSystem - done: ${copied} keys migrated to ${authFolder}`);

        // The old store data is drained by scheduleLegacyStoreCleanup(), which
        // runs on every boot until it reports zero remaining. It used to be
        // kicked off from here instead, which meant a cleanup interrupted by a
        // restart was never resumed: this branch only runs on the one boot that
        // completes the migration.
    }

    // Delete legacy `<clientId>:` store entries within a hard time budget.
    // Returns how many were removed and how many are still there, so callers
    // can decide whether to mark the job finished.
    async pruneLegacyStoreKeys({ budgetMs, pauseMs, reason }) {
        const clientId = this.getData().id;
        const sessionPrefix = `${clientId}:`;
        const preKeyPrefix = `${sessionPrefix}pre-key-`;
        const start = Date.now();

        let storeKeys;
        try {
            storeKeys = await this.getStoreKeys();
        } catch (e) {
            this.homey.app.error(`[Device] ${this.getName()} - pruneLegacyStoreKeys (${reason}) - getStoreKeys failed`, e);
            return { deleted: 0, remaining: -1 };
        }

        const legacy = storeKeys.filter((k) => k.startsWith(sessionPrefix));
        storeKeys = null;

        if (!legacy.length) return { deleted: 0, remaining: 0 };

        // Pre-keys first: they are the overwhelming bulk of a v1 store and
        // Baileys regenerates them anyway, so they're the cheapest to lose if
        // we run out of budget mid-pass.
        legacy.sort((a, b) => (b.startsWith(preKeyPrefix) ? 1 : 0) - (a.startsWith(preKeyPrefix) ? 1 : 0));

        let deleted = 0;
        for (const storeKey of legacy) {
            if (Date.now() - start > budgetMs) break;

            try {
                await this.unsetStoreValue(storeKey);
                deleted++;
            } catch (_) {
                /* individual failures are retried on the next pass */
            }

            // Paced on purpose: each unset persists the whole store record, so
            // a tight loop starves the rest of the app.
            await sleep(pauseMs);
        }

        const remaining = legacy.length - deleted;

        this.homey.app.log(
            `[Device] ${this.getName()} - pruneLegacyStoreKeys (${reason}) - removed ${deleted}, ` +
                `${remaining} remaining, ${((Date.now() - start) / 1000).toFixed(1)}s`
        );

        return { deleted, remaining };
    }

    async scheduleLegacyStoreCleanup(delayMs = STORE_CLEANUP_START_DELAY_MS) {
        try {
            // Nothing to clean until the auth state actually made it to disk.
            if (!(await this.getStoreValue(MIGRATION_MARKER_KEY))) return;
            if (await this.getStoreValue(STORE_CLEANUP_DONE_KEY)) return;
        } catch (e) {
            this.homey.app.error(`[Device] ${this.getName()} - scheduleLegacyStoreCleanup - marker read failed`, e);
            return;
        }

        if (this._cleanupTimeout) return;

        // Let the connection settle before competing for store IO, then work in
        // short bursts with long gaps: ~5 minutes of deletes per half hour.
        // Slow on purpose — a store that takes a day to drain is fine, one that
        // is drained fast enough to trip Homey's watchdog is not.
        this._cleanupTimeout = this.homey.setTimeout(async () => {
            this._cleanupTimeout = null;

            try {
                const { remaining } = await this.pruneLegacyStoreKeys({
                    budgetMs: STORE_CLEANUP_BUDGET_MS,
                    pauseMs: STORE_CLEANUP_PAUSE_MS,
                    reason: 'background'
                });

                if (remaining === 0) {
                    await this.setStoreValue(STORE_CLEANUP_DONE_KEY, true);
                    this.homey.app.log(`[Device] ${this.getName()} - legacy store cleanup complete`);
                    return;
                }

                if (remaining > 0) {
                    this.homey.app.log(
                        `[Device] ${this.getName()} - legacy store cleanup paused, ${remaining} keys left`
                    );
                }

                // remaining < 0 means getStoreKeys() failed; retry on the same
                // schedule rather than giving up for this whole app run.
                await this.scheduleLegacyStoreCleanup(STORE_CLEANUP_RETRY_MS);
            } catch (e) {
                this.homey.app.error(`[Device] ${this.getName()} - legacy store cleanup failed`, e);
            }
        }, delayMs);
    }

    async logStoreKeys(knownStoreKeys = null) {
        // Never dump the raw key list. A store migrated from v1.39 can hold
        // >100k `pre-key-` entries; JSON.stringify(keys, null, 2) on that is a
        // multi-megabyte string which the log pipeline then copies again — on
        // its own enough to push the app over its memory limit at boot, every
        // boot, before anything else even gets a chance to run.
        const clientId = this.getData().id;
        const sessionPrefix = `${clientId}:`;
        const preKeyPrefix = `${sessionPrefix}pre-key-`;

        const storeKeys = knownStoreKeys || (await this.getStoreKeys());

        let legacyPreKeys = 0;
        let legacyOther = 0;
        let widget = 0;

        for (const k of storeKeys) {
            if (k.startsWith(preKeyPrefix)) legacyPreKeys++;
            else if (k.startsWith(sessionPrefix)) legacyOther++;
            else if (k.startsWith('widget')) widget++;
        }

        this.homey.app.log(`[Device] ${this.getName()} - store summary =>`, {
            total: storeKeys.length,
            legacyPreKeys,
            legacyOther,
            widget,
            other: storeKeys.length - legacyPreKeys - legacyOther - widget
        });
    }
}
