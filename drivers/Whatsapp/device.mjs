import Homey from 'homey';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { validateUrl, sleep, toConsistentId, parseGroupInvite, probeImageUrl, imageTypeFromBuffer, sha256, randomId, fetchImageBuffer } from '../../lib/helpers/index.mjs';
import path from 'path';
import fs from 'fs/promises';
import { normalizeMessageContent } from 'baileys';

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

// Widget chat images live on disk, not in the device store. A data: URL of a
// JPEG is ~1.33x the file, the history keeps the last 15 messages, and the whole
// store value is re-serialised on every single message — so an image-heavy chat
// held megabytes in the device store and rewrote all of it per message. 3.0.12
// fixed that by dropping the images, which lost them as soon as the dashboard
// was reopened. They now go to /userdata and are re-attached on read.
const WIDGET_IMAGE_DIR = 'widget-images';

// The per-chat directory is keyed on a random per-device salt, not on the phone
// number alone. sha256 of a phone number is not privacy: the keyspace is tiny,
// and a single core here brute-forces the whole +316######## range in about two
// minutes. With the salt — which lives in the device store, not in /userdata —
// the directory name cannot be walked back to a number by someone who can only
// read the folder.
const WIDGET_IMAGE_SALT_KEY = '_widget_image_salt';

// Message ids remembered for duplicate detection: one day, at most 4096 of them.
const SEEN_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_MESSAGE_MAX = 4096;

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

            // Same: tidying orphaned widget images is not worth delaying startup.
            this.sweepWidgetImages().catch((error) =>
                this.homey.app.error(`[Device] ${this.getName()} - sweepWidgetImages`, error)
            );

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setTriggers();
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

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, Object.keys(data).length, this.homey.app.memorySnapshot());

            return !!Object.keys(data).length;
        }

        return false;
    }

    async getRecipient(recipient, isGroup) {
        if (recipient.includes('@g.us') || recipient.includes('@s.whatsapp.net') || recipient.includes('@lid') || recipient.includes('@newsletter')) {
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
            const inviteCode = parseGroupInvite(recipient);
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
            }).catch((error) => this.homey.app.error(`[Device] ${this.getName()} - sendToWidget failed`, error));

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
            }).catch((error) => this.homey.app.error(`[Device] ${this.getName()} - sendToWidget failed`, error));

            // Compact on purpose. This used to spread `params`, which dragged the Homey Image
            // object — and through it ManagerImages and Homey itself — into the log: ~18
            // rendered lines per image send, none of them useful. The memory reading rides
            // along on the line that was already here, and the matching reading after the
            // send rides on the existing onCapability_SendMessage line, so a send now costs
            // fewer log lines than before while also reporting what memory did across it.
            this.homey.app.log(
                `[Device] ${this.getName()} - sendMessage - send${msgType}`,
                `to=${recipient} chars=${message ? message.length : 0} url=${fileUrl} ${this.homey.app.memorySnapshot()}`
            );

            if (msgType === 'video' || msgType === 'image') {
                // Report what the URL actually serves. If it answers with an error page,
                // an empty body, or bytes that are not an image, Baileys uploads it anyway
                // and WhatsApp shows a broken image — and the same bytes reach the widget
                // as `data:image/jpeg;base64,<garbage>`, so one bad URL breaks both places
                // with nothing in the log to explain it.
                //
                // Deliberately does NOT block the send. The mechanism is still a hypothesis
                // and a false negative here would break working flows for everyone; once a
                // report confirms it, this should become a hard failure instead of a note.
                if (msgType === 'image') {
                    const probe = await probeImageUrl(fileUrl);
                    this.homey.app.log(
                        `[Device] ${this.getName()} - image source ${probe.ok ? 'ok' : 'SUSPECT'}`,
                        probe.ok
                            ? `format=${probe.format} type=${probe.contentType} bytes=${probe.contentLength}`
                            : `reason=${probe.reason} type=${probe.contentType} bytes=${probe.contentLength}`
                    );
                }

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

    async coolDown() {
        return await sleep(1000);
    }

    // ------------- Triggers -------------
    async messageHelper(msg) {
        try {
            // No availability gate here. onInit marks the device unavailable and
            // setWhatsappClient only flips it back two seconds after startup, so a
            // message that arrived in that window was dropped without a log line.
            // If the client is delivering messages, the connection is up.
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

    // A message id seen before fires nothing. Baileys can hand the same message
    // over again (retry receipts, reconnects), and a repeated new_message trigger
    // repeats whatever the flow switches. Bounded so it never grows with uptime.
    isDuplicateMessage(m) {
        this._seenMessages ??= new Map();

        const now = Date.now();
        for (const [id, time] of this._seenMessages) {
            if (now - time < SEEN_MESSAGE_TTL_MS) break;
            this._seenMessages.delete(id);
        }

        const id = `${m.key.remoteJid}|${m.key.id}|${!!m.key.fromMe}`;
        if (this._seenMessages.has(id)) return true;

        // Reserved before any await, so two batches carrying the same message
        // cannot both get past this point.
        this._seenMessages.set(id, now);
        if (this._seenMessages.size > SEEN_MESSAGE_MAX) this._seenMessages.delete(this._seenMessages.keys().next().value);

        return false;
    }

    // The sender's phone number, or '' when WhatsApp only gave us a LID and no
    // mapping is known yet. A LID is not a phone number: prefixing it with '+'
    // produced a "number" that no fromNumber condition can ever match.
    async getSenderNumber(fromJid, alternateJid) {
        const isPn = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');

        if (isPn(fromJid)) return this.getParsedPhoneNumber(fromJid);
        if (isPn(alternateJid)) return this.getParsedPhoneNumber(alternateJid);

        const pn = fromJid && fromJid.endsWith('@lid') ? await this.WhatsappClient.getPNForLID(fromJid).catch(() => null) : null;
        return pn ? this.getParsedPhoneNumber(pn) : '';
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
        if (!jid || typeof jid !== 'string' || !m.key.id) {
            this.homey.app.log(`[messageHelper] skipping message with no remoteJid`);
            return;
        }

        // Status updates (status@broadcast) carry a participant too, so they used
        // to come through as group messages. Only real chats trigger flows.
        const group = jid.endsWith('@g.us');
        if (!group && !jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) {
            this.homey.app.log(`[messageHelper] skipping non-chat message`);
            return;
        }

        // Disappearing, view-once and edited messages wrap the real content one
        // level down (ephemeralMessage.message.conversation, ...). Reading only
        // the top level gave those an empty text and failed every text condition.
        const body = normalizeMessageContent(m.message);

        // Reactions, deletes/edits (protocolMessage), poll votes and bare
        // sender-key distributions are not messages anyone wrote to the Homey.
        if (!body || body.protocolMessage || body.reactionMessage || body.pollUpdateMessage || (body.senderKeyDistributionMessage && Object.keys(body).length === 1)) {
            this.homey.app.log(`[messageHelper] ignoring protocol message or update`);
            return;
        }

        if (this.isDuplicateMessage(m)) {
            this.homey.app.log(`[messageHelper] ignoring duplicate message`);
            return;
        }

        const newDate = new Date();
        newDate.setTime(m.messageTimestamp * 1000);
        const dateString = newDate.toUTCString();

        const groupCode = group ? await this.WhatsappClient.getGroupInviteById(jid).catch(() => null) : null;

        const from = m.pushName;
        const fromJid = group ? m.key.participant : jid;
        const fromNumber = await this.getSenderNumber(fromJid, group ? m.key.participantAlt || m.key.participantPn : m.key.remoteJidAlt);

        const fromMe = m.key && m.key.fromMe;
        const triggerAllowed = (fromMe && settings.trigger_own_message) || !fromMe;
        const hasImage = !!body.imageMessage;

        const text =
            body.conversation ||
            (body.extendedTextMessage && body.extendedTextMessage.text) ||
            (body.imageMessage && body.imageMessage.caption) ||
            (body.videoMessage && body.videoMessage.caption) ||
            (body.documentMessage && body.documentMessage.caption) ||
            '';

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
                // No tokens here: they carry the message text and the sender's number.
                this.homey.app.error(`[messageHelper] new_message.trigger failed`, e);
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
                // Unwrapped, so the image of a disappearing message can be downloaded too.
                m: { ...m, message: body },
                originalRecipient: groupCode ? `https://chat.whatsapp.com/${groupCode}` : fromNumber || jid
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
        // Work in Buffers, not base64 strings: the bytes go to disk, and base64 is
        // only produced for the live payload.
        let buffer = null;

        // When image is sent from Homey
        if (data.imageUrl) {
            buffer = await fetchImageBuffer(data.imageUrl);
        }

        // When image is received from Whatsapp
        if (data.m && data.hasImage) {
            buffer = await this.WhatsappClient.downloadMediaMsg(data.m);
        }

        const stored = buffer && buffer.length ? await this.storeWidgetImage(data.originalRecipient, buffer) : null;
        const base64Image = stored ? `data:${stored.mime};base64,${buffer.toString('base64')}` : null;

        const { text, from, fromMe, timeStamp, hasImage } = data;
        const saveData = {
            text,
            from,
            ...(fromMe && { fromMe }),
            timeStamp,
            ...(hasImage && { hasImage }),
            // Only the hashed filename is persisted, never the bytes.
            ...(stored && { imageFile: stored.file }),
            deviceId: this.getId(),
            dataId: data.originalRecipient
        };

        // The live payload carries the image so an open dashboard renders it straight away.
        this.homey.api.realtime(`${this.getId()}-chat`, { ...saveData, ...(base64Image && { base64Image }) });

        // The persisted history carries only imageFile; getWidgetInstance reads the
        // file back and re-attaches base64, so reopening the dashboard shows the
        // image again. hasImage is still kept, so an entry whose file has been
        // pruned can say so rather than rendering a broken icon.
        await this.setWidgetInstance(null, data.originalRecipient, saveData);
    }

    widgetImageRoot() {
        return path.join(this.homey.app.getDataPath(), WIDGET_IMAGE_DIR);
    }

    // Random per-device, created once and kept in the device store so it is never
    // written to /userdata alongside the files it protects.
    async widgetImageSalt() {
        let salt = await this.getStoreValue(WIDGET_IMAGE_SALT_KEY);

        if (!salt) {
            salt = randomId(32);
            await this.setStoreValue(WIDGET_IMAGE_SALT_KEY, salt);
        }

        return salt;
    }

    async widgetImageDirectory(dataId) {
        return sha256(`${await this.widgetImageSalt()}:${dataId}`);
    }

    // /userdata/widget-images/<sha256(salt + dataId)>/<random>.<ext>
    //
    // The filename is random, not a hash of the contents. /userdata is served
    // over HTTP, and a content hash is guessable by anyone holding the same
    // bytes — users forward publicly-sourced images (a chart, a meme), so
    // sha256(bytes) is a name an outsider can compute and then fetch. Random
    // names cost us the dedupe of storing the same image once; the prune and
    // sweep below already keep the directory bounded.
    async storeWidgetImage(dataId, buffer) {
        try {
            const type = imageTypeFromBuffer(buffer);
            if (!type) {
                this.homey.app.log(`[Device] ${this.getName()} - storeWidgetImage - not an image, skipped`);
                return null;
            }

            const file = `${await this.widgetImageDirectory(dataId)}/${randomId()}.${type.ext}`;
            const absolute = path.join(this.widgetImageRoot(), file);

            await fs.mkdir(path.dirname(absolute), { recursive: true });
            await fs.writeFile(absolute, buffer);

            return { file, mime: type.type };
        } catch (error) {
            this.homey.app.error(`[Device] ${this.getName()} - storeWidgetImage failed`, error);
            return null;
        }
    }

    async readWidgetImage(file) {
        try {
            const buffer = await fs.readFile(path.join(this.widgetImageRoot(), file));
            const type = imageTypeFromBuffer(buffer);
            return `data:${type ? type.type : 'image/jpeg'};base64,${buffer.toString('base64')}`;
        } catch (error) {
            return null;
        }
    }

    // The history keeps the last 15 messages, so images fall out of it
    // continuously and would otherwise accumulate on disk for ever. Called after
    // the store write, with the entries that survived the trim.
    async pruneWidgetImages(dataId, entries) {
        const directory = path.join(this.widgetImageRoot(), await this.widgetImageDirectory(dataId));

        let names;
        try {
            names = await fs.readdir(directory);
        } catch (error) {
            return; // nothing stored for this chat yet
        }

        const keep = new Set(
            (entries || []).map((entry) => entry && entry.imageFile).filter(Boolean).map((f) => f.split('/').pop())
        );

        let removed = 0;
        for (const name of names) {
            if (keep.has(name)) continue;
            try {
                await fs.unlink(path.join(directory, name));
                removed++;
            } catch (error) {
                /* already gone */
            }
        }

        if (removed) {
            this.homey.app.log(`[Device] ${this.getName()} - pruneWidgetImages - removed ${removed}`);
        }
    }

    // Delete anything under widget-images that no stored entry references.
    //
    // pruneWidgetImages only looks inside one chat's directory, so it cannot see
    // orphans: a chat whose widget was removed, or — because the directory name is
    // now salted — the directories written under the earlier unsalted scheme.
    // Runs once per boot, after the store is settled.
    async sweepWidgetImages() {
        try {
            const root = this.widgetImageRoot();

            let directories;
            try {
                directories = await fs.readdir(root);
            } catch (error) {
                return; // nothing written yet
            }

            const keys = (await this.getStoreKeys()).filter((key) => key.startsWith('widgetInstance-'));
            const expected = new Map();

            for (const key of keys) {
                const instance = await this.getStoreValue(key);
                if (!instance || !instance.dataId) continue;

                const directory = await this.widgetImageDirectory(instance.dataId);
                const files = new Set(
                    (instance.data || [])
                        .map((entry) => entry && entry.imageFile)
                        .filter(Boolean)
                        .map((file) => file.split('/').pop())
                );

                expected.set(directory, files);
            }

            let removedFiles = 0;
            let removedDirectories = 0;

            for (const directory of directories) {
                const absolute = path.join(root, directory);

                if (!expected.has(directory)) {
                    await fs.rm(absolute, { recursive: true, force: true }).catch(() => {});
                    removedDirectories++;
                    continue;
                }

                const keep = expected.get(directory);
                let names;
                try {
                    names = await fs.readdir(absolute);
                } catch (error) {
                    continue;
                }

                for (const name of names) {
                    if (keep.has(name)) continue;
                    await fs.unlink(path.join(absolute, name)).catch(() => {});
                    removedFiles++;
                }
            }

            if (removedDirectories || removedFiles) {
                this.homey.app.log(
                    `[Device] ${this.getName()} - sweepWidgetImages - removed ${removedDirectories} directories, ${removedFiles} files`
                );
            }
        } catch (error) {
            this.homey.app.error(`[Device] ${this.getName()} - sweepWidgetImages failed`, error);
        }
    }

    async getWidgetInstance(dataId, getData = true, convertJid = false) {
        this.homey.app.log(`[Device] ${this.getName()} - getWidgetInstance`, dataId);

        const storeKey = `widgetInstance-${toConsistentId(dataId)}`;
        const instance = await this.getStoreValue(storeKey);

        this.homey.app.log(`[Device] ${this.getName()} - getWidgetInstance instance exists:`, !!instance);

        if (getData) {
            const entries = instance?.data || null;
            if (!entries) return null;

            // Re-attach the images from /userdata, so reopening the dashboard shows
            // them instead of "image no longer available". Entries whose file has
            // been pruned, and entries written by 3.0.12-3.0.16 which have no file
            // at all, simply come back without one.
            return Promise.all(
                entries.map(async (entry) => {
                    if (!entry || !entry.imageFile) return entry;

                    const base64Image = await this.readWidgetImage(entry.imageFile);
                    return base64Image ? { ...entry, base64Image } : entry;
                })
            );
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

            await this.pruneWidgetImages(dataId, data);

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
