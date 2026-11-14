import Homey from 'homey';
import { GetGUID, sleep, clientTag } from '../../lib/helpers/index.mjs';
import whatsappClient from '../../lib/com.whatsapp.api/index.mjs';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

// How long to wait after a pair session closes before deciding its client is
// an orphan. On a successful pair the device is created as the session ends,
// and it has to be registered before we can tell "abandoned" from "just paired".
const ORPHAN_SWEEP_DELAY_MS = 15000;

// How long Continue (loading2) and the device list wait for WhatsApp to
// confirm the link. The unregistered socket gives up on its own after ~3 min
// (QR refs exhausted -> auth_failure), which ends the wait earlier with the
// reason.
const LINK_WAIT_MS = 120000;

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
                    await ctx.finishPairing(ctx);
                    // Nothing to navigate: the pairing-code view sees `linked`
                    // on its next poll and moves on itself.
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
        this._finishing = null;
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

    // WhatsApp confirmed the link (READY). Build the result once, whichever of
    // the poll, the loading2 view or the device list gets here first. No
    // navigation here: a session.showView() from the driver is silently ignored
    // while the user is on the custom pairing-code view (report c4ef28a8: four
    // showView('list_devices') calls, no error, the list never opened). The
    // views move on themselves — see nextView() and the pairing-code view.
    async finishPairing(ctx) {
        if (ctx.pairFinished) return;
        if (ctx._finishing) return ctx._finishing;

        ctx._finishing = (async () => {
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

            if (ctx.type === 'repair' && ctx.device) {
                await ctx.device.setSettings({ phonenumber: ctx.phonenumber }).catch((error) =>
                    ctx.homey.app.error(`[Driver] ${ctx.id} - repair setSettings`, error)
                );
                await ctx.device.setWhatsappClient();
            }

            ctx.pairFinished = true;
        })();

        try {
            await ctx._finishing;
        } finally {
            ctx._finishing = null;
        }
    }

    nextView() {
        return this.type === 'repair' ? 'done' : 'list_devices';
    }

    // Wait until WhatsApp confirmed the link (true), the attempt failed
    // (throws with the reason) or the timeout passed (false). Used by the views
    // a user can reach before the link is done: Continue (loading2) and the
    // device list. Checks the client itself, so it works even when the poll
    // interval has stopped.
    async waitForLink(session, timeoutMs = LINK_WAIT_MS) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            if (this.pairFinished) return true;
            if (this.pairFailed) throw new Error(this.pairError || 'Pairing failed');

            const client = this.WhatsappClients[this.guid];
            const current = client ? await client.getData().catch(() => null) : null;

            if (current && current.type === 'READY') {
                await this.finishPairing(this);
                return true;
            }

            if (current && current.type === 'ERROR') {
                this.stopCheckInterval(this);
                this.failPairing(this, session, current.msg);
                throw new Error(this.pairError);
            }

            await sleep(1000);
        }

        return false;
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
                // Reached by pressing Continue on the pairing-code view —
                // possibly before WhatsApp confirmed the link, possibly after.
                // This is Homey's own spinner template, and from here a
                // driver-side showView does work, so wait for the link and move
                // on. Report c4ef28a8 ended here: the link was already done,
                // this handler returned without navigating, and the spinner
                // never stopped.
                if (this.pairFailed) {
                    this.navigate(session, 'whatsapp_pairing_code');
                    return;
                }

                this.homey.app.log(`[Driver] ${this.id} - loading2, waiting for the link`, { linked: !!this.pairFinished });

                let linked = false;
                try {
                    linked = await this.waitForLink(session);
                } catch (error) {
                    // failPairing already recorded the reason.
                    this.navigate(session, 'whatsapp_pairing_code');
                    return;
                }

                if (!linked) {
                    this.homey.app.log(`[Driver] ${this.id} - loading2 timed out waiting for the link`);
                    this.pairError = this.homey.__('pair.code_not_entered');
                    this.navigate(session, 'whatsapp_pairing_code');
                    return;
                }

                this.navigate(session, this.nextView());
            }
        });

        // The pairing-code view asks for the code itself once it is mounted.
        // session.emit() is fire-and-forget with no buffering, so any push that
        // happens before the view finished loading is silently lost; pulling
        // removes that race entirely.
        session.setHandler('get_pairing_code', async () => {
            return {
                code: this.code || null,
                error: this.pairError || null,
                failed: !!this.pairFailed,
                // The view navigates itself once this is true.
                linked: !!this.pairFinished,
                next: this.nextView()
            };
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
            this.homey.app.log(`[Driver] ${this.id} - list_devices requested`, { linked: !!this.pairFinished });

            // Safety net: if the list opens before the link is confirmed, wait
            // for it here — the template shows its own spinner meanwhile.
            const linked = await this.waitForLink(session);
            if (!linked) throw new Error(this.homey.__('pair.code_not_entered'));

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
