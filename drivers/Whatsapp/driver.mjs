import Homey from 'homey';
import { GetGUID, sleep, clientTag } from '../../lib/helpers/index.mjs';
import whatsappClient from '../../lib/com.whatsapp.api/index.mjs';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

// How long to wait after a pair session closes before deciding its client is
// an orphan. On a successful pair the device is created as the session ends,
// and it has to be registered before we can tell "abandoned" from "just paired".
const ORPHAN_SWEEP_DELAY_MS = 15000;

export default class mainDriver extends Homey.Driver {
    async onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
        this.WhatsappClients = [];
        this.homeyCloudId = await this.homey.cloud.getHomeyId();

        const devices = this.getDevices();

        devices.forEach(async (device) => {
            const deviceObject = device.getData();
            await this.setWhatsappClient(deviceObject.id, device);
        });
    }

    async setWhatsappClient(deviceId, device = null) {
        if (this.WhatsappClients[deviceId]) {
            delete this.WhatsappClients[deviceId];
        }

        this.WhatsappClients[deviceId] = new whatsappClient({
            deviceId,
            homeyData: {
                driver: this,
                device,
                app: this.homey.app
            }
        });
    }

    // Every *pair* attempt mints a fresh guid, so abandoning the dialog used to
    // leave its client behind for the lifetime of the app: a live socket,
    // reconnect timers and event listeners under a guid that will never become
    // a device. Repeat attempts for one number stacked up several of them, each
    // still asking WhatsApp for pairing codes for that number.
    async destroyOrphanedClient(guid) {
        if (!guid) return;

        // A guid that became a real device is not an orphan. Repair also reuses
        // the device's own id, so this covers repair sessions too.
        const isDevice = this.getDevices().some((device) => device.getData().id === guid);
        if (isDevice) return;

        const client = this.WhatsappClients[guid];
        if (!client) return;

        this.homey.app.log(`[Driver] ${this.id} - destroying orphaned pairing client`, { client: clientTag(guid) });

        try {
            await client.deleteDevice();
        } catch (error) {
            this.homey.app.error(`[Driver] ${this.id} - orphaned client teardown error`, error);
        }

        delete this.WhatsappClients[guid];
    }

    stopCheckInterval(ctx) {
        if (ctx._checkInterval) {
            ctx.homey.clearInterval(ctx._checkInterval);
            ctx._checkInterval = null;
        }
    }

    async setCheckInterval(ctx, session, guid) {
        // Idempotent: the pairing-code view triggers a showView on the driver
        // as well as being reached from the poll below, and restarting the
        // interval there used to reset the poll on every re-render.
        if (ctx._checkInterval) return;

        // A failed attempt is final for this pair session. Without this the
        // pairing-code view, re-shown below to report the failure, would start
        // the poll again, see ERROR again and re-show itself every 4s.
        if (ctx.pairFailed) return;

        ctx._checkInterval = ctx.homey.setInterval(async () => {
            try {
                ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - poll`, { client: clientTag(guid) });

                if (!ctx.WhatsappClients[guid]) {
                    ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - client gone, stopping`);
                    ctx.stopCheckInterval(ctx);
                    return;
                }

                const data = await ctx.WhatsappClients[guid].getData();

                // getData() returns false while the client is still starting up.
                if (!data || data.clientID !== guid) return;

                // data carries the real clientID — the /userdata/auth directory name. Tag it.
                ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - ${data.type}`, {
                    ...data,
                    clientID: clientTag(data.clientID),
                    // The phone number rides along in data; diagnostics reports
                    // are not the place for it.
                    usePairingCode: !!data.usePairingCode
                });

                if (data.type === 'READY') {
                    ctx.stopCheckInterval(ctx);

                    // Hand the device its client back here, not only from the
                    // loading2 view below: the user's phone reports the link a
                    // moment before this dialog advances, and closing the dialog
                    // then left the device with a null client and every flow card
                    // throwing. This runs whether or not the dialog is still open.
                    if (ctx.device) ctx.device.attachWhatsappClient();

                    // Straight to the result. This used to hop through
                    // loading2 and let its showView handler navigate on, and
                    // Homey dropped that nested showView: report cdf9bd81 has
                    // READY, loading2, "Found devices" — then nothing until the
                    // user closed a spinner that would never stop.
                    await ctx.finishPairing(ctx, session);
                    return;
                }

                if (data.type === 'CODE') {
                    const isNewCode = ctx.code !== data.msg;
                    ctx.code = data.msg;
                    ctx.pairError = null;

                    if (!session) return;

                    // Push it, but the view also pulls it via `get_pairing_code`
                    // once its listener is actually attached — session.emit() is
                    // fire-and-forget and is dropped when the target view has not
                    // finished loading, which is why the code never showed up.
                    if (isNewCode) session.emit('code', data.msg);

                    if (!ctx.codeShown) {
                        ctx.codeShown = true;
                        // Show the view once. It used to be re-shown on every
                        // poll (clientInfo stays CODE until the user pairs),
                        // which reloaded the page every 4s and wiped whatever
                        // had just been rendered into it.
                        await session.showView('whatsapp_pairing_code');
                    }

                    // Deliberately keep polling: after the user types the code
                    // into WhatsApp we still need READY (or ERROR) to move on.
                    return;
                }

                if (data.type === 'ERROR') {
                    ctx.stopCheckInterval(ctx);
                    ctx.failPairing(ctx, session, data.msg);
                    return;
                }

                if (data.type === 'CLOSED') {
                    ctx.stopCheckInterval(ctx);
                    if (session) return session.showView('done');
                }
            } catch (error) {
                ctx.homey.app.error(`[Driver] ${ctx.id} setCheckInterval error`, error);
                ctx.stopCheckInterval(ctx);
            }
        }, 4000);
    }

    // The pairing attempt is dead: the code expired, WhatsApp closed the
    // socket, or the reconnect after linking gave up. Only the pairing-code view
    // can show that — the `loading` / `loading2` views are Homey's own spinner
    // template and ignore `pair_error`, so a failure that landed while one of
    // them was up left the user watching a spinner that never stops. Always
    // move to the pairing-code view and let it show the reason.
    failPairing(ctx, session, reason) {
        ctx.homey.app.log(`[Driver] ${ctx.id} - pairing failed`, { reason });

        ctx.pairFailed = true;
        ctx.pairError = `${ctx.homey.__('pair.failed')} (${reason || 'unknown error'})`;
        // The old code is useless now; the view must not show it over the error.
        ctx.code = null;
        ctx.codeShown = true;

        if (!session) return;

        // Push for a pairing-code view that is already mounted, then show the
        // view for every other case. A (re)loaded view pulls the error itself.
        session.emit('pair_failed', ctx.pairError);
        session.showView('whatsapp_pairing_code').catch((error) =>
            ctx.homey.app.error(`[Driver] ${ctx.id} - showView after pairing failure`, error)
        );
    }

    resetPairState() {
        this.code = null;
        this.codeShown = false;
        this.pairError = null;
        this.pairFailed = false;
        this.pairFinished = false;
        this.listOpened = false;
        this.results = [];
    }

    // Never call session.showView() from inside the showView handler and wait
    // on it: Homey can drop a navigation issued while it is still switching to
    // the view whose handler is running. Run it after the handler returned.
    navigate(session, view, delay = 500) {
        if (!session) return;

        this.homey.setTimeout(() => {
            session.showView(view).catch((error) => this.homey.app.error(`[Driver] ${this.id} - showView ${view} failed`, error));
        }, delay);
    }

    // WhatsApp confirmed the link (READY). Build the result and leave the
    // spinner — once, whichever of the poll or the loading2 view gets here first.
    async finishPairing(ctx, session) {
        if (ctx.pairFinished) return;
        ctx.pairFinished = true;
        ctx.stopCheckInterval(ctx);

        ctx.results = [
            {
                name: `Whatsapp`,
                data: {
                    id: ctx.guid
                },
                settings: {
                    phonenumber: ctx.phonenumber
                }
            }
        ];

        ctx.homey.app.log(
            `[Driver] ${ctx.id} - Found devices - `,
            ctx.results.map((result) => ({ name: result.name, client: clientTag(result.data.id) }))
        );

        if (ctx.type === 'repair') {
            if (ctx.device) {
                await ctx.device.setSettings({ phonenumber: ctx.phonenumber }).catch((error) =>
                    ctx.homey.app.error(`[Driver] ${ctx.id} - repair setSettings`, error)
                );
                await ctx.device.setWhatsappClient();
            }

            ctx.navigate(session, 'done');
            return;
        }

        ctx.navigate(session, 'list_devices');

        // Belt and braces: if the device list has not asked for its data a
        // few seconds later, the navigation was lost — ask again. The linked
        // session is real at this point; losing the dialog would make the
        // orphan sweep delete it.
        let attempts = 0;
        const retry = () => {
            if (ctx.listOpened || ctx.pairFailed || attempts >= 3) return;
            attempts += 1;
            ctx.homey.app.log(`[Driver] ${ctx.id} - device list did not open, retry ${attempts}`);
            ctx.navigate(session, 'list_devices', 0);
            ctx.homey.setTimeout(retry, 5000);
        };
        ctx.homey.setTimeout(retry, 5000);
    }

    async onPair(session) {
        this.type = 'pair';
        this.device = null;
        this.resetPairState();

        this.stopCheckInterval(this);

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        const settings = device.getSettings();
        this.type = 'repair';
        this.device = device;
        this.phonenumber = settings.phonenumber;
        this.resetPairState();

        // Clear any running check interval from a previous pairing/repair
        this.stopCheckInterval(this);

        await device.removeWhatsappClient();

        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        const deviceObject = this.device && this.device.getData();

        this.guid = deviceObject ? deviceObject.id : `${this.homeyCloudId}_${GetGUID()}`;

        session.setHandler('showView', async (view) => {
            this.homey.app.log(`[Driver] ${this.id} - currentView:`, { view, type: this.type });

            if (view === 'whatsapp_consent') {
                const devices = this.getDevices();
                if (devices.length >= 2 && this.type === 'pair') {
                    session.showView('whatsapp_max');

                    return false;
                }
            }

            if (view === 'whatsapp_pairing_code') {
                this.homey.app.log(`[Driver] ${this.id} - pairing code view`, { client: clientTag(this.guid), hasCode: !!this.code });

                // Best-effort push. The view pulls via `get_pairing_code` as
                // soon as its script runs, which is the path we actually rely
                // on — this handler fires while the view is still loading, so
                // an emit here has nothing listening on the other end yet.
                if (this.code) session.emit('code', this.code);

                await this.setCheckInterval(this, session, this.guid);
            }

            if (view === 'loading') {
                this.resetPairState();

                await this.setWhatsappClient(this.guid, this.device); // don't send device during repair. we need a fresh client

                // forceNewSession: wipe /userdata/auth/<guid> before connecting.
                // Without it Baileys loads the existing creds.json, sees
                // `registered === true` and never calls requestPairingCode.
                await this.WhatsappClients[this.guid].addDevice(this.phonenumber, true);
                await this.setCheckInterval(this, session, this.guid);
            }

            if (view === 'loading2') {
                // Only arrive here with a linked session. The pairing-code view
                // unlocks its Continue button as soon as the code is on screen,
                // so a user can reach this view while WhatsApp is still waiting
                // for that code to be entered — and this handler would then tell
                // the device it was paired and show "done", leaving a device that
                // says "No response". Check the real state and send them back.
                // Continue after a failure: nothing to finish. Go back and keep
                // the real reason on screen instead of replacing it below.
                if (this.pairFailed) {
                    this.navigate(session, 'whatsapp_pairing_code');
                    return;
                }

                // The poll already finished this attempt and is navigating.
                if (this.pairFinished) return;

                const client = this.WhatsappClients[this.guid];
                const current = client ? await client.getData().catch(() => null) : null;

                if (!current || current.type !== 'READY') {
                    this.homey.app.log(`[Driver] ${this.id} - loading2 before the link completed`, {
                        client: clientTag(this.guid),
                        type: current ? current.type : 'none'
                    });

                    this.pairError = this.homey.__('pair.code_not_entered');
                    this.codeShown = false;

                    if (session) {
                        session.emit('pair_error', this.pairError);
                        this.navigate(session, 'whatsapp_pairing_code');
                    }

                    return;
                }

                await this.finishPairing(this, session);
            }
        });

        // The pairing-code view asks for the code itself once it is mounted.
        // session.emit() is fire-and-forget with no buffering, so any push that
        // happens before the view finished loading is silently lost; pulling
        // removes that race entirely.
        session.setHandler('get_pairing_code', async () => {
            return { code: this.code || null, error: this.pairError || null, failed: !!this.pairFailed };
        });

        session.setHandler('disconnect', async () => {
            this.homey.app.log(`[Driver] ${this.id} - pair session disconnected`);
            this.stopCheckInterval(this);

            // Capture the guid now: another pair session may reassign this.guid
            // before the sweep runs.
            const guid = this.guid;

            this.homey.setTimeout(() => {
                this.destroyOrphanedClient(guid).catch((error) =>
                    this.homey.app.error(`[Driver] ${this.id} - destroyOrphanedClient failed`, error)
                );
            }, ORPHAN_SWEEP_DELAY_MS);
        });

        session.setHandler('list_devices', async () => {
            this.listOpened = true;
            this.homey.app.log(`[Driver] ${this.id} - list_devices requested`, { count: (this.results || []).length });
            return this.results;
        });

        session.setHandler('set_phone', async ({ number }) => {
            const phoneNumber = parsePhoneNumberWithError(number);
            if (!phoneNumber.isValid()) {
                return false;
            }

            this.phonenumber = phoneNumber.number.replace('+', '');
            this.phonenumber = this.phonenumber.replace(' ', '');
            this.phonenumber = this.phonenumber.replace(' ', '');
            this.phonenumber = this.phonenumber.replace(' ', '');

            return true;
        });
    }
}
