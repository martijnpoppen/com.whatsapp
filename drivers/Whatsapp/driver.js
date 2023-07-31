const Homey = require('homey');
const path = require("path");
const fs = require('fs-extra');
const { BaileysClass } = require("@bot-wa/bot-wa-baileys");

const { GetGUID, sleep } = require('../../lib/helpers');


module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
    }

    async onPair(session) {
        this.type = 'pair';
        this.device = null;

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        this.type = 'repair';
        this.device = device;

        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        this.consent = false;
        this.deviceObject = this.device && this.device.getData();
        this.guid = this.device ? this.deviceObject.id : GetGUID();

        if(this.type === 'repair') {
            this.device.removeWhatsappClient();

            this.homey.app.log(`[Driver] ${this.id} - REPAIR - remove all`);
            fs.rmSync(`${path.resolve(__dirname, '/userdata/')}/${this.guid}_sessions/creds.json`, { recursive: true, force: true })
            fs.rmSync(`${path.resolve(__dirname, '/userdata/')}/${this.guid}_sessions/baileys_store.json`, { recursive: true, force: true })

            await sleep(2000);
        }

        this.WhatsappClient = new BaileysClass({
            name: this.guid,
            dir: `${path.resolve(__dirname, '/userdata/')}/`,
            plugin: false
        });

        this.WhatsappClient.on("qr", (qr) => {
            this.homey.app.log(`[Driver] ${this.id} - got QR`, qr);

            this.qr = qr;

            if(this.consent) {
                session.showView('whatsapp_qr');
            }
        });

        this.WhatsappClient.once("ready", () => {
            this.homey.app.log(`[Driver] ${this.id} - ready`);

            session.showView('loading2');
        });

        session.setHandler('showView', async (view) => {
            this.homey.app.log(`[Driver] ${this.id} - currentView:`, { view, type: this.type });

            if (view === 'whatsapp_qr') {
                await session.emit('qr', this.qr);
            }

            if (view === 'loading') {
                this.consent = true;

                await sleep(3000);

                if(this.qr) {
                    session.showView('whatsapp_qr');
                }
            }

            if (view === 'loading2') {
                this.WhatsappClient.removeAllListeners();
                this.WhatsappClient = null;

                this.results = [{
                    name: `Whatsapp`,
                    data: {
                        id: this.guid
                    }
                }];
    
                this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

                if(this.results.length && this.type === 'repair') {
                    if(this.device) {
                        this.device.setWhatsappClient();
                    }
                    session.showView('done');
                } else {
                    session.showView('list_devices');
                }
            }
        });

        session.setHandler('list_devices', async () => {            
            return this.results;
        });
    }
};
