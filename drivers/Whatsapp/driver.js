const Homey = require('homey');
const path = require("path");
const { BaileysClass } = require("@bot-wa/bot-wa-baileys");
const { GetGUID } = require('../../lib/helpers');

module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
    }

    async onPair(session) {
        this.type = 'pair';
        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        this.type = 'repair';
        this.setPairingSession(session, device);
    }

    async setPairingSession(session, device = null) {
        this.consent = false;
        this.deviceObject = device && device.getData();
        this.guid = this.deviceObject ? this.deviceObject.id : GetGUID();

        this.WhatsappClient = new BaileysClass({
            name: this.guid,
            dir: `${path.resolve(__dirname, '../../userdata')}/`,
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
            if (view === 'whatsapp_qr') {
                await session.emit('qr', this.qr);
            }

            if (view === 'loading') {
                this.consent = true;

                if(this.qr) {
                    session.showView('whatsapp_qr');
                }
            }

            if (view === 'loading2') {
                this.WhatsappClient.removeAllListeners(['qr', 'ready']);
                this.WhatsappClient = null;

                this.results = [{
                    name: `Whatsapp`,
                    data: {
                        id: this.guid
                    }
                }];
    
                this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

                if(this.results.length && this.type === 'repair') {
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
